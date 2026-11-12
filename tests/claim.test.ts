import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { manifest } from './manifest.ts'
import type { DshModelSelection, DshSessionEvent } from '../src/dsh.ts'
import { createContext } from './host.ts'

vi.mock('@deepseek-ai/dsh-session', () => ({
  appendPluginRecord(session: { events: DshSessionEvent[] }, type: string, data: unknown) {
    const seq = session.events.length
    session.events.push({ type, seq, time: Date.now(), data, ignorable: true })
    return seq
  },
}))

const A = 'https://platform.example/team-a'
const B = 'https://second-platform.example/team-b'
const signal = new AbortController().signal
const agent = (id: string) => ({ id, session: { id } })

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
  vi.unstubAllGlobals()
})

async function fixture(legacy?: (root: string) => unknown[] | Promise<unknown[]>) {
  const root = await mkdtemp(join(tmpdir(), 'crowdtest-claim-'))
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const h = createContext()
  const stateFile = join(root, 'runs.json')
  const nativeSessionRoot = join(root, 'sessions')
  const workspaceRoot = join(root, 'workspaces')
  if (legacy) await writeFile(stateFile, JSON.stringify({ version: 1, runs: await legacy(root) }))
  const sessions = new Set<string>()
  const live = new Set<string>()
  const records = new Map<string, DshSessionEvent[]>()
  const secrets = new Map<string, string>()
  const profiles = new Map<string, unknown>()
  const manifests = new Map<string, unknown>([[A, manifest], [B, { ...manifest, sessionId: 's2' }]])
  const auth: Array<[string, string | null]> = []
  const uploaded = new Map<string, object>()
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const [base, action] = String(url).split('/api/crowdtest/local-runs')
    if (action === '/dsh/ticket/exchange') return Response.json({ token: 'test-token-' + base, tokenExpiresAt: Date.now() + 100_000 })
    if (action === '/dsh/manifest') return Response.json(manifests.get(base!))
    if (action?.startsWith('/session/')) auth.push([base!, new Headers(init?.headers).get('authorization')])
    if (action === '/session/status') return Response.json({ backup: uploaded.get(base!) ?? null })
    if (action === '/session/upload-url') return Response.json({ signedPostUrl: 'https://storage.example/', fileField: 'file', formFields: {} })
    if (String(url) === 'https://storage.example/') return new Response(null, { status: 204 })
    if (action === '/session/verify') {
      uploaded.set(base!, { ...JSON.parse(String(init?.body)), uploadedAtMs: 1000 })
      return Response.json({})
    }
    throw new Error('unexpected fixture request')
  })
  vi.stubGlobal('fetch', fetcher)
  const ctx = h.ctx
  ctx.credentials.set = vi.fn(async (key, value) => { secrets.set(key, value) })
  ctx.credentials.resolve = vi.fn(async key => {
    const value = secrets.get(key)
    return value ? { value, source: 'test' } : undefined
  })
  ctx.settings.mutate = vi.fn(async (_entry, ops) => { for (const op of ops) if (op.op === 'set') profiles.set(op.path[1]!, op.value) })
  ctx.agents.get = id => live.has(id) ? { id, session: { id, events: records.get(id) } } : undefined
  ctx.sessionPersistence.open = async id => {
    if (!sessions.has(id)) throw Object.assign(new Error(), { name: 'SessionPersistenceNotFoundError' })
    return { header: { id }, close: async () => {}, read: async () => ({ events: records.get(id) ?? [] }) }
  }
  ctx.sessionPersistence.stat = async id => sessions.has(id) ? { header: { id }, revision: '1' } : undefined
  ctx.sessionController.create = vi.fn(async ({ sessionId: id }) => {
    if (!id || sessions.has(id)) throw new Error('session occupied')
    sessions.add(id)
    records.set(id, [])
    live.add(id)
    const directory = join(nativeSessionRoot, '_no-cwd', id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id })+'\n')))
    return { sessionId: id }
  })
  let selected: DshModelSelection = { provider: 'default', model: 'ordinary' }
  ctx.agentDefaultModel.currentSelection = () => selected
  ctx.agentDefaultModel.saveSelection = async model => { selected = model }
  ctx.sessionController.selectModel = vi.fn(async ({ sessionId: _id, ...model }) => { selected = model; return { selected: model } })
  ctx.sessionController.prompt = vi.fn(async () => ({ accepted: true as const }))
  const install = async () => { await apply(ctx, { stateFile, nativeSessionRoot, workspaceRoot, uploadDebounceMs: 0 }) }
  await install()
  disposals.push(() => h.dispose())
  const command = (name: string, id: string, rawInput = '') => h.commands.get(name)!.handler({ agent: agent(id), rawInput, signal })
  const claim = (base: string) => command('crowdtest', 'ordinary', ('ABCD-EFGH ' + base).trim())
  const upload = (id: string) => command('crowdtest-upload', id)
  const turn = (id: string) => h.getSessionEventListener()!({ id }, { type: 'turn/end', seq: 1, time: 1, data: {} })
  const request = (id: string, provider: string, next = vi.fn(async () => ({ provider, model: manifest.model.alias }))) =>
    h.getAgentRequestListener()!({ agent: agent(id), turn: 1, step: 1, signal }, next)
  return { ...h, install, root, stateFile, workspaceRoot, sessions, live, secrets, profiles, manifests, fetcher, auth, claim, upload, turn, request }
}

