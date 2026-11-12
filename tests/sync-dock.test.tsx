import type { EffectCallback } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => {
  const effects: EffectCallback[] = []
  return { effects, setNow: vi.fn(), jsx: vi.fn((..._args: unknown[]) => null) }
})
vi.mock('react', () => ({ default: {
  useState: (initialize: () => number) => [initialize(), hooks.setNow],
  useEffect: (effect: EffectCallback) => { hooks.effects.push(effect) },
} }))
vi.mock('react/jsx-runtime', () => ({ jsx: hooks.jsx, jsxs: hooks.jsx }))
vi.mock('react/jsx-dev-runtime', () => ({ jsxDEV: hooks.jsx }))
import { LastSuccessfulSync } from '../src/client/sync-dock.tsx'

const backup = Date.UTC(2026, 10, 6, 12)
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(backup + 130_000)
  hooks.effects.length = 0
  vi.clearAllMocks()
})
afterEach(() => { vi.useRealTimers() })

it('updates relative sync confirmation age every second and releases its timer on unmount', () => {
  LastSuccessfulSync({ lastSyncedAtMs: backup, uploadedAtMs: backup - 1000 })
  expect(hooks.jsx.mock.calls.map(call => call.slice(0, 2))).toContainEqual(['time', expect.objectContaining({ children: '上次同步 · 2m 10s 前' })])
  const effect = hooks.effects[0]
  expect(effect).toBeDefined()
  if (effect === undefined) throw new Error('missing effect')
  const cleanup = effect()
  expect(vi.getTimerCount()).toBe(1)
  vi.advanceTimersByTime(2000)
  expect(hooks.setNow.mock.calls).toEqual([[backup + 131_000], [backup + 132_000]])
  if (typeof cleanup !== 'function') throw new Error('missing timer cleanup')
  cleanup()
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(2000)
  expect(hooks.setNow).toHaveBeenCalledTimes(2)
})
