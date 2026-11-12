import { buildSessionArchive } from './archive.ts'
import { captureNativeSession, nativeSessionRevision, resolveNativeSessionRoot } from './native-session.ts'
import { CrowdtestBffClient, type ServerBackup } from './bff.ts'
import type { SyncPhase, SyncView } from './bridge.ts'
import type { DshContext } from './dsh.ts'
import { RECLAIM_MESSAGE, type RunBinding, type RunBindings } from './state.ts'

interface SyncConfirmation {
  readonly revision: number
  readonly sourceRevision: string
  readonly confirmedAtMs: number
  readonly uploadedAtMs: number | null
  readonly uploadedSha256?: string
}

interface Lane {
  readonly binding: RunBinding
  readonly abort: AbortController
  contentRevision: number
  view: SyncView
  operation?: Promise<SyncView | null>
  syncing: boolean
  trailing: boolean
  timer?: ReturnType<typeof setTimeout>
}
export class SessionBackups {
  private readonly lanes = new Map<string, Lane>()
  private epoch = 0
  private closed = false
  private readonly nativeSessionRoot: string
  constructor(private readonly ctx: Pick<DshContext, 'credentials' | 'sessionPersistence' | 'logger'>, private readonly bindings: RunBindings, private readonly options: { autoUpload?: boolean; uploadDebounceMs?: number; nativeSessionRoot?: string } = {}) {
    this.nativeSessionRoot = resolveNativeSessionRoot(options.nativeSessionRoot)
  }

