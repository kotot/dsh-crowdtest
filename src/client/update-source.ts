import type { UpdateErrorCode, UpdateMethod, UpdateRemote, UpdateRemoteResult, UpdateView } from '../update-protocol.ts'

type Snapshot = {
  view?: UpdateView
  pending?: UpdateMethod
  offline: boolean
  actionError?: UpdateErrorCode
}
const initial: Snapshot = { offline: false }
export function canCheck(view: UpdateView) {
  return !['busy', 'restart-required', 'recovery-needed'].includes(view.status.kind)
}

export function createUpdateSource(remote: () => UpdateRemote, subscribeReset: (listener: () => void) => () => void) {
  const listeners = new Set<() => void>()
  let snapshot = initial
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let offReset: (() => void) | undefined
  let checkOnEntry = true
  const publish = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const read = () => execute('inspect', signal => remote().inspect({}, signal))
  const execute = async (method: UpdateMethod, call: (signal: AbortSignal) => Promise<UpdateRemoteResult>) => {
    if (!controller || snapshot.pending) return
    const { signal } = controller
    clearTimeout(timer)
    publish({ pending: method })
    try {
      const result = await call(signal)
      if (signal.aborted) return
      if (!result.ok) throw new Error()
      const view = result.value
      const eligible = ['idle', 'current', 'available', 'completed'].includes(view.status.kind) ||
        view.status.kind === 'failed' && view.status.code === 'recheck'
      const inspectOnEntry = method === 'inspect' && checkOnEntry && !snapshot.actionError && eligible
      if (method === 'inspect') checkOnEntry = false
      publish({ view, offline: false, actionError: method === 'inspect' ? snapshot.actionError : view.actionError })
      if (inspectOnEntry && canCheck(view)) {
        publish({ pending: 'check' })
        const checked = await remote().check({}, signal)
        if (signal.aborted) return
        if (!checked.ok) throw new Error()
        publish({ view: checked.value, actionError: checked.value.actionError })
      }
    } catch {
      if (!signal.aborted) publish({ offline: true })
    }
    finally {
      if (!signal.aborted) {
        publish({ pending: undefined })
        if (snapshot.view?.status.kind === 'busy' || snapshot.offline) timer = setTimeout(() => { void read() }, snapshot.offline ? 3000 : 1000)
      }
    }
  }
  const reconnect = () => {
    controller?.abort()
    controller = new AbortController()
    publish({ pending: undefined })
    void read()
  }
  const focus = () => { void read() }
  const stop = () => {
    controller?.abort()
    controller = undefined
    clearTimeout(timer)
    offReset?.()
    window.removeEventListener('focus', focus)
    snapshot = { ...initial, actionError: snapshot.actionError }
    checkOnEntry = true
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        controller = new AbortController()
        offReset = subscribeReset(reconnect)
        window.addEventListener('focus', focus)
        void read()
      }
      return () => { listeners.delete(listener); if (!listeners.size) stop() }
    },
    dispose() { if (listeners.size) stop(); listeners.clear() },
    check: () => execute('check', signal => remote().check({}, signal)),
    start: (candidateId: string) => execute('start', signal => remote().start({ candidateId }, signal)),
    reconnect: focus,
  }
}
export type UpdateSource = ReturnType<typeof createUpdateSource>
