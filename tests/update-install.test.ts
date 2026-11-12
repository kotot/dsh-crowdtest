import { writeFileSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { GitHubReleases } from '../src/update-github.ts'
import { dispatchUpdate, PluginUpdater, type NativeBundle, type UpdatePlatform } from '../src/update-install.ts'
import { updateErrors, type UpdateView } from '../src/update-protocol.ts'
import { payload } from './update-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { force: true, recursive: true }))) })
const previous = payload('0.2.15')
const next = payload('0.2.16')
const secret = 'synthetic-fixture-token'
async function fixture(target = next, compatible: UpdatePlatform['compatible'] = () => true) {
  const profile = await mkdtemp(join(tmpdir(), 'crowdtest-updater-test-'))
  roots.push(profile)
  const directory = join(profile, 'node_modules', 'dsh-crowdtest')
  await mkdir(join(directory, 'lib'), { recursive: true })
  const deploy = async (release: typeof next) => {
    await Promise.all(Object.entries(release.files).map(([path, value]) => writeFile(join(directory, path), value)))
  }
  const previousPath = join(profile, 'previous-install.tgz')
  await writeFile(previousPath, previous.bytes)
  await deploy(previous)
  const bundle: NativeBundle = { name: 'dsh-crowdtest', installed: true, removable: true, availability: 'profile',
    official: false, enabled: true, version: previous.asset.version, source: 'file:' + previousPath }
  const install = vi.fn(async (file: string, options: { requestId: string; enabled: boolean }) => {
    const bytes = await readFile(file)
    const release = bytes.equals(target.bytes) ? target : previous
    await deploy(release)
    Object.assign(bundle, { source: 'file:' + file, enabled: options.enabled, version: release.asset.version })
    return { application: 'applied' }
  })
  const platform: UpdatePlatform = {
    profile, running: previous.asset.version, compatible, manager: { listBundles: async () => [bundle], installBundle: install },
    atomic: {
      withFileLock: async (file, action, options) => {
        const until = Date.now() + options.waitMs
        for (;;) {
          try { await writeFile(file + '.lock', String(process.pid), { flag: 'wx', mode: 0o600 }); break }
          catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST') || Date.now() >= until) throw error
            await delay(10)
          }
        }
        try { return await action() } finally { await rm(file + '.lock') }
      },
      writeFileAtomic: async (file, body, options) => { await writeFile(file + '.tmp', body, options); await rename(file + '.tmp', file) },
    },
  }
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(new Headers(init?.headers).has('cookie')).toBe(false)
    expect(init?.credentials).toBe('omit')
    if (String(url).endsWith('/latest')) return Response.json(target.release)
    if (String(url).endsWith('/tags/v0.2.15')) return Response.json(previous.release)
    return new Response(target.bytes)
  })
  const github = new GitHubReleases(transport)
  const create = (running = previous.asset.version) => new PluginUpdater({ ...platform, running }, github)
  const updater = create()
  const checked = async () => {
    await updater.check()
    const status = (await updater.inspect()).status
    if (status.kind !== 'available') throw new Error('missing update candidate')
    return status.candidateId
  }
  return { updater, profile, platform, create, checked, transport, bundle, deploy, directory, previousPath, install }
}
async function settled(updater: PluginUpdater): Promise<UpdateView> {
  return vi.waitFor(async () => {
    const view = await updater.inspect()
    expect(view.status.kind).not.toBe('busy')
    return view
  })
}
it('checks public releases without a credential service and keeps journals private', async () => {
  const { updater, profile, transport, platform } = await fixture()
  expect(platform).not.toHaveProperty('credentials')
  await updater.check()
  expect((await updater.inspect()).status.kind).toBe('available')
  expect(transport).toHaveBeenCalledTimes(1)
  const journal = join(profile, '.crowdtest-updater', 'receipt.json')
  expect(await readFile(journal, 'utf8')).not.toContain(secret)
  expect(await updater.inspect()).not.toHaveProperty('configured')
  expect((await stat(journal)).mode & 0o777).toBe(0o600)
})
it.each(['0.2.15', '0.2.9'])('handles same/older %s without offering install', async version => {
  const { updater, transport, install } = await fixture()
  transport.mockResolvedValueOnce(Response.json(payload(version).release))
  await updater.check()
  expect((await updater.inspect()).status).toEqual({ kind: 'current' })
  expect(install).not.toHaveBeenCalled()
})
it('revalidates a candidate before mutation and rejects a stale pin', async () => {
  const { checked, updater, transport, install } = await fixture()
  const id = await checked()
  transport.mockResolvedValueOnce(Response.json({ ...next.release, id: 99 }))
  await updater.start(id)
  expect((await settled(updater)).status).toEqual({ kind: 'failed', code: 'changed' })
  expect(install).not.toHaveBeenCalled()
})
it('supports reconnection and concurrent starts across generations and distinguishes disk install from restart activation', async () => {
  const { checked, updater, create, install, platform, profile, directory } = await fixture()
  const id = await checked()
  const gate = Promise.withResolvers<void>()
  const apply = install.getMockImplementation()!
  install.mockImplementationOnce(async (...args) => { await gate.promise; return apply(...args) })
  await Promise.all([updater.start(id), create().start(id)])
  await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1))
  expect((await create().inspect()).status).toEqual({ kind: 'busy', phase: 'installing' })
  await create().start(id)
  gate.resolve()
  const installed = await settled(updater)
  expect(installed).toMatchObject({ runningVersion: '0.2.15', installedVersion: '0.2.16', status: { kind: 'restart-required' } })
  expect(install).toHaveBeenCalledTimes(1)
  const [archive, options] = install.mock.calls[0]!
  expect(archive.startsWith(join(profile, '.crowdtest-updater') + '/')).toBe(true)
  expect(Object.keys(options).sort()).toEqual(['enabled', 'requestId'])
  expect((await stat(archive)).mode & 0o777).toBe(0o400)
  const restarted = create('0.2.16')
  expect((await restarted.inspect()).status).toEqual({ kind: 'completed' })
  await writeFile(join(directory, 'lib/index.js'), 'changed even though version stayed the same')
  expect((await restarted.inspect()).status.kind).toBe('recovery-needed')
  expect(platform.manager.installBundle).toHaveBeenCalledTimes(1)
})
it('refuses development links and foreign or protected bundles without networking or mutation', async () => {
  for (const change of [{ source: 'link:/development' }, { availability: 'installation' }, { removable: false }, { readOnlyReason: 'protected' }]) {
    const { updater, bundle, install, transport } = await fixture()
    Object.assign(bundle, change)
    await updater.check()
    expect((await updater.inspect()).status).toEqual({ kind: 'failed', code: 'unsupported' })
    expect(install).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled()
  }
})
it('refuses a rollback that differs from installed bytes even when its archive is well formed', async () => {
  const { updater, checked, install, directory } = await fixture()
  const id = await checked()
  await writeFile(join(directory, 'README.md'), 'external edit')
  await updater.start(id)
  expect((await settled(updater)).status).toEqual({ kind: 'failed', code: 'rollback' })
  expect(install).not.toHaveBeenCalled()
})
it('retrieves an exact rollback tag when the original local tarball disappeared', async () => {
  const { updater, checked, previousPath, transport, install } = await fixture()
  const id = await checked()
  await rm(previousPath)
  transport.mockResolvedValueOnce(Response.json(next.release)).mockResolvedValueOnce(new Response(next.bytes))
    .mockResolvedValueOnce(Response.json(previous.release)).mockResolvedValueOnce(new Response(previous.bytes))
  await updater.start(id)
  expect((await settled(updater)).status.kind).toBe('restart-required')
  expect(transport.mock.calls.some(([url]) => String(url).endsWith('/tags/v0.2.15'))).toBe(true)
  expect(install).toHaveBeenCalledTimes(1)
})
it.each(['failed', 'cancelled', 'throw', 'bad-installed-bytes'])('verifies restoration after native %s', async mode => {
  const { updater, checked, install, bundle, directory } = await fixture()
  const id = await checked()
  const apply = install.getMockImplementation()!
  install.mockImplementationOnce(async (...args) => {
    await apply(...args)
    if (mode === 'throw') throw Error(secret)
    if (mode === 'bad-installed-bytes') { await writeFile(join(directory, 'README.md'), 'partial'); return { application: 'applied' } }
    return { application: mode }
  })
  await updater.start(id)
  expect((await settled(updater)).status.kind).toBe('restored')
  expect(bundle).toMatchObject({ version: '0.2.15', enabled: true })
  expect(install).toHaveBeenCalledTimes(2)
  expect(install.mock.calls[1]![0]).not.toBe(install.mock.calls[0]![0])
})
it('reports recovery-needed when restoration fails, or an unrelated installation wins', async () => {
  for (const other of [false, true]) {
    const { updater, checked, install, bundle } = await fixture()
    const id = await checked()
    const nativeInstall = install.getMockImplementation()!
    install.mockImplementationOnce(async (...args) => {
      if (!other) await nativeInstall(...args)
      if (other) { bundle.version = '0.3.0'; bundle.source = 'file:/other.tgz' }
      return { application: 'failed' }
    }).mockRejectedValueOnce(Error(secret))
    await updater.start(id)
    const view = await settled(updater)
    expect(view.status.kind).toBe('recovery-needed')
    expect(JSON.stringify(view)).not.toContain(secret)
    expect(install).toHaveBeenCalledTimes(other ? 1 : 2)
    if (!other) {
      const rollback = install.mock.calls[1]![0]
      await install(rollback, { enabled: true, requestId: 'manual-recovery' })
      expect((await updater.inspect()).status).toEqual({ kind: 'restored' })
      await updater.check()
      expect((await updater.inspect()).status.kind).toBe('available')
    }
  }
})
it.each(['recovery-needed', 'restart-required'] as const)('returns %s in the same inspect response when the install finishes during bundle lookup', async outcome => {
  const { updater, checked, install, bundle, profile, platform, transport } = await fixture()
  const id = await checked()
  if (outcome === 'recovery-needed') {
    const apply = install.getMockImplementation()!
    install.mockImplementationOnce(async (...args) => { await apply(...args); return { application: 'failed' } })
      .mockRejectedValueOnce(Error(secret))
  }
  const resumeInstall = Promise.withResolvers<void>()
  const metadata = transport.getMockImplementation()!
  transport.mockImplementationOnce(async (...args) => { await resumeInstall.promise; return metadata(...args) })
  const lock = platform.atomic.withFileLock
  const unlocked = Promise.withResolvers<void>()
  platform.atomic.withFileLock = async (...args) => {
    try { return await lock(...args) } finally { unlocked.resolve() }
  }
  await updater.start(id)
  vi.spyOn(platform.manager, 'listBundles').mockImplementationOnce(async () => {
    const snapshot = { ...bundle }
    resumeInstall.resolve()
    await unlocked.promise
    return [snapshot]
  })
  const view = await dispatchUpdate(undefined, 'inspect', {}, async () => updater)
  const { jobId } = JSON.parse(await readFile(join(profile, '.crowdtest-updater', 'receipt.json'), 'utf8'))
  expect(view).toEqual({
    runningVersion: previous.asset.version, installedVersion: next.asset.version, latestVersion: next.asset.version,
    status: outcome === 'recovery-needed' ? { kind: outcome, jobId } : { kind: outcome },
  })
  expect(install).toHaveBeenCalledTimes(outcome === 'recovery-needed' ? 2 : 1)
})

