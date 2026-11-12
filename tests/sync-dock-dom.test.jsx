// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CrowdtestDock } from '../src/client/sync-dock.tsx'

const backup = Date.UTC(2026, 10, 6, 12)
const initial = { sessionId: 'session-a', taskId: 12, runId: 31, bindingEpoch: 1, revision: 1, phase: 'synced', uploadedAtMs: backup, lastSyncedAtMs: null }
let container
let root
let current
let onSync

function render() {
  root.render(<CrowdtestDock useCrowdtestSync={selector => selector(current)} onSync={onSync} />)
}
async function update(changes) {
  await act(async () => {
    current = current === null ? changes : { ...current, ...changes }
    render()
  })
}
async function click() {
  await act(async () => { container.querySelector('button').click() })
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  current = { ...initial }
  onSync = vi.fn(async () => {})
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

it('resets the displayed clock after unchanged manual sync while retaining the server backup timestamp', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(backup + 60_000)
  onSync = vi.fn(async () => {
    current = { ...current, revision: current.revision + 1, lastSyncedAtMs: Date.now() }
    render()
  })
  await act(async () => { render() })
  expect(container.textContent).toContain('尚无同步确认记录')
  expect(container.querySelector('.crowdtest-sync-age').title).toContain('同步确认时间：未记录')
  await click()
  expect(onSync).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('已是最新')
  expect(container.textContent).toContain('上次同步 · 0s 前')
  expect(current.phase).toBe('synced')
  expect(current.uploadedAtMs).toBe(backup)
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
  expect(container.querySelector('time').dateTime).toBe(new Date(backup + 60_000).toISOString())
  expect(container.querySelector('time').title).toContain(`同步确认时间：${new Date(backup + 60_000).toLocaleString()}`)
  expect(container.querySelector('time').title).toContain(`备份上传时间：${new Date(backup).toLocaleString()}`)
  await act(async () => { vi.advanceTimersByTime(10_000) })
  await click()
  expect(onSync).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('上次同步 · 0s 前')
  expect(container.querySelector('time').dateTime).toBe(new Date(backup + 70_000).toISOString())
})

it('shows completion for a newly uploaded backup and keeps the authoritative phase', async () => {
  current = { ...initial, phase: 'dirty' }
  const pending = deferred()
  onSync = vi.fn(() => pending.promise)
  await act(async () => { render() })
  await click()
  expect(container.querySelector('[role="status"]').textContent).toBe('有新内容待同步')
  expect(container.querySelector('button').disabled).toBe(true)
  await update({ phase: 'uploading' })
  await act(async () => {
    current = { ...current, phase: 'synced', revision: 2, uploadedAtMs: backup + 1000, lastSyncedAtMs: backup + 2000 }
    render()
    pending.resolve()
  })
  expect(container.textContent).toContain('同步完成')
  expect(container.querySelector('time').dateTime).toBe(new Date(backup + 2000).toISOString())
  expect(container.querySelector('button').disabled).toBe(false)
})

it.each(['failed', 'unknown'])('preserves %s feedback without announcing success', async phase => {
  const pending = deferred()
  onSync = vi.fn(() => pending.promise)
  await act(async () => { render() })
  await click()
  await update({ phase })
  await act(async () => { pending.resolve() })
  expect(container.textContent).toContain(phase === 'failed' ? '同步失败' : '无法确认')
  expect(container.textContent).not.toMatch(/已是最新|同步完成/)
  expect(container.querySelector('button').disabled).toBe(false)
})

it('handles a rejected sync and allows retry without an unhandled rejection', async () => {
  onSync = vi.fn(async () => { throw new Error('disconnected') })
  await act(async () => { render() })
  await click()
  expect(container.textContent).not.toMatch(/已是最新|同步完成/)
  expect(container.querySelector('button').disabled).toBe(false)
  await click()
  expect(onSync).toHaveBeenCalledTimes(2)
})

it.each([
  ['session switch', { sessionId: 'session-b' }],
  ['binding change', { bindingEpoch: 2 }],
  ['task change', { taskId: 42 }],
  ['run change', { runId: 42 }],
  ['fresh content', { phase: 'dirty', revision: 2 }],
  ['disconnection', { phase: 'unknown' }],
  ['reconnection', { phase: 'checking' }],
])('discards pending completion after %s', async (_name, changes) => {
  const pending = deferred()
  onSync = vi.fn(() => pending.promise)
  await act(async () => { render() })
  await click()
  await update(changes)
  await update({ phase: 'synced' })
  await act(async () => { pending.resolve() })
  expect(container.textContent).not.toMatch(/已是最新|同步完成/)
  expect(container.querySelector('button').disabled).toBe(false)
  onSync = vi.fn(async () => {})
  await act(async () => { render() })
  await click()
  expect(container.textContent).toContain('已是最新')
})

it('clears a completed receipt for fresh content and does not restore it on automatic sync', async () => {
  await act(async () => { render() })
  await click()
  expect(container.textContent).toContain('已是最新')
  await update({ phase: 'dirty', revision: 2 })
  await update({ phase: 'synced', revision: 3, uploadedAtMs: backup + 1000 })
  expect(container.textContent).not.toMatch(/已是最新|同步完成/)
})

