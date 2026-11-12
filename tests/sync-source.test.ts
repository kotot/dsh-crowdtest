import { afterEach, expect, it, vi } from 'vitest'
import type { SyncView } from '../src/bridge.ts'
import { createSyncSource } from '../src/client/sync-source.ts'
const A = '5bceb58e-601f-5e17-9607-32d954f16455'
const B = '6bceb58e-601f-5e17-9607-32d954f16456'
const view = (id = A, revision = 1): SyncView => ({ sessionId: id, taskId: 21, runId: 31, bindingEpoch: 1, revision, phase: 'synced', uploadedAtMs: 1234, lastSyncedAtMs: null })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
afterEach(() => vi.useRealTimers())
it('does not let a late A response populate B after switching and releases reset/timer listeners', async () => {
  const a = deferred<{ok: boolean; value: SyncView}>()
  const resetDisposer = vi.fn()
  const ASource = createSyncSource({ inspect: () => a.promise, sync: async () => ({ ok: true, value: view() }), subscribeReset: () => resetDisposer })
  const disposeA = ASource.subscribe(() => {})
  disposeA()
  const BSource = createSyncSource({ inspect: async () => ({ ok: true, value: view(B) }), sync: async () => ({ ok: true, value: view(B) }), subscribeReset: () => () => {} })
  const disposeB = BSource.subscribe(() => {})
  await vi.waitFor(() => expect(BSource.getSnapshot()?.sessionId).toBe(B))
  a.resolve({ ok: true, value: view() })
  await Promise.resolve()
  expect(ASource.getSnapshot()).toBeNull(); expect(BSource.getSnapshot()?.sessionId).toBe(B); expect(resetDisposer).toHaveBeenCalledTimes(1)
  disposeB()
})
it('refreshes after reconnect and never preserves synced when authority fails', async () => {
  let reset = () => {}
  const inspect = vi.fn(async () => ({ ok: true, value: view() }))
  const source = createSyncSource({ inspect, sync: async () => ({ ok: true, value: view() }), subscribeReset: listener => { reset = listener; return () => {} } })
  const dispose = source.subscribe(() => {})
  await vi.waitFor(() => expect(source.getSnapshot()?.phase).toBe('synced'))
  inspect.mockRejectedValueOnce(new Error('offline'))
  reset()
  expect(source.getSnapshot()?.phase).toBe('checking')
  await vi.waitFor(() => expect(source.getSnapshot()?.phase).toBe('unknown'))
  expect(inspect).toHaveBeenCalledTimes(2)
  dispose(); expect(source.getSnapshot()).toBeNull()
})
it('hides unbound sessions and fences stale poll results after manual sync', async () => {
  const poll = deferred<{ok: boolean; value: SyncView}>()
  const inspect = vi.fn().mockResolvedValueOnce({ ok: true, value: null }).mockResolvedValueOnce({ ok: true, value: view() }).mockImplementationOnce(() => poll.promise)
  let reset = () => {}
  const source = createSyncSource({ inspect, sync: async () => ({ ok: true, value: { ...view(A, 5), phase: 'dirty' } }), subscribeReset: listener => { reset = listener; return () => {} } })
  const dispose = source.subscribe(() => {})
  await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1)); expect(source.getSnapshot()).toBeNull()
  reset(); await vi.waitFor(() => expect(source.getSnapshot()?.phase).toBe('synced'))
  reset(); await source.sync()
  poll.resolve({ ok: true, value: view(A, 2) })
  await Promise.resolve(); expect(source.getSnapshot()?.phase).toBe('dirty'); expect(source.getSnapshot()?.revision).toBe(5)
  dispose()
})
it('polls sequentially only while visible and coalesces repeated manual clicks', async () => {
  vi.useFakeTimers()
  const upload = deferred<{ok: boolean; value: SyncView}>()
  let visible = true
  const inspect = vi.fn(async () => ({ ok: true, value: view() }))
  const sync = vi.fn(() => upload.promise)
  const source = createSyncSource({ inspect, sync, subscribeReset: () => () => {}, visible: () => visible, pollMs: 100 })
  const dispose = source.subscribe(() => {})
  await vi.advanceTimersByTimeAsync(0)
  visible = false
  await vi.advanceTimersByTimeAsync(300)
  expect(inspect).toHaveBeenCalledTimes(1)
  visible = true
  await vi.advanceTimersByTimeAsync(100)
  expect(inspect).toHaveBeenCalledTimes(2)
  const first = source.sync(); await source.sync(); expect(sync).toHaveBeenCalledTimes(1)
  upload.resolve({ ok: true, value: view(A, 4) }); await first
  dispose(); await vi.advanceTimersByTimeAsync(500)
  expect(inspect).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0)
})
it('accepts a fresh Host epoch after reconnect instead of keeping an old synced proof', async () => {
  let reset = () => {}
  const inspect = vi.fn().mockResolvedValueOnce({ ok: true, value: { ...view(A, 9), bindingEpoch: 5 } }).mockResolvedValueOnce({ ok: true, value: { ...view(A, 1), bindingEpoch: 1, phase: 'dirty' } })
  const source = createSyncSource({ inspect, sync: inspect, subscribeReset: listener => { reset = listener; return () => {} } })
  const dispose = source.subscribe(() => {})
  await vi.waitFor(() => expect(source.getSnapshot()?.bindingEpoch).toBe(5))
  reset()
  await vi.waitFor(() => expect(source.getSnapshot()?.phase).toBe('dirty'))
  expect(source.getSnapshot()?.bindingEpoch).toBe(1)
  dispose()
})
it('does not apply an old upload failure to a newer binding', async () => {
  vi.useFakeTimers()
  const upload = deferred<{ok: false}>()
  const inspect = vi.fn().mockResolvedValueOnce({ ok: true, value: view() }).mockResolvedValue({ ok: true, value: { ...view(A, 2), bindingEpoch: 2 } })
  const source = createSyncSource({ inspect, sync: () => upload.promise, subscribeReset: () => () => {}, pollMs: 100 })
  const dispose = source.subscribe(() => {})
  await vi.advanceTimersByTimeAsync(0)
  const pending = source.sync()
  await vi.advanceTimersByTimeAsync(100)
  expect(source.getSnapshot()?.bindingEpoch).toBe(2)
  upload.resolve({ ok: false }); await pending
  expect(source.getSnapshot()?.phase).toBe('synced')
  dispose()
})