it('bounds retries when the receipt keeps changing during proof verification and recovers on the next inspect', async () => {
  const compatible = vi.fn(() => true)
  const { updater, checked, profile } = await fixture(next, compatible)
  await updater.start(await checked())
  expect((await settled(updater)).status.kind).toBe('restart-required')
  const path = join(profile, '.crowdtest-updater', 'receipt.json')
  const installed = JSON.parse(await readFile(path, 'utf8'))
  let changes = 0
  compatible.mockImplementation(() => {
    const kind = ++changes % 2 ? 'recovery-needed' : 'installed'
    writeFileSync(path, JSON.stringify({ ...installed, kind }))
    return true
  })
  await expect(updater.inspect()).rejects.toMatchObject({ code: 'state' })
  expect(changes).toBe(3)
  compatible.mockImplementation(() => true)
  expect((await updater.inspect()).status).toEqual({ kind: 'recovery-needed', jobId: installed.jobId })
})

it.each(['preflight', 'lock contention'])('keeps polling available when a second window encounters three install phase changes during %s', async stage => {
  const { updater, checked, create, platform, bundle, install, transport } = await fixture()
  const request = { candidateId: await checked() }
  const secondWindow = create()
  const checking = Promise.withResolvers<void>()
  const metadata = transport.getMockImplementation()!
  transport.mockImplementationOnce(async (...args) => { await checking.promise; return metadata(...args) })
  const gates = ['downloading', 'validating', 'backup'].map(phase => ({
    phase, entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>(),
  }))
  const write = platform.atomic.writeFileAtomic
  platform.atomic.writeFileAtomic = async (file, body, options) => {
    await write(file, body, options)
    const phase = JSON.parse(body).phase
    const gate = gates.find(gate => gate.phase === phase)
    if (gate) { gate.entered.resolve(); await gate.resume.promise }
  }
  const startInSecondWindow = () => dispatchUpdate(undefined, 'start', request, async () => secondWindow)
  const contend = Promise.withResolvers<void>()
  let pending: Promise<UpdateView> | undefined
  if (stage === 'lock contention') {
    const lock = platform.atomic.withFileLock
    const requested = Promise.withResolvers<void>()
    platform.atomic.withFileLock = async (file, action) => {
      platform.atomic.withFileLock = lock
      requested.resolve()
      await contend.promise
      return lock(file, action, { waitMs: 0 })
    }
    pending = startInSecondWindow()
    await requested.promise
  }
  try {
    const first = await dispatchUpdate(undefined, 'start', request, async () => updater)
    expect(first.status).toEqual({ kind: 'busy', phase: 'checking' })
    const list = vi.spyOn(platform.manager, 'listBundles')
    let resume = checking.resolve
    for (const gate of gates) {
      const advance = resume
      list.mockImplementationOnce(async () => { advance(); await gate.entered.promise; return [bundle] })
      resume = gate.resume.resolve
    }
    contend.resolve()
    await expect(pending ?? startInSecondWindow()).rejects.toThrow('CrowdTest 更新服务暂时不可用')
    const nextPoll = await dispatchUpdate(undefined, 'inspect', {}, async () => secondWindow)
    expect(nextPoll.status).toEqual({ kind: 'busy', phase: 'backup' })
  } finally {
    contend.resolve()
    checking.resolve()
    for (const gate of gates) gate.resume.resolve()
    expect((await settled(updater)).status.kind).toBe('restart-required')
  }
  expect(install).toHaveBeenCalledTimes(1)
})