function legacyRow(root: string, serverBaseUrl = A, sessionId = 's1') {
  return { projectId: 11, taskId: 21, taskModelRunId: 31, sessionId, serverBaseUrl, model: manifest.model,
    credentialRef: 'CROWDTEST_RUN_31_TOKEN', workspace: join(root, 'previous-workspace-' + sessionId), backupFormat: manifest.sessionBackup.format,
    backupMaxBytes: manifest.sessionBackup.maxBytes, lastSyncedAtMs: 123 }
}

it('requests the full command before exchanging a bare ticket', async () => {
  const f = await fixture()
  expect(await f.claim('')).toMatchObject({ kind: 'error', text: expect.stringContaining('平台地址') })
  expect(f.fetcher).not.toHaveBeenCalled()
})

it.each([
  { projectId: 0 }, { taskId: -1 }, { taskModelRunId: 1.5 },
  { attachments: [{ name: 'one.txt', size: 1, sha256: null, contentType: 'text/plain', url: 'https://storage.example/?signature=test' },
      { name: 'two.txt', size: -1, sha256: null, contentType: 'text/plain', url: 'https://storage.example/' }] },
])('fully validates %j before any local claim writes', async changed => {
  const f = await fixture()
  f.manifests.set(A, { ...manifest, ...changed })
  expect(await f.claim(A)).toMatchObject({ kind: 'error' })
  expect(await readdir(f.root)).toEqual([])
  expect(f.secrets.size).toBe(0)
  expect(f.profiles.size).toBe(0)
  expect(f.fetcher).toHaveBeenCalledTimes(2)
})

it.each(['live', 'persisted'])('leaves a %s ordinary session and its backup untouched', async where => {
  const f = await fixture()
  const occupied = where === 'live' ? f.live : f.sessions
  occupied.add('s1')
  expect(await f.claim(A)).toMatchObject({ kind: 'error' })
  expect(await readdir(f.root)).toEqual([])
  expect(f.secrets.size + f.profiles.size).toBe(0)
  f.turn('s1')
  expect(await f.upload('s1')).toMatchObject({ kind: 'error' })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(f.ctx.credentials.resolve).not.toHaveBeenCalled()
})

