// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'

const own = { kind: 'bundle', pkg: { name: 'dsh-crowdtest', enabled: true } }
const base = { runningVersion: '0.2.15', installedVersion: '0.2.15', latestVersion: null, status: { kind: 'idle' } }
const available = { ...base, latestVersion: '0.2.16', status: { kind: 'available', candidateId: 'server-id' } }
let element, root, remote, view, reset, components, disposals
const button = text => [...element.querySelectorAll('button')].find(button => button.textContent === text)
const render = subject => act(async () => {
  root.render(<>{['badge', 'actions', 'section'].map(slot => {
    const Component = components.get('plugins.detail.' + slot)
    return <div data-slot={slot} key={slot}><Component subject={subject} /></div>
  })}</>)
})
const click = node => act(async () => node.click())
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
  view = base
  const respond = () => ({ ok: true, value: view })
  remote = { inspect: vi.fn(async () => respond()), check: vi.fn(async () => respond()), start: vi.fn(async () => respond()) }
  components = new Map()
  disposals = []
  const scope = {
    slots: {
      inject(_slot, register) { disposals.push(register()) },
      register({ name }, Component) { components.set(name, Component); return () => components.delete(name) },
    },
    remote: { $mount: async () => {}, crowdtestUpdate: remote },
    inject(_services, setup) { setup(scope) },
    effect(effect) { disposals.push(effect()) },
    on(_name, listener) { reset = listener; return () => { reset = undefined } },
  }
  await apply(scope)
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const dispose of disposals.reverse()) dispose()
  element.remove()
})

it('subscribes only for the enabled CrowdTest bundle and reconnects without showing remote errors', async () => {
  for (const subject of [{ kind: 'row', pkg: own.pkg }, { kind: 'bundle', pkg: { ...own.pkg, name: 'other' } }]) {
    await render(subject)
    expect(element.textContent).toBe('')
  }
  await render({ ...own, pkg: { ...own.pkg, enabled: false } })
  expect(element.textContent).toContain('启用插件后')
  expect(remote.inspect).not.toHaveBeenCalled()
  remote.inspect.mockRejectedValueOnce(Error('internal details'))
  await render(own)
  expect(element.textContent).toContain('重新连接')
  expect(element.textContent).not.toContain('internal details')
  await act(async () => reset())
  expect(button('检查更新')).toBeDefined()
  expect(remote.check).toHaveBeenCalledTimes(1)
  await render({ kind: 'row' })
  expect(reset).toBeUndefined()
})

it('automatically offers the pinned public update in native header slots without a setup form', async () => {
  view = available
  await render(own)
  expect(element.querySelector('input, form, details')).toBeNull()
  expect(element.textContent).not.toMatch(/令牌|Contents/)
  expect(remote.check).toHaveBeenCalledTimes(1)
  expect(element.querySelector('[data-slot=badge] [data-tone=info]').textContent).toBe('可更新')
  const update = element.querySelector('[data-slot=actions] button[data-variant=primary][data-size=sm]')
  expect(update.textContent).toBe('更新到 0.2.16')
  expect(update.querySelector('[data-icon=refresh]')).not.toBeNull()
  view = { ...available, status: { kind: 'busy', phase: 'installing' } }
  await click(update)
  expect(remote.start).toHaveBeenCalledWith({ candidateId: 'server-id' }, expect.any(AbortSignal))
  expect(element.querySelector('[data-slot=actions] button').textContent).toBe('正在更新…')
  expect(button('正在更新…').disabled).toBe(true)
  expect(element.querySelector('[role=status]').textContent).toContain('卸载或切换启用状态')
  expect(element.querySelector('[data-slot=badge]').textContent).toBe('')
  await render({ kind: 'row' })
  view = { ...available, installedVersion: '0.2.16', status: { kind: 'restart-required' } }
  await render(own)
  expect(element.textContent).toContain('完全退出并重新打开 DSH')
  expect(element.textContent).toContain('当前运行版本为 0.2.15')
  expect(remote.check).toHaveBeenCalledTimes(1)
})

it.each(['check', 'inspect'])('shows a disabled check action while %s refreshes an available version', async method => {
  view = available
  const request = Promise.withResolvers()
  if (method === 'check') remote.check.mockReturnValueOnce(request.promise)
  await render(own)
  if (method === 'inspect') {
    remote.inspect.mockReturnValueOnce(request.promise)
    await act(async () => window.dispatchEvent(new Event('focus')))
  }
  const action = element.querySelector('[data-slot=actions] button')
  expect(action.textContent).toBe('检查更新')
  expect(action.disabled).toBe(true)
  await click(action)
  expect(remote.start).not.toHaveBeenCalled()
  await act(async () => request.resolve({ ok: true, value: { ...available, latestVersion: '0.2.17' } }))
  expect(button('更新到 0.2.17').disabled).toBe(false)
})