it('refuses corrupted durable state without invoking the native installer', async () => {
  const { updater, profile, checked, install } = await fixture()
  const id = await checked()
  await writeFile(join(profile, '.crowdtest-updater', 'receipt.json'), JSON.stringify({ kind: 'active', jobId: '../elsewhere', token: secret }))
  await expect(updater.start(id)).rejects.toMatchObject({ code: 'state' })
  expect(install).not.toHaveBeenCalled()
})

it('leaves an interrupted mutation for explicit recovery and permits checking again after interrupted preparation', async () => {
  const { updater, profile, checked, install } = await fixture()
  const candidateId = await checked()
  const path = join(profile, '.crowdtest-updater', 'receipt.json')
  const record = JSON.parse(await readFile(path, 'utf8'))
  const active = { ...record, kind: 'active', jobId: '377abf79-5158-4228-844d-e9b908cdb544', pid: process.pid, previous: '0.2.15', enabled: true }
  await writeFile(path, JSON.stringify({ ...active, phase: 'installing' }))
  expect((await updater.inspect()).status).toEqual({ kind: 'recovery-needed', jobId: active.jobId })
  await updater.start(candidateId); await updater.check()
  expect(install).not.toHaveBeenCalled()
  expect((await updater.inspect()).status.kind).toBe('recovery-needed')
  await writeFile(path, JSON.stringify({ ...active, phase: 'downloading' }))
  expect((await updater.inspect()).status).toEqual({ kind: 'failed', code: 'interrupted' })
  await updater.check()
  expect((await updater.inspect()).status.kind).toBe('available')
})

