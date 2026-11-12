import type { SyncPhase } from '../bridge.ts'

interface PhasePresentation {
  readonly label: string
  readonly action: string
  readonly tone: 'neutral' | 'success' | 'pending' | 'warning'
  readonly busy: boolean
}

export const SYNC_PRESENTATION: Readonly<Record<SyncPhase, PhasePresentation>> = {
  checking: { label: '检查中', action: '立即同步', tone: 'neutral', busy: false },
  synced: { label: '已同步', action: '立即同步', tone: 'success', busy: false },
  dirty: { label: '有新内容待同步', action: '立即同步', tone: 'pending', busy: false },
  uploading: { label: '同步中', action: '同步中', tone: 'pending', busy: true },
  failed: { label: '同步失败', action: '重新同步', tone: 'warning', busy: false },
  unknown: { label: '无法确认', action: '重新同步', tone: 'warning', busy: false },
}

export function formatLastSync(syncedAtMs: number | null, nowMs: number): string {
  if (syncedAtMs === null) return '尚未同步'
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - syncedAtMs) / 1000))
  const seconds = elapsedSeconds % 60
  const minutes = Math.floor(elapsedSeconds / 60) % 60
  const hours = Math.floor(elapsedSeconds / 3600)
  const age = hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : elapsedSeconds >= 60 ? `${minutes}m ${seconds}s` : `${seconds}s`
  return `上次同步 · ${age} 前`
}
