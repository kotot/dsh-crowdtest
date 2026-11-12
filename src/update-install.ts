import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import gt from 'semver/functions/gt.js'
import valid from 'semver/functions/valid.js'
import * as z from 'zod/mini'
import { matchesInstalled, readRegularFile, verifyArchive, type Compatibility, type VerifiedArchive } from './update-archive.ts'
import { assetSchema, GitHubReleases, MAX_ARCHIVE, sameAsset, sha256, type ReleaseAsset } from './update-github.ts'
import { digest, PACKAGE, phase, requests, UpdateError, updateErrors, validated, versionText, type Phase, type UpdateMethod, type UpdateErrorCode, type UpdateStatus, type UpdateView } from './update-protocol.ts'

export interface NativeBundle {
  name: string; version?: string; source?: string; availability: string; installed: boolean
  enabled: boolean; removable: boolean; official: boolean; error?: unknown; readOnlyReason?: string
}
export interface NativeManager {
  listBundles(): Promise<readonly NativeBundle[]>
  installBundle(spec: string, options: { requestId: string; enabled: boolean }): Promise<{ application?: string; error?: unknown }>
}
export interface UpdatePlatform {
  readonly profile: string
  readonly running: string
  readonly manager: NativeManager
  readonly compatible: Compatibility
  readonly atomic: {
    withFileLock<T>(file: string, action: () => Promise<T>, options: { waitMs: number }): Promise<T>
    writeFileAtomic(file: string, content: string, options: { mode: number }): Promise<void>
  }
}
const installedProof = z.strictObject({ jobId: z.uuid(), role: z.enum(['target', 'previous']), version: versionText, hash: digest })
type InstalledProof = z.infer<typeof installedProof>
const proofField = { installedProof: z.optional(installedProof) }
const candidate = { candidateId: z.uuid(), asset: assetSchema, baseline: digest }
const job = { ...candidate, jobId: z.uuid(), previous: versionText, enabled: z.boolean(), previousHash: z.optional(digest) }
const code = z.enum(Object.keys(updateErrors) as [UpdateErrorCode, ...UpdateErrorCode[]])
const legacyCode = z.enum(['credential', 'credentialStore', 'credentialSaveUnconfirmed', 'credentialRemovalUnconfirmed'])
const storedCode = z.pipe(z.union([code, legacyCode]), z.transform(value => legacyCode.safeParse(value).success ? 'recheck' : validated(code, value)))
const receipt = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('checked'), ...candidate, ...proofField }),
  z.strictObject({ kind: z.literal('active'), ...job, ...proofField, phase, pid: z.int().check(z.positive()) }),
  z.strictObject({ kind: z.literal('installed'), ...job }),
  z.strictObject({ kind: z.literal('restored'), ...job, previousHash: digest }),
  z.strictObject({ kind: z.literal('recovery-needed'), ...job }),
  z.strictObject({ kind: z.literal('failed'), ...proofField, code: storedCode, latest: z.nullable(versionText) }),
])
type Receipt = z.infer<typeof receipt>
type Active = Extract<Receipt, { kind: 'active' }>
type Job = Extract<Receipt, { jobId: string }>
type Observation =
  | { kind: 'target' | 'previous'; source: string; selected: boolean; intact: boolean }
  | { kind: 'original' | 'independent'; intact: boolean }
  | { kind: 'unknown' }
type Installed = { version: string; source: string; directory: string; enabled: boolean }
const managed = (bundle: NativeBundle | undefined): bundle is NativeBundle => Boolean(bundle?.installed &&
  bundle.removable && !bundle.official && !bundle.readOnlyReason && (bundle.availability === 'profile' || bundle.availability === 'missing'))