it.each(['0.2.16', '0.2.17'])('allows a fresh check after a healthy independent %s installation', async version => {
  const { updater, checked, create, deploy, bundle, profile, transport } = await fixture()
  await updater.start(await checked())
  expect((await settled(updater)).status.kind).toBe('restart-required')
  expect((await create('0.2.16').inspect()).status.kind).toBe('completed')
  const independent = payload(version)
  const path = join(profile, 'manual-install.tgz')
  await writeFile(path, independent.bytes)
  await deploy(independent)
  Object.assign(bundle, { version, source: 'file:' + path })
  const current = create(version)
  const count = transport.mock.calls.length
  await current.check()
  expect(transport.mock.calls).toHaveLength(count + 1)
  expect((await current.inspect()).status.kind).toBe('current')
})

it('leaves the verified original in place and permits retry after a native refusal', async () => {
  const { updater, install, checked, previousPath, bundle } = await fixture()
  install.mockRejectedValue(Error('native package lock unavailable'))
  await updater.start(await checked())
  expect((await settled(updater)).status).toEqual({ kind: 'failed', code: 'install' })
  expect(bundle).toMatchObject({ version: '0.2.15', enabled: true, source: 'file:' + previousPath })
  expect(install).toHaveBeenCalledTimes(1)
  await updater.check()
  expect((await updater.inspect()).status.kind).toBe('available')
})