it('uses independent routes, credentials, workspaces and backup authorization for each platform', async () => {
  const f = await fixture()
  for (const base of [A, B]) expect(await f.claim(base)).toMatchObject({ kind: 'success' })
  expect(f.secrets.size).toBe(2)
  expect(f.profiles.size).toBe(2)
  expect(await readdir(f.workspaceRoot)).toHaveLength(2)
  for (const id of ['s1', 's2']) expect(await f.upload(id)).toMatchObject({ kind: 'success' })
  expect(f.auth).toHaveLength(8)
  for (const [base, authorization] of f.auth) expect(authorization).toBe('Bearer test-token-' + base)
})

it('serializes competing claims and preserves the owner even if its session is absent', async () => {
  const f = await fixture()
  f.manifests.set(B, manifest)
  const results = await Promise.all([f.claim(A), f.claim(B)])
  expect(results.map(r => r.kind).sort()).toEqual(['error', 'success'])
  f.sessions.clear()
  expect(await f.claim(B)).toMatchObject({ kind: 'error' })
  expect(f.ctx.credentials.set).toHaveBeenCalledTimes(1)
})

it('renews a unique legacy binding with its original resources, history and updated model pin', async () => {
  const f = await fixture(root => [legacyRow(root)])
  f.sessions.add('s1')
  f.manifests.set(A, { ...manifest, model: { ...manifest.model, alias: 'new-alias' } })
  expect(await f.claim(A)).toMatchObject({ kind: 'success' })
  const row = JSON.parse(await readFile(f.stateFile, 'utf8')).runs[0]
  expect(row).toMatchObject({ ...legacyRow(f.root), model: { alias: 'new-alias' }, provider: 'crowdtest-run-31', resourceStatus: 'ready' })
  expect(f.ctx.sessionController.selectModel).toHaveBeenCalledWith(expect.objectContaining({ provider: row.provider, model: 'new-alias' }))
  expect(f.ctx.sessionController.prompt).not.toHaveBeenCalled()
})

it('keeps every owner of ambiguous legacy resources blocked until its own fresh claim', async () => {
  const f = await fixture(root => [legacyRow(root), legacyRow(root, B, 's2')])
  f.sessions.add('s1')
  for (const id of ['s1', 's2']) {
    await expect(f.request(id, 'crowdtest-run-31')).rejects.toThrow(/重新领取/)
    expect(await f.upload(id)).toMatchObject({ kind: 'error', text: expect.stringContaining('重新领取') })
    f.turn(id)
  }
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(f.ctx.credentials.resolve).not.toHaveBeenCalled()
  expect(f.fetcher).not.toHaveBeenCalled()
  expect(await f.claim(A)).toMatchObject({ kind: 'success' })
  const [first, other] = JSON.parse(await readFile(f.stateFile, 'utf8')).runs
  expect(first.resourceStatus).toBe('ready')
  expect(first.credentialRef).not.toBe(other.credentialRef)
  expect(first.provider).not.toBe(other.provider)
  expect(other.resourceStatus).toBe('reclaim-required')
  expect(f.ctx.sessionController.selectModel).toHaveBeenCalledWith(expect.objectContaining({ provider: first.provider }))
  await f.dispose()
  await f.install()
  await expect(f.request('s2', other.provider)).rejects.toThrow(/重新领取/)
  expect(await f.upload('s2')).toMatchObject({ kind: 'error' })
  expect(f.ctx.credentials.resolve).not.toHaveBeenCalled()
})