const identity = (installed: Installed) => sha256(Buffer.from(JSON.stringify(installed)))
const errorCode = (error: unknown, fallback: UpdateErrorCode): UpdateErrorCode => error instanceof UpdateError ? error.code : fallback
const targetProof = (record: Job): InstalledProof => ({ jobId: record.jobId, role: 'target', version: record.asset.version, hash: record.asset.sha256 })
const previousProof = (record: Job, hash: string): InstalledProof => ({ jobId: record.jobId, role: 'previous', version: record.previous, hash })
function proofForCheck(record: Receipt | undefined, current: UpdateStatus): InstalledProof | undefined {
  if (record?.kind === 'installed' && current.kind === 'completed') return targetProof(record)
  if (record && 'jobId' in record && record.previousHash && current.kind === 'restored') return previousProof(record, record.previousHash)
  if (current.kind === 'idle' || current.kind === 'verify-install') return undefined
  return record && 'installedProof' in record ? record.installedProof : undefined
}
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const isPackageFile = (source: string) => source.startsWith('file:') && isAbsolute(source.slice(5)) && /\.(tgz|tar\.gz)$/i.test(source)
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH') }
}
export class PluginUpdater {
  private readonly directory: string
  private readonly file: string
  constructor(private readonly platform: UpdatePlatform, private readonly github = new GitHubReleases()) {
    this.directory = join(platform.profile, '.crowdtest-updater')
    this.file = join(this.directory, 'receipt.json')
  }
  private async read(): Promise<Receipt | undefined> {
    try {
      const data = JSON.parse((await readRegularFile(this.file, 16_384)).toString('utf8'))
      const result = receipt.safeParse(data)
      if (result.success) return result.data
    } catch (error) { if (missing(error)) return undefined }
    throw new UpdateError('state')
  }
  private write(value: Receipt) { return this.platform.atomic.writeFileAtomic(this.file, JSON.stringify(value), { mode: 0o600 }) }
  private async lock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    return this.platform.atomic.withFileLock(this.file, action, { waitMs: 300 })
  }
  private async bundle() { return (await this.platform.manager.listBundles()).find(bundle => bundle.name === PACKAGE) }
  private async directoryOfInstall() {
    const profile = await realpath(this.platform.profile)
    const directory = await realpath(join(profile, 'node_modules', PACKAGE))
    const inside = relative(join(profile, 'node_modules'), directory)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new UpdateError('unsupported')
    return directory
  }
  private identityOf(bundle: NativeBundle | undefined, directory: string): Installed {
    if (!managed(bundle) || bundle.availability !== 'profile' || bundle.error || !bundle.version || !valid(bundle.version) ||
      !bundle.source || !(isPackageFile(bundle.source) || bundle.source === `${PACKAGE}@${bundle.version}`)) throw new UpdateError('unsupported')
    return { version: bundle.version, source: bundle.source, enabled: bundle.enabled, directory }
  }
  private async installed(bundle: NativeBundle | undefined) {
    return this.identityOf(bundle, await this.directoryOfInstall())
  }
  private async active(record: Active) {
    try { return Number((await readRegularFile(this.file + '.lock', 32)).toString('utf8').trim()) === record.pid && pidAlive(record.pid) }
    catch { return false }
  }
  private archivePath(jobId: string, role: 'previous' | 'target', hash: string) {
    return join(this.directory, jobId, `${role}-${hash}.tgz`)
  }
  private async sameFile(source: string, path: string) {
    if (!isPackageFile(source)) return false
    if (source.slice(5) === path) return true
    try { return await realpath(source.slice(5)) === await realpath(path) } catch { return false }
  }
  private async intact(bundle: NativeBundle, path: string, version: string, hash?: string) {
    try {
      const installed = await this.installed(bundle)
      if (installed.version !== version) return false
      const bytes = await readRegularFile(path, MAX_ARCHIVE)
      if (hash && sha256(bytes) !== hash) return false
      return matchesInstalled(installed.directory, await verifyArchive(bytes, version, this.platform.compatible))
    } catch { return false }
  }
  private async observe(evidence: Job | InstalledProof, bundle: NativeBundle | undefined): Promise<Observation> {
    if (!managed(bundle) || !bundle.source) return { kind: 'unknown' }
    const source = bundle.source
    const selected = !('enabled' in evidence) || bundle.enabled === evidence.enabled
    const pins = 'role' in evidence ? [evidence] : [targetProof(evidence)]
    if ('previousHash' in evidence && evidence.previousHash) pins.push(previousProof(evidence, evidence.previousHash))
    for (const pin of pins) {
      const path = this.archivePath(pin.jobId, pin.role, pin.hash)
      if (await this.sameFile(source, path)) {
        return { kind: pin.role, source, selected, intact: await this.intact(bundle, path, pin.version, pin.hash) }
      }
    }
    try {
      const installed = await this.installed(bundle)
      if ('previousHash' in evidence && evidence.previousHash && identity(installed) === evidence.baseline) {
        const backup = this.archivePath(evidence.jobId, 'previous', evidence.previousHash)
        return { kind: 'original', intact: await this.intact(bundle, backup, evidence.previous, evidence.previousHash) }
      }
      return { kind: 'independent', intact: isPackageFile(source) && await this.intact(bundle, source.slice(5), installed.version) }
    } catch { return { kind: 'unknown' } }
  }
  private externalStatus(observation: Observation, bundle: NativeBundle | undefined, jobId: string): UpdateStatus {
    if ((observation.kind === 'original' || observation.kind === 'independent') && observation.intact) {
      return { kind: this.platform.running === bundle?.version ? 'idle' : 'restart-required' }
    }
    if (observation.kind === 'independent' && bundle?.version === this.platform.running) return { kind: 'verify-install' }
    return { kind: 'recovery-needed', jobId }
  }
  private async statusOfProof(pin: InstalledProof | undefined, bundle: NativeBundle | undefined) {
    if (!pin) return
    const observation = await this.observe(pin, bundle)
    if (observation.kind === pin.role && observation.intact) return
    return this.externalStatus(observation, bundle, pin.jobId)
  }
  private async status(record: Receipt | undefined, bundle: NativeBundle | undefined, lock: 'reader' | 'writer' = 'reader'): Promise<UpdateStatus> {
    if (record?.kind === 'active') {
      if (lock === 'reader' && await this.active(record)) return { kind: 'busy', phase: record.phase }
      if (record.phase !== 'installing' && record.phase !== 'restoring') {
        return await this.statusOfProof(record.installedProof, bundle) ?? { kind: 'failed', code: 'interrupted' }
      }
    }
    if (record && 'jobId' in record) {
      const observation = await this.observe(record, bundle)
      if (record.kind === 'installed' && observation.kind === 'target' && observation.intact) {
        return { kind: this.platform.running === record.asset.version ? 'completed' : 'restart-required' }
      }
      if (observation.kind === 'previous' && observation.intact && (observation.selected || record.kind === 'restored')) {
        return { kind: this.platform.running === record.previous ? 'restored' : 'restart-required' }
      }
      if (record.kind !== 'active') return this.externalStatus(observation, bundle, record.jobId)
      return { kind: 'recovery-needed', jobId: record.jobId }
    }
    const proofStatus = await this.statusOfProof(record?.installedProof, bundle)
    if (proofStatus) return proofStatus
    let installed: Installed
    try { installed = await this.installed(bundle) } catch { return { kind: 'failed', code: 'unsupported' } }
    if (this.platform.running !== installed.version) return { kind: 'restart-required' }
    if (!record) return { kind: 'idle' }
    if (record.kind === 'failed') return { kind: 'failed', code: record.code }
    if (identity(installed) !== record.baseline) return { kind: 'failed', code: 'changed' }
    return gt(record.asset.version, installed.version) ? { kind: 'available', candidateId: record.candidateId } : { kind: 'current' }
  }
  async inspect(): Promise<UpdateView> {
    const [record, bundle] = await Promise.all([this.read(), this.bundle()])
    return {
      runningVersion: this.platform.running, installedVersion: bundle?.version && valid(bundle.version) ? bundle.version : null,
      latestVersion: record ? record.kind === 'failed' ? record.latest : record.asset.version : null,
      status: await this.status(record, bundle),
    }
  }
  private blocked(status: UpdateStatus) {
    return status.kind === 'busy' || status.kind === 'restart-required' || status.kind === 'recovery-needed'
  }
  async check(): Promise<void> {
    const [record, bundle] = await Promise.all([this.read(), this.bundle()])
    const initial = await this.status(record, bundle)
    if (this.blocked(initial)) return
    let installed: Installed
    try { installed = await this.installed(bundle) } catch { return }
    const baseline = identity(installed)
    let checked: { kind: 'checked'; asset: ReleaseAsset } | { kind: 'failed'; code: UpdateErrorCode }
    let proof: VerifiedArchive | undefined
    try {
      if (initial.kind === 'verify-install') proof = await this.previous(installed)
      checked = { kind: 'checked', asset: await this.github.metadata() }
    } catch (error) { checked = { kind: 'failed', code: errorCode(error, 'network') } }

    const unchanged = (current: Receipt | undefined) => JSON.stringify(current) === JSON.stringify(record)
    if (!unchanged(await this.read())) return
    if (proof && !await matchesInstalled(installed.directory, proof)) throw new UpdateError('changed')
    try {
      await this.lock(async () => {
        if (!unchanged(await this.read())) return
        const currentBundle = await this.bundle()
        const current = await this.status(record, currentBundle, 'writer')
        if (this.blocked(current) || (current.kind === 'verify-install' && !proof && checked.kind === 'checked')) return
        const directory = await this.directoryOfInstall()
        if (identity(this.identityOf(await this.bundle(), directory)) !== baseline) return
        const installedProof = proofForCheck(record, current)
        if (checked.kind === 'failed') {
          if (current.kind === 'verify-install' || record && 'jobId' in record && !installedProof) throw new UpdateError(checked.code)
          await this.write({ ...checked, latest: null, installedProof })
          return
        }
        const { asset } = checked
        const existing = record?.kind === 'checked' && record.baseline === baseline && sameAsset(record.asset, asset) ? record : undefined
        if (existing && existing.installedProof === installedProof) return
        await this.write({ kind: 'checked', candidateId: existing?.candidateId ?? randomUUID(), asset, baseline, installedProof })
      })
    } catch (error) { if (unchanged(await this.read())) throw error }
  }
  async start(candidateId: string): Promise<void> {
    const before = await this.inspect()
    if (this.blocked(before.status)) return
    const accepted = Promise.withResolvers<void>()
    void this.lock(async () => {
      const record = await this.read()
      const bundle = await this.bundle()
      const status = await this.status(record, bundle, 'writer')
      if (this.blocked(status)) { accepted.resolve(); return }
      if (record?.kind !== 'checked' || status.kind !== 'available' || record.candidateId !== candidateId) throw new UpdateError('changed')
      const previous = await this.installed(bundle)
      const active: Active = { ...record, kind: 'active', jobId: randomUUID(), previous: previous.version, enabled: previous.enabled, pid: process.pid, phase: 'checking' }
      await this.write(active)
      accepted.resolve()
      await this.run(active, previous)
    }).then(() => accepted.resolve(), async error => {
      try {
        const current = await this.inspect()
        if (current.status.kind === 'busy') { accepted.resolve(); return }
      } catch {}
      accepted.reject(error instanceof UpdateError ? error : new UpdateError('state'))
    })
    await accepted.promise
  }
  private async previous(installed: Installed) {
    if (isPackageFile(installed.source)) {
      try {
        const bytes = await readRegularFile(installed.source.slice(5), MAX_ARCHIVE)
        const archive = await verifyArchive(bytes, installed.version, this.platform.compatible)
        if (await matchesInstalled(installed.directory, archive)) return archive
      } catch {}
    }
    try {
      const release = await this.github.metadata(installed.version)
      const archive = await verifyArchive(await this.github.download(release), installed.version, this.platform.compatible)
      if (await matchesInstalled(installed.directory, archive)) return archive
    } catch {}
    throw new UpdateError('rollback')
  }
  private async install(path: string, enabled: boolean): Promise<void> {
    const result = await this.platform.manager.installBundle(path, { requestId: randomUUID(), enabled })
    if (result.error || (result.application !== 'applied' && result.application !== 'restart-required')) throw new UpdateError('install')
  }
  private async run(job: Active, old: Installed): Promise<void> {
    const { jobId, asset } = job
    let previousHash: string | undefined
    const advance = (phase: Phase) => this.write({ ...job, phase, previousHash })
    const terminal = { candidateId: job.candidateId, asset, baseline: job.baseline, jobId, previous: old.version, enabled: old.enabled }
    let attemptedInstall = false
    try {
      if (!sameAsset(asset, await this.github.metadata())) throw new UpdateError('changed')
      await advance('downloading')
      const bytes = await this.github.download(asset)
      await advance('validating')
      const target = await verifyArchive(bytes, asset.version, this.platform.compatible)
      await advance('backup')
      const backup = await this.previous(old)
      const dir = join(this.directory, jobId)
      await mkdir(dir, { mode: 0o700 })
      const nextPath = join(dir, `target-${asset.sha256}.tgz`)
      previousHash = sha256(backup.bytes)
      if (job.installedProof && previousHash !== job.installedProof.hash) throw new UpdateError('changed')
      const prevPath = join(dir, `previous-${previousHash}.tgz`)
      await writeFile(nextPath, target.bytes, { mode: 0o400, flag: 'wx' })
      await writeFile(prevPath, backup.bytes, { mode: 0o400, flag: 'wx' })
      await advance('installing')
      if (!await matchesInstalled(old.directory, backup)) throw new UpdateError('changed')
      const directory = await this.directoryOfInstall()
      const before = this.identityOf(await this.bundle(), directory)
      if (identity(before) !== job.baseline) throw new UpdateError('changed')
      attemptedInstall = true
      const stagedJob = { ...job, previousHash }
      try {
        await this.install(nextPath, old.enabled)
        const current = await this.observe(stagedJob, await this.bundle())
        if (current.kind !== 'target' || !current.intact) throw new UpdateError('install')
      } catch {
        await advance('restoring')
        const current = await this.observe(stagedJob, await this.bundle())
        if (current.kind === 'original' && current.intact) {
          await this.write({ kind: 'failed', code: 'install', latest: asset.version, installedProof: job.installedProof })
          return
        }
        if (current.kind !== 'target' || !current.selected) throw new UpdateError('changed')
        const previousBytes = await readRegularFile(prevPath, MAX_ARCHIVE)
        if (sha256(previousBytes) !== previousHash) throw new UpdateError('rollback')
        const last = await this.bundle()
        if (!managed(last) || last.source !== current.source || last.enabled !== old.enabled) throw new UpdateError('changed')
        await this.install(prevPath, old.enabled)
        const restored = await this.observe(stagedJob, await this.bundle())
        if (restored.kind !== 'previous' || !restored.intact || !restored.selected) throw new UpdateError('install')
        await this.write({ kind: 'restored', previousHash, ...terminal }); return
      }
      await this.write({ kind: 'installed', previousHash, ...terminal })
    } catch (error) {
      if (attemptedInstall) await this.write({ kind: 'recovery-needed', previousHash, ...terminal })
      else await this.write({ kind: 'failed', code: errorCode(error, 'state'), latest: asset.version, installedProof: job.installedProof })
    }
  }
}

export async function dispatchUpdate(principal: unknown, method: UpdateMethod, input: unknown, get: () => Promise<PluginUpdater>): Promise<UpdateView> {
  if (principal !== undefined) throw new Error('CrowdTest 更新仅限所有者')
  const request = validated(requests[method], input)
  try {
    const updater = await get()
    try {
      switch (method) {
        case 'inspect': break
        case 'check': await updater.check(); break
        case 'start': await updater.start(validated(requests.start, request).candidateId); break
      }
    } catch (error) {
      const view = await updater.inspect()
      const code = errorCode(error, 'state')
      return { ...view, actionError: code, status: { kind: 'failed', code } }
    }
    return await updater.inspect()
  } catch {
    throw new Error('CrowdTest 更新服务暂时不可用')
  }
}