it('preserves an independent disable after native installation', async () => {
  const { updater, install, checked, bundle } = await fixture()
  const apply = install.getMockImplementation()!
  install.mockImplementationOnce(async (...args) => {
    const result = await apply(...args)
    bundle.enabled = false
    return result
  })
  await updater.start(await checked())
  await settled(updater)
  expect(bundle).toMatchObject({ version: '0.2.16', enabled: false })
  expect(install).toHaveBeenCalledTimes(1)
})

it('checks the installed identity after persisting the installing phase', async () => {
  const { updater, install, checked, platform, deploy, bundle, profile } = await fixture()
  const external = payload('0.2.17')
  const write = platform.atomic.writeFileAtomic
  platform.atomic.writeFileAtomic = async (file, body, options) => {
    await write(file, body, options)
    if (JSON.parse(body).phase !== 'installing') return
    const path = join(profile, 'external.tgz')
    await writeFile(path, external.bytes)
    await deploy(external)
    Object.assign(bundle, { version: external.asset.version, source: 'file:' + path })
  }
  await updater.start(await checked())
  await settled(updater)
  expect(bundle.version).toBe('0.2.17')
  expect(install).not.toHaveBeenCalled()
})

it('rejects a platform-excluded target before a native mutation', async () => {
  const target = payload('0.2.16', ['linux'])
  const { updater, install, checked } = await fixture(target, manifest => {
    const platforms = manifest.dsh.bundle.platforms
    return platforms === undefined || Array.isArray(platforms) && platforms.includes('darwin')
  })
  await updater.start(await checked())
  expect((await settled(updater)).status).toEqual({ kind: 'failed', code: 'compatibility' })
  expect(install).not.toHaveBeenCalled()
})

it('repairs its own failed target even when native inventory reports a package error', async () => {
  const { updater, install, checked, bundle } = await fixture()
  const apply = install.getMockImplementation()!
  install.mockImplementationOnce(async (...args) => {
    await apply(...args)
    bundle.error = { code: 'not-bundle' }
    delete bundle.version
    return { application: 'failed' }
  }).mockImplementationOnce(async (...args) => {
    delete bundle.error
    return apply(...args)
  })
  await updater.start(await checked())
  expect((await settled(updater)).status.kind).toBe('restored')
  expect(install).toHaveBeenCalledTimes(2)
})

it('preserves a visible candidate when another window checks the same release and baseline', async () => {
  const { updater, checked, create, install } = await fixture()
  const first = await checked()
  await create().check()
  expect((await updater.inspect()).status).toEqual({ kind: 'available', candidateId: first })
  await updater.start(first)
  expect((await settled(updater)).status.kind).toBe('restart-required')
  expect(install).toHaveBeenCalledTimes(1)
})

it('preserves the installed payload pin after checking an unchanged release on restart', async () => {
  const { updater, checked, create, directory, transport } = await fixture()
  await updater.start(await checked())
  await settled(updater)
  const current = create(next.asset.version)
  await current.check()
  await writeFile(join(directory, 'lib/client.js'), 'changed after check')
  const count = transport.mock.calls.length
  await current.check()
  expect(transport.mock.calls).toHaveLength(count)
  expect((await current.inspect()).status.kind).toBe('recovery-needed')
})

