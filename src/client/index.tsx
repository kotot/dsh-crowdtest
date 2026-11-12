import React from 'react'
import { PLUGIN_VERSION } from '../version.ts'
import { contribution, type SyncRequest } from '../bridge.ts'
import { createSyncSource, type RemoteResult } from './sync-source.ts'
import { CrowdtestDock, type DockProps } from './sync-dock.tsx'

const BUNDLE_NAME = 'dsh-crowdtest'

interface ClientSlots {
  inject(name: string, register: () => () => void): void
  register(options: { name: string; key: string }, component: React.ComponentType): () => void
  register(options: { name: string; id: string; order: number; inject: (sessionId: string) => unknown }, component: React.ComponentType<DockProps>): () => void
}
interface ClientContext {
  readonly slots: ClientSlots
  readonly remote: {
    $mount(value: typeof contribution): Promise<() => Promise<void>>
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

const STEPS = [
  '在 CrowdTest 评测页点击「在本机运行」，复制带平台地址的完整领取命令。',
  '在任意会话中粘贴并发送 /crowdtest <领取口令> <平台地址>。插件会创建任务工作区、下载附件、配置测试模型，并在新会话中发送首轮任务。',
  '在新会话中完成任务。每轮对话结束后，插件会自动把会话备份上传到平台。',
  '如需立即补传，在任务会话中发送 /crowdtest-upload；然后回到平台上传产物并提交评测。',
]

function CrowdtestPanel(): React.JSX.Element {
  return (
    <section aria-label="CrowdTest 使用说明" style={{ display: 'grid', gap: 8, fontSize: 13, lineHeight: 1.6 }}>
      <strong>参加 CrowdTest 众测</strong>
      <span>当前插件版本 {PLUGIN_VERSION}</span>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        {STEPS.map(step => <li key={step}>{step}</li>)}
      </ol>
      <span style={{ opacity: 0.7 }}>
        任务会话只能使用平台下发的匿名模型；领取口令只能使用一次，过期后请在评测页重新生成。
      </span>
      <strong>更新插件</strong>
      <span>
        在 GitHub Releases 下载新版 dsh-crowdtest.tgz。先同步任务会话，再在插件页卸载旧版、添加新下载的本地安装包并启用。
      </span>
    </section>
  )
}

export async function apply(ctx: ClientContext): Promise<void> {
  await ctx.remote.$mount(contribution)
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
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
    { name: 'plugins.bundle.config', key: BUNDLE_NAME },
    CrowdtestPanel,
  ))
}