it('discards a completion after leaving the CrowdTest session', async () => {
  const pending = deferred()
  onSync = vi.fn(() => pending.promise)
  await act(async () => { render() })
  await click()
  await act(async () => { current = null; render() })
  expect(container.textContent).toBe('')
  await act(async () => { pending.resolve() })
  await update(initial)
  expect(container.textContent).not.toMatch(/已是最新|同步完成/)
})

it('shows the current session confirmation age and no clock before its first confirmation', async () => {
  await act(async () => { render() })
  await update({ sessionId: 'session-b', uploadedAtMs: backup - 120_000, lastSyncedAtMs: backup - 60_000 })
  expect(container.querySelector('time').dateTime).toBe(new Date(backup - 60_000).toISOString())
  await update({ phase: 'dirty', uploadedAtMs: null, lastSyncedAtMs: null })
  expect(container.querySelector('time')).toBeNull()
  expect(container.querySelector('[role="status"]').textContent).toBe('尚未同步')
  expect(container.textContent.match(/尚未同步/g)).toHaveLength(1)
})

it('ignores an old request finishing while a newer request is pending', async () => {
  const first = deferred()
  const second = deferred()
  onSync = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  await act(async () => { render() })
  await click()
  await update({ phase: 'unknown' })
  await update({ phase: 'synced' })
  await click()
  await act(async () => { first.resolve() })
  expect(container.querySelector('button').disabled).toBe(true)
  expect(container.textContent).not.toMatch(/已是最新|同步完成/)
  await act(async () => { second.resolve() })
  expect(container.textContent).toContain('已是最新')
})

it('keeps instant completion readable until new work or a session change', async () => {
  vi.useFakeTimers()
  await act(async () => { render() })
  await click()
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(container.textContent).toContain('已是最新')
  await update({ bindingEpoch: 2 })
  expect(container.textContent).not.toMatch(/已是最新|同步完成/)
  await click()
  await update({ sessionId: 'session-b' })
  expect(container.textContent).not.toMatch(/已是最新|同步完成/)
})

it('uses each session confirmation history even while its current contents are dirty', async () => {
  await act(async () => { render() })
  await update({ lastSyncedAtMs: backup + 1000 })
  expect(container.querySelector('time').dateTime).toBe(new Date(backup + 1000).toISOString())
  await update({ sessionId: 'session-b', lastSyncedAtMs: backup + 2000, phase: 'dirty' })
  expect(container.querySelector('time').dateTime).toBe(new Date(backup + 2000).toISOString())
  expect(container.querySelector('[role="status"]').textContent).toBe('有新内容待同步')
  await update({ sessionId: 'session-a', lastSyncedAtMs: backup + 1000, phase: 'dirty' })
  expect(container.querySelector('time').dateTime).toBe(new Date(backup + 1000).toISOString())
  expect(container.querySelector('[role="status"]').textContent).toBe('有新内容待同步')
})

it('does not label an unconfirmed backup as a successful sync', async () => {
  current = { ...initial, phase: 'dirty', uploadedAtMs: backup + 1000, lastSyncedAtMs: null }
  await act(async () => { render() })
  expect(container.querySelector('time')).toBeNull()
  expect(container.querySelector('[role="status"]').textContent).toBe('有新内容待同步')
  expect(container.textContent).toContain('尚无同步确认记录')
  expect(container.querySelector('.crowdtest-sync-age').title).toContain(`备份上传时间：${new Date(backup + 1000).toLocaleString()}`)
  await update({ phase: 'synced', revision: 2 })
  expect(container.querySelector('time')).toBeNull()
  expect(container.textContent).toContain('尚无同步确认记录')
})

it('changes from never synced to new content pending while retaining the first confirmation clock', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(backup + 60_000)
  current = { ...initial, phase: 'dirty', uploadedAtMs: null, lastSyncedAtMs: null }
  await act(async () => { render() })
  expect(container.querySelector('[role="status"]').textContent).toBe('尚未同步')
  expect(container.textContent.match(/尚未同步/g)).toHaveLength(1)
  expect(container.querySelector('time')).toBeNull()
  await update({ phase: 'synced', revision: 2, uploadedAtMs: backup, lastSyncedAtMs: backup + 60_000 })
  expect(container.querySelector('[role="status"]').textContent).toBe('已同步')
  await act(async () => { vi.advanceTimersByTime(10_000) })
  await update({ phase: 'dirty', revision: 3 })
  expect(container.querySelector('[role="status"]').textContent).toBe('有新内容待同步')
  expect(container.querySelector('time').dateTime).toBe(new Date(backup + 60_000).toISOString())
  expect(container.querySelector('time').textContent).toBe('上次同步 · 10s 前')
})

it('keeps a past confirmation visible for dirty content even when there is no server backup', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(backup + 60_000)
  current = { ...initial, phase: 'dirty', uploadedAtMs: null, lastSyncedAtMs: backup }
  await act(async () => { render() })
  expect(container.querySelector('[role="status"]').textContent).toBe('有新内容待同步')
  expect(container.querySelector('time').dateTime).toBe(new Date(backup).toISOString())
  expect(container.querySelector('time').textContent).toBe('上次同步 · 1m 0s 前')
})