it.each([true, false])('requires the exact tag to match a manual installation after removing its archive (matches=%s)', async matches => {
  const { updater, checked, create, deploy, bundle, profile, transport, directory } = await fixture()
  await updater.start(await checked())
  await settled(updater)
  const manual = payload('0.2.17')
  const latest = payload('0.2.18')
  await deploy(manual)
  Object.assign(bundle, { version: manual.asset.version, source: 'file:' + join(profile, 'removed-download.tgz') })
  transport.mockImplementation(async url => {
    if (String(url).endsWith('/latest')) return Response.json(latest.release)
    if (String(url).endsWith('/tags/v0.2.17')) return Response.json(manual.release)
    return new Response(manual.bytes)
  })
  const current = create(manual.asset.version)
  const count = transport.mock.calls.length
  if (!matches) {
    await writeFile(join(directory, 'lib/client.js'), 'manual edit')
    const view = await dispatchUpdate(undefined, 'check', {}, async () => current)
    expect(view.actionError).toBe('rollback')
    expect((await current.inspect()).status.kind).toBe('verify-install')
    expect(transport.mock.calls.slice(count).map(([url]) => String(url).split('/').at(-1))).toEqual(['v0.2.17', '22'])
    return
  }
  await current.check()
  expect(transport.mock.calls.slice(count).map(([url]) => String(url).split('/').at(-1))).toEqual(['v0.2.17', '22', 'latest'])
  expect((await current.inspect()).status.kind).toBe('available')
})

it('accepts a checked candidate while another window is waiting for GitHub metadata', async () => {
  const { updater, checked, create, transport, install } = await fixture()
  const candidateId = await checked()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const resumeInstall = Promise.withResolvers<void>()
  transport.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return Response.json(next.release) })
    .mockImplementationOnce(async () => { await resumeInstall.promise; return Response.json(next.release) })
  const checking = updater.check()
  await entered.promise
  try {
    const other = create()
    const view = await dispatchUpdate(undefined, 'start', { candidateId }, async () => other)
    expect(view.status.kind).toBe('busy')
    resumeInstall.resolve()
    expect((await settled(other)).status.kind).toBe('restart-required')
  } finally { resumeInstall.resolve(); release.resolve(); await checking }
  expect((await updater.inspect()).status.kind).toBe('restart-required')
  expect(install).toHaveBeenCalledTimes(1)
})

it('rechecks eligibility after an unsupported installation is replaced by the original release', async () => {
  const { updater, checked, platform, bundle, previousPath, transport, create, install } = await fixture()
  const write = platform.atomic.writeFileAtomic
  platform.atomic.writeFileAtomic = async (file, body, options) => {
    await write(file, body, options)
    if (JSON.parse(body).phase === 'installing') bundle.source = 'link:/development'
  }
  await updater.start(await checked())
  expect((await settled(updater)).status).toEqual({ kind: 'failed', code: 'unsupported' })
  expect(install).not.toHaveBeenCalled()
  const count = transport.mock.calls.length
  await create().check()
  expect(transport.mock.calls).toHaveLength(count)
  bundle.source = 'file:' + previousPath
  const reopened = create()
  expect((await reopened.inspect()).status).toEqual({ kind: 'failed', code: 'unsupported' })
  await reopened.check()
  expect(transport.mock.calls).toHaveLength(count + 1)
  expect((await reopened.inspect()).status.kind).toBe('available')
})

it.each(['older', 'newer', 'error'])('retains installed proof when the release check returns %s', async outcome => {
  const { updater, checked, create, transport, directory, install } = await fixture()
  await updater.start(await checked())
  await settled(updater)
  const current = create('0.2.16')
  transport.mockResolvedValueOnce(Response.json(payload(outcome === 'older' ? '0.2.15' : '0.2.17').release))
  await current.check()
  let view = await current.inspect()
  const offer = view.status.kind === 'available' ? view.status.candidateId : undefined
  if (outcome === 'error') {
    transport.mockResolvedValueOnce(new Response('fixture', { status: 503 }))
    await dispatchUpdate(undefined, 'check', {}, async () => current)
    view = await current.inspect()
  }
  expect(view.status.kind).toBe({ older: 'current', newer: 'available', error: 'failed' }[outcome])
  await writeFile(join(directory, 'lib/client.js'), 'edited after checking latest')
  const count = transport.mock.calls.length
  const reopened = create('0.2.16')
  if (offer) await reopened.start(offer)
  expect((await reopened.inspect()).status.kind).toBe('recovery-needed')
  expect(transport.mock.calls).toHaveLength(count)
  expect(install).toHaveBeenCalledTimes(1)
})