  private lane(id: string): Lane | undefined {
    if (this.closed) return undefined
    const binding = this.bindings.get(id)
    const previous = this.lanes.get(id)
    if (previous?.binding === binding) return previous
    if (previous) { previous.abort.abort(); clearTimeout(previous.timer) }
    if (!binding) { this.lanes.delete(id); return undefined }
    const lane: Lane = { binding, abort: new AbortController(), contentRevision: 0, syncing: false, trailing: false,
      view: { sessionId: id, taskId: binding.taskId, runId: binding.taskModelRunId, bindingEpoch: ++this.epoch, revision: 0, phase: 'checking', uploadedAtMs: null, lastSyncedAtMs: binding.lastSyncedAtMs ?? null } }
    this.lanes.set(id, lane)
    return lane
  }
  private active(lane: Lane): boolean {
    return !this.closed && !lane.abort.signal.aborted && this.bindings.get(lane.binding.sessionId) === lane.binding
  }
  private publish(lane: Lane, phase: SyncPhase, uploadedAtMs = lane.view.uploadedAtMs): SyncView | null {
    if (!this.active(lane)) return null
    lane.view = { ...lane.view, revision: lane.view.revision + 1, phase, uploadedAtMs, lastSyncedAtMs: lane.binding.lastSyncedAtMs ?? null }
    return lane.view
  }
  private dirtyPhase(lane: Lane): SyncPhase { return lane.view.phase === 'failed' ? 'failed' : 'dirty' }
  changed(id: string, completedTurn = false): void {
    const lane = this.lane(id)
    if (!lane) return
    lane.contentRevision++
    this.publish(lane, lane.syncing ? 'uploading' : this.dirtyPhase(lane))
    if (!completedTurn || this.options.autoUpload === false) return
    if (lane.syncing) { lane.trailing = true; return }
    this.schedule(lane)
  }
  private schedule(lane: Lane): void {
    clearTimeout(lane.timer)
    lane.timer = setTimeout(() => {
      lane.timer = undefined
      void this.sync(lane.binding.sessionId).catch(error => this.ctx.logger.warn(`crowdtest: automatic upload failed for session ${lane.binding.sessionId}: ${error instanceof Error ? error.message : String(error)}`))
    }, this.options.uploadDebounceMs ?? 3_000)
  }
  inspect(id: string): Promise<SyncView | null> {
    const lane = this.lane(id)
    if (!lane) return Promise.resolve(null)
    if (lane.syncing) return Promise.resolve(lane.view)
    if (lane.operation) return lane.operation
    return this.start(lane, false)
  }
  sync(id: string): Promise<SyncView | null> {
    const lane = this.lane(id)
    if (!lane) return Promise.resolve(null)
    if (lane.syncing && lane.operation) return lane.operation
    clearTimeout(lane.timer)
    lane.timer = undefined
    const prior = lane.operation
    lane.syncing = true
    this.publish(lane, 'uploading')
    return this.start(lane, true, prior)
  }
  private start(lane: Lane, upload: boolean, prior?: Promise<SyncView | null>): Promise<SyncView | null> {
    const operation = (async () => {
      if (prior) await prior.catch(() => undefined)
      if (upload) this.publish(lane, 'uploading')
      let confirmation: SyncConfirmation | undefined
      do {
        lane.trailing = false
        confirmation = await this.check(lane, upload)
      } while (upload && lane.trailing && this.active(lane))
      if (upload && confirmation) await this.confirm(lane, confirmation)
      return this.active(lane) ? lane.view : null
    })().catch(error => {
      this.publish(lane, upload || lane.view.phase === 'failed' ? 'failed' : 'unknown')
      if (upload) throw error
      return this.active(lane) ? lane.view : null
    }).finally(() => {
      if (lane.operation === operation) {
        lane.operation = undefined
        lane.syncing = false
        if (lane.trailing && this.active(lane)) { lane.trailing = false; this.schedule(lane) }
      }
    })
    lane.operation = operation
    return operation
  }
  private async confirm(lane: Lane, confirmation: SyncConfirmation): Promise<void> {
    const current = () => this.active(lane) && lane.contentRevision === confirmation.revision
    if (!current()) return
    if (await this.sourceRevision(lane) !== confirmation.sourceRevision) { this.publish(lane, this.dirtyPhase(lane)); return }
    if (!current()) return
    const recorded = await this.bindings.recordSuccessfulSync({ binding: lane.binding, confirmedAtMs: confirmation.confirmedAtMs, uploadedSha256: confirmation.uploadedSha256, isCurrent: current })
    const sourceCurrent = await this.sourceRevision(lane) === confirmation.sourceRevision
    if (!recorded || !current() || !sourceCurrent) {
      this.publish(lane, this.dirtyPhase(lane), confirmation.uploadedAtMs)
      return
    }
    this.publish(lane, 'synced', confirmation.uploadedAtMs)
  }
  private async check(lane: Lane, upload: boolean): Promise<SyncConfirmation | undefined> {
    if (!this.active(lane)) return
    const { binding } = lane
    if (binding.resourceStatus !== 'ready') throw new Error(RECLAIM_MESSAGE)
    const resolved = await this.ctx.credentials.resolve(binding.credentialRef)
    if (!this.active(lane)) return
    if (!resolved) throw new Error('未找到本次运行的平台凭证，请重新执行领取口令')
    const revision = lane.contentRevision
    await this.ctx.sessionPersistence.flush()
    if (!this.active(lane)) return
    const file = await captureNativeSession({ persistence: this.ctx.sessionPersistence, sessionId: binding.sessionId,
      nativeSessionRoot: this.nativeSessionRoot, secret: resolved.value, maxBytes: binding.backupMaxBytes })
    if (!this.active(lane)) return
    const archive = buildSessionArchive(binding.sessionId, file)
    if (archive.size > binding.backupMaxBytes) throw new Error('会话归档超过平台上限')
    if (revision !== lane.contentRevision) { this.publish(lane, this.dirtyPhase(lane)); return }
    const client = new CrowdtestBffClient(binding.serverBaseUrl)
    const equal = (backup: ServerBackup | null) => backup !== null && backup.sha256 === archive.sha256 && backup.size === archive.size && backup.format === binding.backupFormat
    let backup = await client.sessionStatus(resolved.value, lane.abort.signal)
    if (!this.active(lane)) return
    let uploadedSha256: string | undefined
    if (upload && !equal(backup)) {
      if (revision !== lane.contentRevision || await this.sourceRevision(lane) !== file.sourceRevision) { this.publish(lane, this.dirtyPhase(lane)); return }
      if (!this.active(lane)) return
      await client.uploadSessionBackup(resolved.value, archive.bytes, { size: archive.size, sha256: archive.sha256, format: binding.backupFormat }, lane.abort.signal)
      if (!this.active(lane)) return
      backup = await client.sessionStatus(resolved.value, lane.abort.signal)
      if (!this.active(lane)) return
      if (!equal(backup)) throw new Error('平台尚未确认本次会话备份，请重试')
      uploadedSha256 = archive.sha256
    }
    const sourceCurrent = await this.sourceRevision(lane) === file.sourceRevision
    if (!this.active(lane)) return
    const synced = equal(backup) && revision === lane.contentRevision && sourceCurrent
    if (upload && synced) return { revision, sourceRevision: file.sourceRevision, confirmedAtMs: Date.now(), uploadedAtMs: backup?.uploadedAtMs ?? null, uploadedSha256 }
    this.publish(lane, synced ? 'synced' : this.dirtyPhase(lane), backup?.uploadedAtMs ?? null)
  }
  private sourceRevision(lane: Lane): Promise<string> {
    return nativeSessionRevision({ persistence: this.ctx.sessionPersistence, sessionId: lane.binding.sessionId, nativeSessionRoot: this.nativeSessionRoot })
  }
  async dispose(): Promise<void> {
    this.closed = true
    const pending: Promise<unknown>[] = []
    for (const lane of this.lanes.values()) {
      clearTimeout(lane.timer)
      lane.abort.abort()
      if (lane.operation) pending.push(lane.operation)
    }
    await Promise.allSettled(pending)
    this.lanes.clear()
  }
}