it('keeps ambiguous session owners blocked and preserves both records across unrelated writes', async () => {
  const f = await fixture(root => [legacyRow(root), legacyRow(root, B)])
  const next = vi.fn(async () => ({ provider: 'crowdtest-run-31', model: manifest.model.alias }))
  await expect(f.request('s1', 'crowdtest-run-31', next)).rejects.toThrow()
  expect(next).not.toHaveBeenCalled()
  expect(await f.upload('s1')).toMatchObject({ kind: 'error' })
  for (const base of [A, B]) {
    f.manifests.set(base, manifest)
    expect(await f.claim(base)).toMatchObject({ kind: 'error' })
  }
  expect(f.ctx.credentials.resolve).not.toHaveBeenCalled()
  expect(f.ctx.credentials.set).not.toHaveBeenCalled()
  f.manifests.set(A, { ...manifest, sessionId: 's3', taskModelRunId: 33 })
  expect(await f.claim(A)).toMatchObject({ kind: 'success' })
  const { runs } = JSON.parse(await readFile(f.stateFile, 'utf8'))
  expect(runs.filter((run: { sessionId: string }) => run.sessionId === 's1')).toHaveLength(2)
  await f.dispose()
  await f.install()
  await expect(f.request('s1', 'crowdtest-run-31', next)).rejects.toThrow()
  expect(next).not.toHaveBeenCalled()
  expect(await f.upload('s1')).toMatchObject({ kind: 'error' })
  expect(f.ctx.credentials.resolve).not.toHaveBeenCalled()
})

it('only activates a binding after the expected session exists and its state is durable', async () => {
  const f = await fixture()
  const create = f.ctx.sessionController.create
  f.ctx.sessionController.create = async () => ({ sessionId: 'other' })
  expect(await f.claim(A)).toMatchObject({ kind: 'error' })
  expect(await f.upload('s1')).toMatchObject({ kind: 'error' })
  f.ctx.sessionController.create = create
  await rm(f.stateFile)
  await mkdir(f.stateFile)
  expect(await f.claim(A)).toMatchObject({ kind: 'error' })
  expect(await f.upload('s1')).toMatchObject({ kind: 'error' })
  expect(f.ctx.credentials.resolve).not.toHaveBeenCalled()
  expect(f.ctx.sessionController.prompt).not.toHaveBeenCalled()
  expect(f.sessions.size).toBe(0)
  await rm(f.stateFile, { recursive: true })
  expect(await f.claim(A)).toMatchObject({ kind: 'success' })
})

it('recovers the exact native creation after a failed ready write and restart', async () => {
  const f = await fixture()
  const select = f.ctx.sessionController.selectModel
  const reservation = f.stateFile + '.hold'
  f.ctx.sessionController.selectModel = async request => {
    await rename(f.stateFile, reservation)
    await mkdir(f.stateFile)
    return select(request)
  }
  expect(await f.claim(A)).toMatchObject({ kind: 'error' })
  expect(f.sessions.has('s1')).toBe(true)
  expect(await f.upload('s1')).toMatchObject({ kind: 'error' })
  expect(f.ctx.credentials.resolve).not.toHaveBeenCalled()
  expect(f.ctx.sessionController.prompt).not.toHaveBeenCalled()
  await rm(f.stateFile, { recursive: true })
  await rename(reservation, f.stateFile)
  await f.dispose()
  f.live.clear()
  await f.install()
  f.ctx.sessionController.selectModel = select
  expect(await f.claim(A)).toMatchObject({ kind: 'success' })
  expect(f.ctx.sessionController.create).toHaveBeenCalledTimes(1)
  expect(f.ctx.sessionController.prompt).toHaveBeenCalledTimes(1)
  expect(JSON.parse(await readFile(f.stateFile, 'utf8')).runs[0]).not.toHaveProperty('claimNonce')
})

it('requires creation evidence when an ordinary session appears after a reservation', async () => {
  const f = await fixture()
  f.ctx.sessionController.create = async () => { throw new Error('create interrupted') }
  expect(await f.claim(A)).toMatchObject({ kind: 'error' })
  f.sessions.add('s1')
  expect(await f.claim(A)).toMatchObject({ kind: 'error', text: expect.stringContaining('创建记录') })
  expect(await f.upload('s1')).toMatchObject({ kind: 'error' })
  expect(f.ctx.credentials.resolve).not.toHaveBeenCalled()
  expect(f.ctx.credentials.set).toHaveBeenCalledTimes(1)
  expect(f.ctx.sessionController.prompt).not.toHaveBeenCalled()
})

