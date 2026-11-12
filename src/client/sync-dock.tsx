import React from 'react'
import type { SyncView } from '../bridge.ts'
import { formatLastSync, SYNC_PRESENTATION } from './sync-presentation.ts'

export interface DockProps {
  useCrowdtestSync: (selector: (view: SyncView | null) => SyncView | null) => SyncView | null
  onSync: () => Promise<void>
}

const styles = `
[data-crowdtest-sync] {
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  width: calc(100% - 2 * var(--dsh-composer-side-clearance, 16px));
  max-width: var(--dsh-composer-card-max-width, 952px);
  margin: 0 auto calc(-1 * var(--dsh-composer-stack-gap, 6px));
  padding: 10px 14px;
  border: 1px solid var(--dsw-alias-border-l2, #dfe2e8);
  border-radius: var(--dsw-radius-panel, 16px) var(--dsw-radius-panel, 16px) 0 0;
  background: color-mix(in srgb, var(--dsw-specific-input-major, #fff) 96%, var(--dsw-alias-label-primary, #25282f) 4%);
  color: var(--dsw-alias-label-primary, #25282f);
  font-family: var(--dsw-font-family, inherit);
  font-size: 12px;
  line-height: 20px;
}
[data-crowdtest-sync] .crowdtest-sync-identity {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 12px;
  min-width: 0;
}
[data-crowdtest-sync] strong { font-size: 13px; font-weight: 600; }
[data-crowdtest-sync] .crowdtest-sync-meta {
  color: var(--dsw-alias-label-secondary, #666d79);
  overflow-wrap: anywhere;
}
[data-crowdtest-sync] .crowdtest-sync-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px 12px;
  margin-left: auto;
}
[data-crowdtest-sync] .crowdtest-sync-age {
  color: var(--dsw-alias-label-tertiary, #858b97);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
[data-crowdtest-sync] .crowdtest-sync-status {
  color: var(--dsw-alias-label-secondary, #666d79);
  white-space: nowrap;
}
[data-crowdtest-sync] [data-tone="success"] { color: var(--dsw-alias-state-success-primary, #299866); }
[data-crowdtest-sync] [data-tone="pending"] { color: var(--dsw-alias-state-business-primary, #3964fe); }
[data-crowdtest-sync] [data-tone="warning"] { color: var(--dsw-alias-state-warn-label, #ba7429); }
[data-crowdtest-sync] button {
  min-height: 28px;
  padding: 3px 14px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3964fe) 10%, transparent);
  color: var(--dsw-alias-state-business-primary, #3964fe);
  font: inherit;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 120ms ease;
}
[data-crowdtest-sync] button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3964fe) 18%, transparent);
}
[data-crowdtest-sync] button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #3964fe);
  outline-offset: 2px;
}
[data-crowdtest-sync] button:disabled { opacity: .55; cursor: default; }
[data-slot="conversation.input.dock"]:has([data-crowdtest-sync]) + [data-slot="conversation.composer.bar"] [data-composer-card] {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
@media (prefers-reduced-motion: reduce) {
  [data-crowdtest-sync] button { transition: none; }
}
`

export function LastSuccessfulSync({ lastSyncedAtMs, uploadedAtMs }: { lastSyncedAtMs: number | null; uploadedAtMs: number | null }): React.JSX.Element {
  const [nowMs, setNowMs] = React.useState(Date.now)
  React.useEffect(() => {
    const timer = setInterval(() => { setNowMs(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [])
  const title = `同步确认时间：${lastSyncedAtMs === null ? '未记录' : new Date(lastSyncedAtMs).toLocaleString()}\n备份上传时间：${uploadedAtMs === null ? '未知' : new Date(uploadedAtMs).toLocaleString()}`
  if (lastSyncedAtMs === null) return <span className="crowdtest-sync-age" title={title}>{uploadedAtMs === null ? formatLastSync(null, 0) : '尚无同步确认记录'}</span>
  return <time className="crowdtest-sync-age" dateTime={new Date(lastSyncedAtMs).toISOString()} title={title}>{formatLastSync(lastSyncedAtMs, nowMs)}</time>
}

type ManualSyncAction =
  | { readonly kind: 'pending' | 'settled'; readonly uploadedAtMs: number | null }
  | { readonly kind: 'completed'; readonly message: '已是最新' | '同步完成' }

export function CrowdtestDock({ useCrowdtestSync, onSync }: DockProps): React.JSX.Element | null {
  const view = useCrowdtestSync(value => value)
  return view === null ? null : <BoundCrowdtestDock key={`${view.sessionId}:${view.taskId}:${view.runId}:${view.bindingEpoch}`} view={view} onSync={onSync} />
}

function BoundCrowdtestDock({ view, onSync }: { view: SyncView; onSync: DockProps['onSync'] }): React.JSX.Element {
  const [action, setAction] = React.useState<ManualSyncAction | null>(null)
  const request = React.useRef(0)
  React.useLayoutEffect(() => () => { request.current++ }, [])
  React.useLayoutEffect(() => {
    if (view.phase !== 'synced' && view.phase !== 'uploading') {
      request.current++
      setAction(null)
    } else if (view.phase === 'uploading') {
      setAction(current => current?.kind === 'completed' ? null : current)
    }
  }, [view.phase, view.revision])
  React.useLayoutEffect(() => {
    if (action?.kind === 'settled' && view.phase === 'synced') {
      setAction({ kind: 'completed', message: view.uploadedAtMs === action.uploadedAtMs ? '已是最新' : '同步完成' })
    }
  }, [action, view])
  const presentation = SYNC_PRESENTATION[view.phase]
  const hasSyncHistory = view.lastSyncedAtMs !== null || view.uploadedAtMs !== null
  const label = view.phase === 'dirty' && !hasSyncHistory ? '尚未同步' : presentation.label
  const busy = presentation.busy || action?.kind === 'pending'
  const sync = async () => {
    const started = ++request.current
    const uploadedAtMs = view.uploadedAtMs
    setAction({ kind: 'pending', uploadedAtMs })
    try {
      await onSync()
      if (request.current === started) setAction({ kind: 'settled', uploadedAtMs })
    } catch {
      if (request.current === started) setAction(null)
    }
  }
  return (
    <section aria-label="CrowdTest 会话同步" data-crowdtest-sync="" data-session-id={view.sessionId}>
      <style>{styles}</style>
      <div className="crowdtest-sync-identity">
        <strong>CrowdTest</strong>
        <span className="crowdtest-sync-meta">任务 {view.taskId} · 运行时 {view.runId}</span>
      </div>
      <div className="crowdtest-sync-actions">
        {(view.phase !== 'dirty' || hasSyncHistory) && <LastSuccessfulSync key={view.sessionId} lastSyncedAtMs={view.lastSyncedAtMs} uploadedAtMs={view.uploadedAtMs} />}
        <span className="crowdtest-sync-status" data-tone={presentation.tone} role="status" aria-live="polite">{action?.kind === 'completed' && view.phase === 'synced' ? action.message : label}</span>
        <button type="button" disabled={busy} aria-busy={busy} onClick={() => { void sync() }}>
          {busy ? '同步中' : presentation.action}
        </button>
      </div>
    </section>
  )
}
