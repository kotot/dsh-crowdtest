import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSessionArchive } from '../src/archive.ts'
import { type NativeSessionFile, NATIVE_SESSION_NAME } from '../src/native-session.ts'
import type { ServerBackup } from '../src/bff.ts'
import type { DshSessionEvent } from '../src/dsh.ts'
import { SessionBackups } from '../src/session-backups.ts'
import { RunBindings, type RunBinding } from '../src/state.ts'

const A = '5bceb58e-601f-5e17-9607-32d954f16455'
const B = '6bceb58e-601f-5e17-9607-32d954f16456'
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const disposals: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(disposals.splice(0).map(dispose => dispose())); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function fixture(uploadDebounceMs = 60_000) {
  const dir = await mkdtemp(join(tmpdir(), 'sync-lanes-'))
  const stateFile = join(dir, 'runs.json')
  const bindings = new RunBindings(stateFile)
  function binding(id: string, runId: number): RunBinding {
    return { sessionId: id, provider: `run-${runId}`, resourceStatus: 'ready', projectId: 11, taskId: runId - 10, taskModelRunId: runId, serverBaseUrl: `https://bff.example/${runId}`, credentialRef: `TEST_ONLY_${runId}`, model: { alias: 'anonymous', apiType: 'openai-completions', protocol: 'openai-completions', baseUrl: 'https://router.example', input: ['text'] }, backupFormat: 'dsh-session-tree-tar-gzip', backupMaxBytes: 134217728, workspace: join(dir, id), lastUploadedSha256: 'a'.repeat(64) }
  }
  await bindings.put(binding(A, 31)); await bindings.put(binding(B, 32))
  const events = new Map<string, DshSessionEvent[]>([[A, []], [B, []]])
  const backups = new Map<number, ServerBackup>()
  const descriptors = new Map<number, { size: number; sha256: string; format: string }>()
  const nativeSessionRoot = join(dir, 'sessions')
  const nativeFile = (id: string): Pick<NativeSessionFile, 'name' | 'bytes'> => ({ name: NATIVE_SESSION_NAME, bytes: zstdCompressSync(Buffer.from(
    [JSON.stringify({ type: 'session', version: 4, id }), ...(events.get(id) ?? []).map(event => JSON.stringify(event))].join('\n') + '\n',
  )) })
  const path = (id: string) => join(nativeSessionRoot, '_no-cwd', id, NATIVE_SESSION_NAME)
  const persist = (id: string) => { mkdirSync(join(nativeSessionRoot, '_no-cwd', id), { recursive: true }); writeFileSync(path(id), nativeFile(id).bytes) }
  persist(A); persist(B)
  const stat = vi.fn(async (id: string) => ({ header: { id }, revision: 'test-revision' }))
  const resolve = vi.fn(async (_ref: string): Promise<{value: string; source: string} | undefined> => ({ value: 'FAKE_TEST_ONLY_TOKEN', source: 'test' }))
  const ctx = { credentials: { resolve, set: async () => {} }, sessionPersistence: { flush: async () => {}, stat, open: vi.fn() }, logger: { info: vi.fn(), warn: vi.fn() } }
  let statusCode = 200
  let beforeStatus: ((run: number) => Promise<void>) | undefined
  let beforeUpload: ((run: number) => Promise<void>) | undefined
  let uploads = 0
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url)
    const run = Number(new URL(text).pathname.split('/')[1])
    if (text.endsWith('/status')) {
      await beforeStatus?.(run)
      if (statusCode !== 200) return new Response('{}', { status: statusCode })
      return Response.json({ backup: backups.get(run) ?? null })
    }
    if (text.endsWith('/upload-url')) {
      descriptors.set(run, JSON.parse(String(init?.body)))
      return Response.json({ signedPostUrl: `https://storage.example/${run}/upload`, formFields: {}, fileField: 'file' })
    }
    if (text.endsWith('/upload')) {
      uploads++
      await beforeUpload?.(run)
      const form = init?.body
      if (!(form instanceof FormData)) throw new Error('expected form data')
      const file = form.get('file')
      if (!(file instanceof Blob)) throw new Error('expected blob')
      const bytes = await file.arrayBuffer()
      const descriptor = descriptors.get(run)
      if (!descriptor) throw new Error('missing descriptor')
      expect(createHash('sha256').update(new Uint8Array(bytes)).digest('hex')).toBe(descriptor.sha256)
      backups.set(run, { ...descriptor, uploadedAtMs: 1234 })
      return new Response(null, { status: 204 })
    }
    if (text.endsWith('/verify')) return Response.json({ ok: true })
    throw new Error(`unexpected request ${text}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const sync = new SessionBackups(ctx, bindings, { uploadDebounceMs, nativeSessionRoot })
  disposals.push(async () => { await sync.dispose(); await rm(dir, { recursive: true, force: true }) })
  const append = (id: string, completedTurn = false) => { events.get(id)?.push({ type: completedTurn ? 'turn/end' : 'message', seq: events.get(id)?.length ?? 0, time: 1, data: 'new content' }); persist(id); sync.changed(id, completedTurn) }
  return { bindings, binding, sync, ctx, stateFile, events, backups, stat, nativeFile, nativeSessionRoot, path, persist, resolve, fetcher, append, get uploads() { return uploads }, set statusCode(code: number) { statusCode = code }, set beforeStatus(callback: typeof beforeStatus) { beforeStatus = callback }, set beforeUpload(callback: typeof beforeUpload) { beforeUpload = callback } }
}
describe('session backup authority and lane ownership', () => {
  it('hides ordinary sessions without touching credentials or storage', async () => {
    const f = await fixture()
    expect(await f.sync.inspect('ordinary')).toBeNull()
    expect(await f.sync.sync('ordinary')).toBeNull()
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled()
  })
  it.each(['creating', 'reclaim-required'] as const)('blocks backup inspection and upload for a %s binding', async resourceStatus => {
    const f = await fixture(0)
    await f.bindings.put({ ...f.binding(A, 31), resourceStatus })
    expect(await f.sync.inspect(A)).toMatchObject({ phase: 'unknown' })
    await expect(f.sync.sync(A)).rejects.toThrow(/重新领取/)
    f.sync.changed(A, true)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.fetcher).not.toHaveBeenCalled()
  })
  it('ignores historical local digest, checks actual absence and uploads exact bytes', async () => {
    const f = await fixture()
    const digest = buildSessionArchive(A, f.nativeFile(A)).sha256
    const binding = f.bindings.get(A)
    if (!binding) throw new Error('missing binding')
    binding.lastUploadedSha256 = digest
    expect((await f.sync.inspect(A))?.phase).toBe('dirty')
    expect((await f.sync.sync(A))?.phase).toBe('synced')
    expect(f.uploads).toBe(1); expect(f.backups.get(31)?.sha256).toBe(digest)
    expect((await f.sync.sync(A))?.phase).toBe('synced'); expect(f.uploads).toBe(1)
    expect(f.ctx.sessionPersistence.open).not.toHaveBeenCalled()
    f.backups.delete(31)
    expect((await f.sync.inspect(A))?.phase).toBe('dirty')
  })
  it('checks equality of digest, size and format and recovers after failed synchronization', async () => {
    const f = await fixture()
    f.statusCode = 403
    expect((await f.sync.inspect(A))?.phase).toBe('unknown')
    await expect(f.sync.sync(A)).rejects.toThrow('403')
    f.statusCode = 200
    expect((await f.sync.sync(A))?.phase).toBe('synced')
    const backup = f.backups.get(31)
    if (!backup) throw new Error('missing backup')
    f.backups.set(31, { ...backup, size: backup.size + 1 })
    expect((await f.sync.inspect(A))?.phase).toBe('dirty')
    f.resolve.mockResolvedValue(undefined)
    expect((await f.sync.inspect(A))?.phase).toBe('unknown')
  })
  it('coalesces repeated clicks and allows another session to finish independently', async () => {
    const f = await fixture(); const block = deferred<void>()
    f.beforeUpload = async run => { if (run === 31) await block.promise }
    const first = f.sync.sync(A)
    expect(f.sync.sync(A)).toBe(first)
    await vi.waitFor(() => expect(f.uploads).toBe(1))
    expect((await f.sync.sync(B))?.phase).toBe('synced')
    expect((await f.sync.inspect(A))?.phase).toBe('uploading')
    block.resolve(); expect((await first)?.phase).toBe('synced'); expect(f.uploads).toBe(2)
  })
  it('does not publish synced when content changes during upload and performs trailing completed-turn sync', async () => {
    const f = await fixture(); const block = deferred<void>()
    f.beforeUpload = async () => { await block.promise }
    const first = f.sync.sync(A)
    await vi.waitFor(() => expect(f.uploads).toBe(1))
    f.append(A, true)
    block.resolve()
    expect((await first)?.phase).toBe('synced'); expect(f.uploads).toBe(2)
    const latest = buildSessionArchive(A, f.nativeFile(A))
    expect(f.backups.get(31)?.sha256).toBe(latest.sha256)
  })
  it('retains dirty status after non-completed content arrives during upload', async () => {
    const f = await fixture(); const block = deferred<void>()
    f.beforeUpload = async () => { await block.promise }
    const first = f.sync.sync(A)
    await vi.waitFor(() => expect(f.uploads).toBe(1))
    f.append(A)
    block.resolve()
    expect((await first)?.phase).toBe('dirty'); expect(f.uploads).toBe(1)
  })
  it('reports source failure, then recovers', async () => {
    const f = await fixture()
    f.stat.mockRejectedValueOnce(new Error('stat failed'))
    expect((await f.sync.inspect(A))?.phase).toBe('unknown')
    expect((await f.sync.inspect(A))?.phase).toBe('dirty')
  })
  it('fences replaced bindings and does not publish old results', async () => {
    const f = await fixture(); const block = deferred<void>()
    f.beforeStatus = async run => { if (run === 31) await block.promise }
    const stale = f.sync.inspect(A)
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled())
    await f.bindings.put(f.binding(A, 32))
    const next = await f.sync.inspect(A)
    expect(next?.runId).toBe(32)
    block.resolve(); expect(await stale).toBeNull()
  })
  it('disposes queued work before further storage or session access', async () => {
    const f = await fixture(); const block = deferred<{value: string; source: string} | undefined>()
    f.resolve.mockImplementationOnce(() => block.promise)
    const pending = f.sync.inspect(A)
    const disposing = f.sync.dispose()
    block.resolve({ value: 'FAKE_TEST_ONLY', source: 'test' })
    await disposing
    expect(await pending).toBeNull(); expect(f.stat).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled()
  })
})
it('keeps a failed upload visible through later polls until retry succeeds', async () => {
  const f = await fixture()
  f.beforeUpload = async () => { throw new Error('controlled upload failure') }
  await expect(f.sync.sync(A)).rejects.toThrow('controlled upload failure')
  expect((await f.sync.inspect(A))?.phase).toBe('failed')
  f.append(A)
  expect((await f.sync.inspect(A))?.phase).toBe('failed')
  f.beforeUpload = undefined
  expect((await f.sync.sync(A))?.phase).toBe('synced')
})
it('does not swallow a completed turn after an in-flight upload fails', async () => {
  const f = await fixture(0)
  const block = deferred<void>()
  let firstUpload = true
  f.beforeUpload = async () => {
    if (firstUpload) { firstUpload = false; await block.promise; throw new Error('first upload failed') }
  }
  const first = f.sync.sync(A)
  await vi.waitFor(() => expect(f.uploads).toBe(1))
  f.append(A, true)
  block.resolve()
  await expect(first).rejects.toThrow('first upload failed')
  await vi.waitFor(() => expect(f.uploads).toBe(2))
  expect((await f.sync.inspect(A))?.phase).toBe('synced')
})

it('refreshes successful sync confirmation for unchanged content without uploading twice', async () => {
  const f = await fixture()
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
  expect(await f.sync.sync(A)).toMatchObject({ phase: 'synced', uploadedAtMs: 1234, lastSyncedAtMs: 10_000 })
  now.mockReturnValue(20_000)
  expect(await f.sync.sync(A)).toMatchObject({ phase: 'synced', uploadedAtMs: 1234, lastSyncedAtMs: 20_000 })
  expect(f.uploads).toBe(1)
  expect(f.bindings.get(A)).toMatchObject({ lastSyncedAtMs: 20_000 })
})

it('does not advance or persist confirmation during polling, dirty content or failed sync', async () => {
  const f = await fixture()
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
  await f.sync.sync(A)
  const stored = await readFile(f.stateFile, 'utf8')
  now.mockReturnValue(20_000)
  expect(await f.sync.inspect(A)).toMatchObject({ phase: 'synced', lastSyncedAtMs: 10_000 })
  expect(await readFile(f.stateFile, 'utf8')).toBe(stored)
  f.append(A)
  expect(await f.sync.inspect(A)).toMatchObject({ phase: 'dirty', lastSyncedAtMs: 10_000 })
  f.statusCode = 503
  await expect(f.sync.sync(A)).rejects.toThrow('503')
  expect(f.bindings.get(A)?.lastSyncedAtMs).toBe(10_000)
  expect(await readFile(f.stateFile, 'utf8')).toBe(stored)
})

it('retains independent confirmation history after reloading bindings without treating it as proof', async () => {
  const f = await fixture()
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
  await f.sync.sync(A)
  now.mockReturnValue(20_000)
  await f.sync.sync(B)
  const reloaded = new RunBindings(f.stateFile)
  await reloaded.load()
  const restarted = new SessionBackups(f.ctx, reloaded, { nativeSessionRoot: f.nativeSessionRoot })
  disposals.push(() => restarted.dispose())
  expect(await restarted.inspect(A)).toMatchObject({ phase: 'synced', lastSyncedAtMs: 10_000 })
  expect(await restarted.inspect(B)).toMatchObject({ phase: 'synced', lastSyncedAtMs: 20_000 })
  f.backups.delete(31)
  expect(await restarted.inspect(A)).toMatchObject({ phase: 'dirty', lastSyncedAtMs: 10_000, uploadedAtMs: null })
})

it('records automatic sync confirmation and does not record a stale uploaded snapshot', async () => {
  const f = await fixture(0)
  f.append(A, true)
  await vi.waitFor(() => expect(f.bindings.get(A)?.lastSyncedAtMs).toEqual(expect.any(Number)))
  const confirmed = f.bindings.get(A)?.lastSyncedAtMs
  f.beforeUpload = async () => { f.append(A) }
  f.append(A)
  expect(await f.sync.sync(A)).toMatchObject({ phase: 'dirty', lastSyncedAtMs: confirmed })
  expect(f.bindings.get(A)?.lastSyncedAtMs).toBe(confirmed)
})

it('does not advance in-memory confirmation when persistence fails', async () => {
  const f = await fixture()
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
  await f.sync.sync(A)
  now.mockReturnValue(20_000)
  await rm(f.stateFile)
  await mkdir(f.stateFile)
  await expect(f.sync.sync(A)).rejects.toThrow()
  expect(f.bindings.get(A)?.lastSyncedAtMs).toBe(10_000)
  expect(await f.sync.inspect(A)).toMatchObject({ lastSyncedAtMs: 10_000 })
})

it.each(['replacement', 'disposal'])('does not record sync confirmation after %s during server confirmation', async reason => {
  const f = await fixture()
  await f.sync.sync(A)
  const confirmed = f.bindings.get(A)?.lastSyncedAtMs
  const block = deferred<void>()
  f.beforeStatus = () => block.promise
  const pending = f.sync.sync(A)
  await vi.waitFor(() => expect(f.fetcher.mock.calls.length).toBeGreaterThan(5))
  if (reason === 'replacement') await f.bindings.put(f.binding(A, 32))
  const disposing = reason === 'disposal' ? f.sync.dispose() : undefined
  block.resolve()
  await disposing
  expect(await pending).toBeNull()
  expect(f.bindings.get(A)?.lastSyncedAtMs).toBe(reason === 'replacement' ? undefined : confirmed)
})

it('publishes confirmed history only after a valid durable write and restores an invalid candidate', async () => {
  const f = await fixture()
  const binding = f.bindings.get(A)
  if (!binding) throw new Error('missing binding')
  let checks = 0
  const pending = f.bindings.recordSuccessfulSync({ binding, confirmedAtMs: 10_000, isCurrent: () => ++checks === 1 })
  expect(binding.lastSyncedAtMs).toBeUndefined()
  expect(await pending).toBe(false)
  expect(binding.lastSyncedAtMs).toBeUndefined()
  const reloaded = new RunBindings(f.stateFile)
  await reloaded.load()
  expect(reloaded.get(A)?.lastSyncedAtMs).toBeUndefined()
})

it('retains confirmation when renewing only the credentials for the same run', async () => {
  const f = await fixture()
  vi.spyOn(Date, 'now').mockReturnValue(10_000)
  await f.sync.sync(A)
  await f.bindings.put({ ...f.binding(A, 31), credentialRef: 'RENEWED_TEST_ONLY' })
  expect(await f.sync.inspect(A)).toMatchObject({ phase: 'synced', lastSyncedAtMs: 10_000 })
})

it.each([
  { serverBaseUrl: 'https://other.example' },
  { projectId: 12 },
  { taskId: 22 },
  { taskModelRunId: 32 },
  { sessionId: '7bceb58e-601f-5e17-9607-32d954f16457' },
])('does not inherit confirmation for a different identity %j', async changed => {
  const f = await fixture()
  await f.sync.sync(A)
  const next = { ...f.binding(A, 31), ...changed }
  await f.bindings.put(next)
  expect(f.bindings.get(next.sessionId)?.lastSyncedAtMs).toBeUndefined()
})


it('detects physical source drift without a session event after an earlier successful sync', async () => {
  const f = await fixture()
  expect((await f.sync.sync(A))?.phase).toBe('synced')
  f.events.get(A)?.push({ type: 'message', seq: 1, time: 1, data: 'external write' })
  f.persist(A)
  expect((await f.sync.inspect(A))?.phase).toBe('dirty')
  expect((await f.sync.sync(A))?.phase).toBe('synced')
  expect(f.uploads).toBe(2)
})

it('does not confirm a captured source changed during server comparison', async () => {
  const f = await fixture()
  await f.sync.sync(A)
  const confirmed = f.bindings.get(A)?.lastSyncedAtMs
  f.beforeStatus = async () => {
    f.events.get(A)?.push({ type: 'message', seq: 1, time: 1, data: 'external write' })
    f.persist(A)
  }
  expect((await f.sync.sync(A))?.phase).toBe('dirty')
  expect(f.bindings.get(A)?.lastSyncedAtMs).toBe(confirmed)
  expect(f.uploads).toBe(1)
})

it('refuses credentials appearing in the persisted source before any network call', async () => {
  const f = await fixture()
  await writeFile(f.path(A), zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: A }) + '\n' + JSON.stringify({ text: 'FAKE_TEST_ONLY_TOKEN' }) + '\n')))
  await expect(f.sync.sync(A)).rejects.toThrow('平台凭证')
  expect(f.fetcher).not.toHaveBeenCalled()
})
