/** Durable Session ↔ CrowdTest run bindings, kept under the Harness home outside any workspace. */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { normalizeServerBaseUrl, type ManifestModel } from './bff.ts'
import { identityKey, type RunIdentity, type RunResources } from './run.ts'

export const RECLAIM_MESSAGE = '此会话的运行资源归属不明确，请从平台重新领取任务'

export interface RunBinding extends RunIdentity, RunResources {
  resourceStatus: 'ready' | 'reclaim-required' | 'creating'
  readonly claimNonce?: string
  workspaceConflict?: true
  readonly model: ManifestModel
  readonly backupFormat: string
  readonly backupMaxBytes: number
  lastUploadedSha256?: string
  lastUploadedAt?: number
  lastSyncedAtMs?: number
}

/** Default state file: `$DSH_HOME/crowdtest/runs.json`, falling back to `~/.dsh`. */
export function defaultStateFile(): string {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'crowdtest', 'runs.json')
}

async function workspaceKey(workspace: string): Promise<string | undefined> {
  const path = resolve(workspace)
  let ancestor = path
  for (;;) {
    try {
      const directory = await stat(ancestor, { bigint: true })
      return `${directory.dev}:${directory.ino}/${relative(ancestor, path)}`
    } catch (error) {
      const parent = dirname(ancestor)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === ancestor) return undefined
      ancestor = parent
    }
  }
}

export class RunBindings {
  private readonly bindings = new Map<string, RunBinding>()
  private readonly duplicateOwners: RunBinding[] = []
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    type SavedRun = Omit<RunBinding, 'provider' | 'resourceStatus'> & Partial<Pick<RunBinding, 'provider' | 'resourceStatus'>>
    const { runs } = JSON.parse(text) as { runs: SavedRun[] }
    const bySession = new Map<string, RunBinding>()
    const byCredential = new Map<string, RunBinding>()
    const byProvider = new Map<string, RunBinding>()
    const byWorkspace = new Map<string, RunBinding>()
    const blocked = new Set<string>()
    const sharedWorkspaces = new Set<string>()
    const rows: RunBinding[] = runs.map(row => ({
      ...row, serverBaseUrl: normalizeServerBaseUrl(row.serverBaseUrl),
      provider: row.provider ?? `crowdtest-run-${row.taskModelRunId}`,
      resourceStatus: row.resourceStatus ?? 'ready',
    }))
    for (const binding of rows) {
      const workspace = await workspaceKey(binding.workspace)
      if (workspace === undefined) sharedWorkspaces.add(binding.sessionId)
      else {
        const previous = byWorkspace.get(workspace)
        if (!previous) byWorkspace.set(workspace, binding)
        else if (identityKey(previous) !== identityKey(binding)) {
          sharedWorkspaces.add(binding.sessionId)
          sharedWorkspaces.add(previous.sessionId)
        }
      }
      for (const [index, key] of [[bySession, binding.sessionId], [byCredential, binding.credentialRef], [byProvider, binding.provider]] as const) {
        const previous = index.get(key)
        if (!previous) {
          index.set(key, binding)
        } else if (identityKey(previous) !== identityKey(binding)) {
          blocked.add(previous.sessionId)
          blocked.add(binding.sessionId)
        }
      }
    }
    for (const binding of rows) {
      if (sharedWorkspaces.has(binding.sessionId)) binding.workspaceConflict = true
      if (blocked.has(binding.sessionId) || binding.workspaceConflict) binding.resourceStatus = 'reclaim-required'
      const owner = bySession.get(binding.sessionId)!
      if (owner === binding) this.bindings.set(binding.sessionId, binding)
      else if (identityKey(owner) !== identityKey(binding)) this.duplicateOwners.push(binding)
    }
  }

  get(sessionId: string): RunBinding | undefined {
    return this.bindings.get(sessionId)
  }

  ownerForClaim(identity: RunIdentity): RunBinding | undefined {
    const saved = this.get(identity.sessionId)
    if (this.duplicateOwners.some(run => run.sessionId === identity.sessionId)) {
      throw new Error('此会话标识对应多个众测运行，请联系管理员核对归属后重新领取')
    }
    if (saved && identityKey(saved) !== identityKey(identity)) {
      throw new Error('此会话已绑定其他众测运行，无法领取')
    }
    return saved
  }

  put(binding: RunBinding): Promise<void> {
    this.writing = this.writing.catch(() => undefined).then(async () => {
      const next = new Map(this.bindings)
      const previous = next.get(binding.sessionId)
      if (previous && identityKey(previous) === identityKey(binding)) {
        binding.lastUploadedSha256 ??= previous.lastUploadedSha256
        binding.lastUploadedAt ??= previous.lastUploadedAt
        binding.lastSyncedAtMs ??= previous.lastSyncedAtMs
      }
      next.set(binding.sessionId, binding)
      await this.write([...next.values()])
      this.bindings.set(binding.sessionId, binding)
    })
    return this.writing
  }

  recordSuccessfulSync({ binding, confirmedAtMs, uploadedSha256, isCurrent }: {
    binding: RunBinding
    confirmedAtMs: number
    uploadedSha256?: string
    isCurrent: () => boolean
  }): Promise<boolean> {
    let recorded = false
    this.writing = this.writing.catch(() => undefined).then(async () => {
      if (!isCurrent()) return
      const confirmed = { ...binding, lastSyncedAtMs: confirmedAtMs,
        ...(uploadedSha256 === undefined ? {} : { lastUploadedSha256: uploadedSha256, lastUploadedAt: confirmedAtMs }) }
      await this.write([...this.bindings.values()].map(run => run === binding ? confirmed : run))
      if (!isCurrent()) {
        await this.write([...this.bindings.values()])
        return
      }
      Object.assign(binding, confirmed)
      recorded = true
    })
    return this.writing.then(() => recorded)
  }

  private async write(runs: RunBinding[]): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, runs: [...runs, ...this.duplicateOwners] }, null, 2)
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, snapshot, { mode: 0o600 })
    await rename(temporary, this.file)
  }
}
