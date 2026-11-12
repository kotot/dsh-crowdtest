import React from 'react'
import { updateDetailSlots, type DetailProps } from './update-panel.tsx'
import { createUpdateSource } from './update-source.ts'
import type { UpdateRemote } from '../update-protocol.ts'
import { contribution, type SyncRequest } from '../bridge.ts'
import { createSyncSource, type RemoteResult } from './sync-source.ts'
import { CrowdtestDock, type DockProps } from './sync-dock.tsx'

interface ClientSlots {
  register(options: { name: string; id: string; order: number }, component: React.ComponentType<Pick<DetailProps, 'subject'>>): () => void
  inject(name: string, register: () => () => void): void
  register(options: { name: string; id: string; order: number; inject: (sessionId: string) => unknown }, component: React.ComponentType<DockProps>): () => void
}
interface ClientContext {
  readonly slots: ClientSlots
  readonly remote: {
    $mount(value: typeof contribution): Promise<() => Promise<void>>
    readonly crowdtestUpdate: UpdateRemote
    readonly crowdtestSync: {
      inspect(request: SyncRequest, signal: AbortSignal): Promise<RemoteResult>
      sync(request: SyncRequest, signal: AbortSignal): Promise<RemoteResult>
    }
  }
  inject(services: string[], apply: (scope: ClientContext) => void): unknown
  on(event: 'connection/reset', listener: () => void): () => void
  effect(execute: () => () => void): void
}
export const inject = ['slots', 'remote', 'uiConversation']

export async function apply(ctx: ClientContext): Promise<void> {
  await ctx.remote.$mount(contribution)
  await ctx.inject(['remote.crowdtestUpdate'], scope => {
    const source = createUpdateSource(() => scope.remote.crowdtestUpdate, listener => scope.on('connection/reset', listener))
    scope.effect(() => () => source.dispose())
    for (const [slot, Component] of Object.entries(updateDetailSlots(source))) {
      const name = `plugins.detail.${slot}`
      scope.slots.inject(name, () => scope.slots.register({ name, id: `crowdtest-update-${slot}`, order: 30 }, Component))
    }
  })
  await ctx.inject(['remote.crowdtestSync'], scope => {
    const sources = new Set<ReturnType<typeof createSyncSource>>()
    scope.effect(() => () => { for (const source of sources) source.dispose(); sources.clear() })
    scope.slots.inject('conversation.input.dock', () => scope.slots.register({
      name: 'conversation.input.dock', id: 'crowdtest-sync', order: 20,
      inject: (sessionId) => {
        const source = createSyncSource({
          onActive: active => { if (active) sources.add(source); else sources.delete(source) },
          inspect: signal => scope.remote.crowdtestSync.inspect({ sessionId }, signal),
          sync: signal => scope.remote.crowdtestSync.sync({ sessionId }, signal),
          subscribeReset: listener => scope.on('connection/reset', listener),
          visible: () => document.visibilityState !== 'hidden',
          subscribeActivation: listener => {
            window.addEventListener('focus', listener)
            document.addEventListener('visibilitychange', listener)
            return () => { window.removeEventListener('focus', listener); document.removeEventListener('visibilitychange', listener) }
          },
        })
        return { hooks: { crowdtestSync: source }, onSync: () => source.sync() }
      },
    }, CrowdtestDock))
  })
}
