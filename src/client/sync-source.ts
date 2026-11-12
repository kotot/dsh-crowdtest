import type { SyncView } from '../bridge.ts'
export type RemoteResult = { readonly ok: true; readonly value: SyncView | null } | { readonly ok: false }
export interface SyncSourceDeps {
  readonly inspect: (signal: AbortSignal) => Promise<RemoteResult>
  readonly sync: (signal: AbortSignal) => Promise<RemoteResult>
  readonly subscribeReset: (listener: () => void) => () => void
  readonly onActive?: (active: boolean) => void
  readonly pollMs?: number
  readonly visible?: () => boolean
  readonly subscribeActivation?: (listener: () => void) => () => void
}
export function createSyncSource(deps: SyncSourceDeps) {
  let snapshot: SyncView | null = null
  const listeners = new Set<() => void>()
  let generation = 0
  let mutation = 0
  let authority: SyncView | null = null
  let abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposeReset: (() => void) | undefined
  let disposeActivation: (() => void) | undefined
  let pending: Promise<void> | undefined
  const publish = (value: SyncView | null, authoritative = false) => {
    if (authoritative && authority && value && (value.bindingEpoch < authority.bindingEpoch || (value.bindingEpoch === authority.bindingEpoch && value.revision < authority.revision))) return
    if (authoritative) authority = value
    snapshot = value
    for (const listener of listeners) listener()
  }
  const unknown = () => { if (snapshot) publish({ ...snapshot, phase: 'unknown' }) }
  const schedule = () => {
    if (!listeners.size) return
    clearTimeout(timer)
    timer = setTimeout(() => { void read() }, deps.pollMs ?? 5_000)
  }
  const read = async () => {
    if (pending || !listeners.size) return
    if (deps.visible?.() === false) { schedule(); return }
    const started = generation
    const startedMutation = mutation
    const operation = (async () => {
      try {
        const result = await deps.inspect(abort.signal)
        if (started !== generation || startedMutation !== mutation) return
        if (result.ok && result.value !== undefined) publish(result.value, true)
        else unknown()
      } catch { if (started === generation && startedMutation === mutation) unknown() }
    })().finally(() => { if (pending === operation) pending = undefined; if (started === generation) schedule() })
    pending = operation
    await operation
  }
  const reset = () => {
    generation++
    abort.abort()
    abort = new AbortController()
    pending = undefined
    authority = null
    clearTimeout(timer)
    if (snapshot) publish({ ...snapshot, phase: 'checking' })
    void read()
  }
  const stop = () => {
    generation++
    abort.abort()
    clearTimeout(timer)
    disposeReset?.()
    disposeActivation?.()
    pending = undefined
    snapshot = null
    authority = null
    deps.onActive?.(false)
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        abort = new AbortController()
        deps.onActive?.(true)
        disposeReset = deps.subscribeReset(reset)
        disposeActivation = deps.subscribeActivation?.(reset)
        void read()
      }
      return () => { listeners.delete(listener); if (!listeners.size) stop() }
    },
    async sync() {
      if (snapshot?.phase === 'uploading' || !listeners.size) return
      const started = generation
      const startedBinding = snapshot?.bindingEpoch
      mutation++
      if (snapshot) publish({ ...snapshot, phase: 'uploading' })
      try {
        const result = await deps.sync(abort.signal)
        if (started !== generation) return
        if (result.ok && result.value !== undefined) {
          if (result.value !== null || snapshot?.bindingEpoch === startedBinding) publish(result.value, true)
        } else if (snapshot && snapshot.bindingEpoch === startedBinding) publish({ ...snapshot, phase: 'failed' })
      } catch { if (started === generation && snapshot && snapshot.bindingEpoch === startedBinding) publish({ ...snapshot, phase: 'failed' }) }
    },
    dispose() { stop(); listeners.clear() },
  }
}