it.each(['credential', 'credentialStore', 'credentialSaveUnconfirmed', 'credentialRemovalUnconfirmed'])('rechecks a strict legacy %s receipt without rewriting it during inspection', async code => {
  const { updater, profile, checked, transport } = await fixture()
  await checked()
  const path = join(profile, '.crowdtest-updater', 'receipt.json')
  const stored = JSON.stringify({ kind: 'failed', code, latest: '0.2.16' })
  await writeFile(path, stored)
  expect(await updater.inspect()).toMatchObject({ latestVersion: '0.2.16', status: { kind: 'failed', code: 'recheck' } })
  expect(await readFile(path, 'utf8')).toBe(stored)
  const count = transport.mock.calls.length
  await updater.check()
  expect(transport.mock.calls).toHaveLength(count + 1)
  expect((await updater.inspect()).status.kind).toBe('available')
  expect(JSON.parse(await readFile(path, 'utf8')).kind).toBe('checked')
})

it.each(['success', 'network'])('retains installed proof after a migrated receipt check returns %s', async result => {
  const { updater, checked, create, profile, directory, transport } = await fixture()
  await updater.start(await checked())
  await settled(updater)
  const current = create('0.2.16')
  await current.check()
  const path = join(profile, '.crowdtest-updater', 'receipt.json')
  const { installedProof } = JSON.parse(await readFile(path, 'utf8'))
  expect(installedProof).toBeDefined()
  const stored = JSON.stringify({ kind: 'failed', code: 'credential', latest: '0.2.17', installedProof })
  await writeFile(path, stored)
  expect(await current.inspect()).toMatchObject({ latestVersion: '0.2.17', status: { kind: 'failed', code: 'recheck' } })
  expect(await readFile(path, 'utf8')).toBe(stored)
  if (result === 'network') transport.mockResolvedValueOnce(new Response(null, { status: 503 }))
  await current.check()
  expect(JSON.parse(await readFile(path, 'utf8')).installedProof).toEqual(installedProof)
  await writeFile(join(directory, 'lib/client.js'), 'modified after legacy recheck')
  const count = transport.mock.calls.length
  expect((await current.inspect()).status.kind).toBe('recovery-needed')
  await current.check()
  expect(transport.mock.calls).toHaveLength(count)
})

it.each(['restart', 'payload', 'archive', 'mismatched-proof'])('keeps %s safety checks ahead of a legacy credential failure', async state => {
  const { updater, checked, create, profile, directory, transport } = await fixture()
  await updater.start(await checked())
  await settled(updater)
  const current = create('0.2.16')
  await current.check()
  const path = join(profile, '.crowdtest-updater', 'receipt.json')
  const { installedProof } = JSON.parse(await readFile(path, 'utf8'))
  if (state === 'payload') await writeFile(join(directory, 'lib/client.js'), 'corrupted before legacy read')
  if (state === 'archive') {
    const archive = join(profile, '.crowdtest-updater', installedProof.jobId, `target-${installedProof.hash}.tgz`)
    await chmod(archive, 0o600)
    await writeFile(archive, 'bad archive')
  }
  if (state === 'mismatched-proof') installedProof.version = '0.2.17'
  const stored = JSON.stringify({ kind: 'failed', code: 'credentialStore', latest: '0.2.17', installedProof })
  await writeFile(path, stored)
  const selected = state === 'restart' ? create() : current
  const count = transport.mock.calls.length
  expect((await selected.inspect()).status.kind).toBe(state === 'restart' ? 'restart-required' : 'recovery-needed')
  await selected.check()
  expect(transport.mock.calls).toHaveLength(count)
  expect(await readFile(path, 'utf8')).toBe(stored)
})

it.each([
  { code: 'unknown' },
  { code: 'credential', unexpected: true },
  { code: 'credential', installedProof: { jobId: 'invalid', role: 'target', version: '0.2.16', hash: '0'.repeat(64) } },
])('rejects malformed legacy receipt %# rather than resetting state', async changes => {
  const { updater, checked, profile } = await fixture()
  await checked()
  const path = join(profile, '.crowdtest-updater', 'receipt.json')
  const stored = JSON.stringify({ kind: 'failed', latest: null, ...changes })
  await writeFile(path, stored)
  await expect(updater.inspect()).rejects.toMatchObject({ code: 'state' })
  expect(await readFile(path, 'utf8')).toBe(stored)
})


it.each(Object.keys(updateErrors))('continues to read a current failed receipt with code %s', async code => {
  const { updater, profile, checked } = await fixture()
  await checked()
  const path = join(profile, '.crowdtest-updater', 'receipt.json')
  const stored = JSON.stringify({ kind: 'failed', code, latest: null })
  await writeFile(path, stored)
  expect((await updater.inspect()).status).toEqual({ kind: 'failed', code })
  expect(await readFile(path, 'utf8')).toBe(stored)
})
