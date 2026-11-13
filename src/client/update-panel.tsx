import React, { useSyncExternalStore } from 'react'
import { Button, IconRefreshOutlineRegular, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { PACKAGE, updateErrors, type Phase, type UpdateView } from '../update-protocol.ts'
import { canCheck, type UpdateSource } from './update-source.ts'

export interface DetailProps {
  subject: { kind: string; pkg?: { name: string; enabled: boolean } }
}
const stages: Record<Phase, string> = {
  checking: '正在核对发布信息', downloading: '正在下载安装包', validating: '正在校验安装包',
  backup: '正在验证并保存原版本', installing: 'DSH 正在安装', restoring: '正在还原原版本',
}
function statusText(view: UpdateView): string {
  const status = view.status
  switch (status.kind) {
    case 'idle': case 'available': return ''
    case 'verify-install': return '检测到独立安装的版本。点击「检查更新」可重新核对当前安装包。'
    case 'busy': return `${stages[status.phase]}。请等更新结束后再卸载或切换启用状态；其他窗口也请稍候。`
    case 'current': return `已是最新版本（${view.runningVersion}）。`
    case 'restart-required': return `已安装 ${view.installedVersion ?? ''}。请完全退出并重新打开 DSH，当前运行版本为 ${view.runningVersion}。`
    case 'completed': return `更新完成，新版本 ${view.runningVersion} 正在运行。`
    case 'failed': return updateErrors[status.code]
    case 'restored': return '安装失败，已还原并验证原版本。'
    case 'recovery-needed': return `请核对当前插件版本和启用状态。如需还原，可在插件页添加当前 DSH 配置目录 .crowdtest-updater/${status.jobId}/ 中以 previous- 开头的 .tgz 安装包，然后重启 DSH。`
  }
}
type SourceProps = { source: UpdateSource }
function Badge({ source }: SourceProps) {
  const { view, offline, actionError } = useSyncExternalStore(source.subscribe, source.getSnapshot)
  if (offline) return null
  const failure = actionError ?? (view?.status.kind === 'failed' ? view.status.code : undefined)
  if (failure) return <small>{updateErrors[failure]}</small>
  return view?.status.kind === 'available' ? <Tag tone="info">可更新</Tag> : null
}
function Actions({ source }: SourceProps) {
  const { view, pending, offline, actionError } = useSyncExternalStore(source.subscribe, source.getSnapshot)
  if (!view && !offline) return null
  const icon = <IconRefreshOutlineRegular size={13} />
  if (offline) return <Button variant="outline" size="sm" icon={icon} disabled={!!pending} onClick={source.reconnect}>重新连接</Button>
  if (pending === 'start' || view?.status.kind === 'busy') return <Button variant="primary" size="sm" icon={icon} disabled>正在更新…</Button>
  if (!view || !canCheck(view)) return null
  const candidate = !pending && !actionError && view.status.kind === 'available' ? view.status.candidateId : undefined
  if (candidate && view.latestVersion) return <Button variant="primary" size="sm" icon={icon}
    onClick={() => { void source.start(candidate) }}>更新到 {view.latestVersion}</Button>
  return <Button variant="outline" size="sm" icon={icon} disabled={!!pending} onClick={() => { void source.check() }}>
    检查更新
  </Button>
}
function Section({ source }: SourceProps) {
  const { view, offline, actionError } = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const message = actionError ? updateErrors[actionError] : offline ? '正在重新连接更新服务…' : view && statusText(view)
  return <section aria-label="CrowdTest 插件更新" data-crowdtest-update>
    {message && <p role="status" aria-live="polite">{message}</p>}
  </section>
}

export function updateDetailSlots(source: UpdateSource) {
  const eligible = (Component: React.ComponentType<SourceProps>, showDisabled = false) => ({ subject }: DetailProps) => {
    if (subject.kind !== 'bundle' || subject.pkg?.name !== PACKAGE) return null
    if (!subject.pkg.enabled) return showDisabled ? <span>启用插件后可检查更新。</span> : null
    return <Component source={source} />
  }
  return { badge: eligible(Badge), actions: eligible(Actions), section: eligible(Section, true) }
}
