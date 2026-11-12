import { expect, it, vi } from 'vitest'
vi.mock('react', () => ({ default: {} }))
vi.mock('react/jsx-dev-runtime', () => ({ jsxDEV: () => null }))
vi.mock('react/jsx-runtime', () => ({ jsx: () => null, jsxs: () => null }))
import { apply } from '../src/client/index.tsx'
type Context = Parameters<typeof apply>[0]
it('mounts before declaring the dynamic namespace dependency and uses its injected context', async () => {
  const inspect = vi.fn(async () => ({ ok: true, value: null }))
  let mounted = false
  let scopedCalls = 0
  const mount = vi.fn(async () => { mounted = true; return async () => {} })
  const disposals: Array<() => void> = []
  function context(scoped: boolean): Context {
    return {
      remote: {
        $mount: mount,
        get crowdtestUpdate(): Context['remote']['crowdtestUpdate'] { throw new Error('detail panel was not opened') },
        get crowdtestSync() {
          if (!scoped) throw new Error('cannot get property remote.crowdtestSync without inject')
          scopedCalls++
          return { inspect, sync: inspect }
        },
      },
      slots: {
        inject(_name, register) { disposals.push(register()) },
        register(options: {name: string; inject?: (id: string) => unknown}, _component: unknown) {
          if (options.name === 'conversation.input.dock' && options.inject) {
            const injected = options.inject('5bceb58e-601f-5e17-9607-32d954f16455') as { hooks: { crowdtestSync: { subscribe(listener: () => void): () => void } } }
            disposals.push(injected.hooks.crowdtestSync.subscribe(() => {}))
          }
          return () => {}
        },
      },
      inject(services, callback) { expect(mounted).toBe(true); expect([['remote.crowdtestSync'], ['remote.crowdtestUpdate']]).toContainEqual(services); callback(context(true)) },
      on: () => () => {},
      effect(execute) { disposals.push(execute()) },
    }
  }
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  try {
    await apply(context(false))
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1))
    expect(scopedCalls).toBe(1)
  } finally { for (const dispose of disposals.reverse()) dispose(); vi.unstubAllGlobals() }
})
