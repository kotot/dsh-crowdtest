// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'

const own = { kind: 'bundle', pkg: { name: 'dsh-crowdtest', enabled: true } }
const base = { runningVersion: '0.2.15', installedVersion: '0.2.15', latestVersion: null, configured: false, status: { kind: 'idle' } }
const available = { ...base, configured: true, latestVersion: '0.2.16', status: { kind: 'available', candidateId: 'server-id' } }
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
  remote = { inspect: vi.fn(async () => respond()), check: vi.fn(async () => respond()), start: vi.fn(async () => respond()),
    saveCredential: vi.fn(async () => respond()), removeCredential: vi.fn(async () => respond()) }
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
  expect(remote.check).not.toHaveBeenCalled()
  await render({ kind: 'row' })
  expect(reset).toBeUndefined()
})

it('opens only credential setup, clears its masked input and automatically offers the pinned update in native header slots', async () => {
  await render(own)
  expect(element.querySelector('input')).toBeNull()
  expect(element.querySelector('[data-slot=section]').textContent).toBe('')
  await click(button('检查更新'))
  const input = element.querySelector('input')
  expect(document.activeElement).toBe(input)
  expect(input.type).toBe('password')
  expect(input.value).toBe('')
  input.value = 'dummy-test-credential'
  remote.saveCredential.mockResolvedValueOnce({ ok: true, value: { ...base, configured: true } })
  view = available
  await click(button('保存令牌'))
  expect(input.value).toBe('')
  expect(remote.saveCredential).toHaveBeenCalledWith({ token: 'dummy-test-credential' }, expect.any(AbortSignal))
  expect(element.innerHTML).not.toContain('dummy-test-credential')
  expect(element.querySelector('input')).toBeNull()
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

it('keeps configured credentials replaceable and removable from the collapsed section', async () => {
  view = available
  await render(own)
  const details = element.querySelector('details')
  expect(details.open).toBe(false)
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(button('保存令牌')).toBeDefined()
  expect(button('移除令牌')).toBeDefined()
  view = base
  await click(button('移除令牌'))
  expect(remote.removeCredential).toHaveBeenCalledTimes(1)
  expect(element.querySelector('input')).toBeNull()
  expect(button('检查更新')).toBeDefined()
})

it('keeps a failed token replacement visible without checking with the old token', async () => {
  view = available
  await render(own)
  const details = element.querySelector('details')
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  element.querySelector('input').value = 'replacement'
  const failure = { ...available, status: { kind: 'failed', code: 'credentialStore' }, actionError: 'credentialStore' }
  remote.saveCredential.mockResolvedValueOnce({ ok: true, value: failure })
  await click(button('保存令牌'))
  expect(remote.check).toHaveBeenCalledTimes(1)
  expect(element.querySelector('input')).not.toBeNull()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(element.querySelector('[role=status]').textContent).toContain('凭据')
  expect(button('更新到 0.2.16')).toBeUndefined()
})

it('preserves an install failure on reentry until the user explicitly retries', async () => {
  view = { ...base, configured: true, status: { kind: 'failed', code: 'install' } }
  await render(own)
  expect(remote.check).not.toHaveBeenCalled()
  expect(element.querySelector('[role=status]').textContent).toContain('DSH 未能完成安装')
  view = available
  await click(button('检查更新'))
  expect(remote.check).toHaveBeenCalledTimes(1)
  expect(button('更新到 0.2.16')).toBeDefined()
})

it.each(['saveCredential', 'removeCredential'])('preserves an unconfirmed %s result through reconnect and focus', async method => {
  view = available
  await render(own)
  const details = element.querySelector('details')
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  const input = element.querySelector('input')
  input.value = 'fixture-replacement'
  if (method === 'saveCredential') remote[method].mockRejectedValueOnce(Error('fixture transport failure'))
  else remote[method].mockResolvedValueOnce({ ok: false })
  await click(button(method === 'saveCredential' ? '保存令牌' : '移除令牌'))
  await act(async () => reset())
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(remote.check).toHaveBeenCalledTimes(1)
  expect(element.querySelector('[role=status]')?.textContent).toContain(method === 'saveCredential' ? '是否已保存' : '是否已移除')
  expect(button('更新到 0.2.16')).toBeUndefined()
})

it.each([
  ['saveCredential', 'reset'], ['removeCredential', 'reset'],
  ['saveCredential', 'unmount'], ['removeCredential', 'unmount'],
])('preserves pending %s as unconfirmed across %s', async (method, interruption) => {
  const request = Promise.withResolvers()
  view = available
  await render(own)
  const details = element.querySelector('details')
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  element.querySelector('input').value = 'pending-fixture'
  remote[method].mockReturnValueOnce(request.promise)
  await click(button(method === 'saveCredential' ? '保存令牌' : '移除令牌'))
  const signal = remote[method].mock.calls[0][1]
  if (interruption === 'reset') await act(async () => reset())
  else { await render({ kind: 'row' }); await render(own) }
  expect(signal.aborted).toBe(true)
  await act(async () => request.resolve({ ok: true, value: available }))
  expect(element.querySelector('[role=status]').textContent).toContain(method === 'saveCredential' ? '是否已保存' : '是否已移除')
  expect(remote.check).toHaveBeenCalledTimes(1)
  expect(button('更新到 0.2.16')).toBeUndefined()
})

it('keeps an acknowledged credential save when only its following check is interrupted', async () => {
  const checking = Promise.withResolvers()
  await render(own)
  await click(button('检查更新'))
  element.querySelector('input').value = 'pending-check-fixture'
  view = available
  remote.check.mockReturnValueOnce(checking.promise)
  await click(button('保存令牌'))
  const signal = remote.check.mock.calls[0][1]
  await act(async () => reset())
  expect(signal.aborted).toBe(true)
  await act(async () => checking.resolve({ ok: true, value: available }))
  expect(element.textContent).not.toContain('未能确认')
  expect(button('更新到 0.2.16')).toBeDefined()
})