it('coalesces one inspection and one automatic metadata check across three slots per detail visit', async () => {
  const gate = Promise.withResolvers()
  remote.inspect.mockReturnValueOnce(gate.promise)
  view = available
  await render(own)
  expect(remote.inspect).toHaveBeenCalledTimes(1)
  await act(async () => gate.resolve({ ok: true, value: available }))
  expect(remote.check).toHaveBeenCalledTimes(1)
  expect(button('更新到 0.2.16')).toBeDefined()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(remote.inspect).toHaveBeenCalledTimes(2)
  expect(remote.check).toHaveBeenCalledTimes(1)
  const signal = remote.inspect.mock.calls[0][1]
  await render({ ...own, pkg: { ...own.pkg, enabled: false } })
  expect(signal.aborted).toBe(true)
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(remote.inspect).toHaveBeenCalledTimes(2)
  await render(own)
  expect(remote.check).toHaveBeenCalledTimes(2)
})

it('preserves an install failure on reentry until the user explicitly retries', async () => {
  view = { ...base, status: { kind: 'failed', code: 'install' } }
  await render(own)
  expect(remote.check).not.toHaveBeenCalled()
  expect(element.querySelector('[role=status]').textContent).toContain('DSH 未能完成安装')
  view = available
  await click(button('检查更新'))
  expect(remote.check).toHaveBeenCalledTimes(1)
  expect(button('更新到 0.2.16')).toBeDefined()
})

it('automatically rechecks only a migrated legacy credential failure on entry', async () => {
  view = { ...base, status: { kind: 'failed', code: 'recheck' } }
  remote.check.mockResolvedValueOnce({ ok: true, value: available })
  await render(own)
  expect(remote.check).toHaveBeenCalledTimes(1)
  expect(button('更新到 0.2.16')).toBeDefined()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(remote.check).toHaveBeenCalledTimes(1)
})

it.each(['network', 'rate', 'access', 'state'])('leaves a %s failure for manual retry', async code => {
  view = { ...base, status: { kind: 'failed', code } }
  await render(own)
  expect(remote.check).not.toHaveBeenCalled()
  view = available
  await click(button('检查更新'))
  expect(remote.check).toHaveBeenCalledTimes(1)
  expect(button('更新到 0.2.16')).toBeDefined()
})

it.each(['reset', 'unmount'])('inspects accepted updates after %s without repeating start', async interruption => {
  const request = Promise.withResolvers()
  view = available
  await render(own)
  remote.start.mockReturnValueOnce(request.promise)
  await click(button('更新到 0.2.16'))
  expect(button('正在更新…').disabled).toBe(true)
  const signal = remote.start.mock.calls[0][1]
  view = { ...available, status: { kind: 'busy', phase: 'installing' } }
  if (interruption === 'reset') await act(async () => reset())
  else { await render({ kind: 'row' }); await render(own) }
  expect(signal.aborted).toBe(true)
  await act(async () => request.resolve({ ok: true, value: available }))
  expect(remote.start).toHaveBeenCalledTimes(1)
  expect(remote.check).toHaveBeenCalledTimes(1)
  expect(button('正在更新…').disabled).toBe(true)
})

it('suppresses a stale candidate after an action error until manual retry', async () => {
  view = available
  await render(own)
  remote.start.mockResolvedValueOnce({ ok: true, value: { ...available, status: { kind: 'failed', code: 'changed' }, actionError: 'changed' } })
  await click(button('更新到 0.2.16'))
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(button('更新到 0.2.16')).toBeUndefined()
  expect(element.querySelector('[data-slot=badge]').textContent).toContain('重新检查')
  expect(element.querySelector('[role=status]').textContent).toContain('重新检查')
  await click(button('检查更新'))
  expect(button('更新到 0.2.16')).toBeDefined()
})

it('shows an accepted job’s later failure in the header and checks again before offering install', async () => {
  vi.useFakeTimers()
  try {
    view = available
    await render(own)
    view = { ...available, status: { kind: 'busy', phase: 'checking' } }
    await click(button('更新到 0.2.16'))
    view = { ...available, status: { kind: 'failed', code: 'rate' } }
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(element.querySelector('[data-slot=badge]').textContent).toContain('限额')
    expect(element.querySelector('[data-slot=actions] button').textContent).toBe('检查更新')
    expect(element.querySelectorAll('[role=status]')).toHaveLength(1)
    view = { ...available, status: { kind: 'available', candidateId: 'fresh-id' } }
    await click(button('检查更新'))
    expect(remote.check).toHaveBeenCalledTimes(2)
    await click(button('更新到 0.2.16'))
    expect(remote.start).toHaveBeenLastCalledWith({ candidateId: 'fresh-id' }, expect.any(AbortSignal))
  } finally { vi.useRealTimers() }
})