it.each(['same path', 'directory alias'])('keeps an existing session in a shared legacy workspace blocked (%s)', async kind => {
  const f = await fixture(async root => {
    const first = legacyRow(root)
    await mkdir(first.workspace)
    const alias = join(root, 'alias')
    await symlink(first.workspace, alias)
    return [first, { ...legacyRow(root, B, 's2'), workspace: kind === 'same path' ? first.workspace : alias,
      provider: 'another-provider', credentialRef: 'ANOTHER_REF' }]
  })
  f.sessions.add('s1')
  await expect(f.request('s1', 'crowdtest-run-31')).rejects.toThrow()
  expect(await f.upload('s1')).toMatchObject({ kind: 'error' })
  expect(await f.claim(A)).toMatchObject({ kind: 'error', text: expect.stringContaining('重新创建') })
  expect(f.ctx.credentials.resolve).not.toHaveBeenCalled()
  expect(f.ctx.credentials.set).not.toHaveBeenCalled()
  expect(f.ctx.settings.mutate).not.toHaveBeenCalled()
  expect(await f.claim(B)).toMatchObject({ kind: 'success' })
  await f.dispose()
  await f.install()
  expect(await f.claim(A)).toMatchObject({ kind: 'error' })
  f.sessions.delete('s1')
  expect(await f.claim(A)).toMatchObject({ kind: 'success' })
  const { runs } = JSON.parse(await readFile(f.stateFile, 'utf8'))
  expect(new Set(runs.map((run: {workspace: string}) => run.workspace)).size).toBe(2)
  expect(await readdir(f.workspaceRoot)).toHaveLength(2)
  expect(await readdir(legacyRow(f.root).workspace)).toEqual([])
})

it('isolates missing legacy workspaces beneath real and aliased parents across restart', async () => {
  const f = await fixture(async root => {
    const parent = join(root, 'parent')
    const alias = join(root, 'alias')
    await mkdir(parent)
    await symlink(parent, alias)
    return [{ ...legacyRow(root), workspace: join(parent, 'removed', 'child') },
      { ...legacyRow(root, B, 's2'), workspace: join(alias, 'removed', 'child'), provider: 'other-provider', credentialRef: 'OTHER_REF' }]
  })
  expect(await f.claim(A)).toMatchObject({ kind: 'success' })
  const saved = JSON.parse(await readFile(f.stateFile, 'utf8')).runs
  expect(saved[1]).toMatchObject({ sessionId: 's2', workspaceConflict: true, resourceStatus: 'reclaim-required' })
  await f.dispose()
  await f.install()
  await expect(f.request('s2', 'other-provider')).rejects.toThrow()
  expect(await f.claim(B)).toMatchObject({ kind: 'success' })
  const { runs } = JSON.parse(await readFile(f.stateFile, 'utf8'))
  const directories = await Promise.all(runs.map((run: {workspace: string}) => realpath(run.workspace)))
  expect(new Set(directories).size).toBe(2)
  expect(await readdir(f.workspaceRoot)).toHaveLength(2)
  expect(await readdir(join(f.root, 'parent'))).toEqual([])
})

it('restores the default reasoning effort when only the effort differs from the run selection', async () => {
  const f = await fixture(root => [legacyRow(root)])
  f.sessions.add('s1')
  const previous = { provider: 'crowdtest-run-31', model: manifest.model.alias, reasoningEffort: 'low' }
  await f.ctx.agentDefaultModel.saveSelection(previous)
  f.manifests.set(A, { ...manifest, model: { ...manifest.model, reasoningEffort: 'high' } })
  expect(await f.claim(A)).toMatchObject({ kind: 'success' })
  expect(f.ctx.agentDefaultModel.currentSelection()).toEqual(previous)
})
