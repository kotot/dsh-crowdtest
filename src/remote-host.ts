import { descriptors, parseRequest, type SyncRequest } from './bridge.ts'
import type { SessionBackups } from './session-backups.ts'
import type { DshContext } from './dsh.ts'

export async function installRemote(ctx: DshContext, backups: SessionBackups): Promise<void> {
  const cordis = '@deepseek-ai/cordis'
  const protocol = '@deepseek-ai/dsh-typert-protocol'
  const { Service } = await import(cordis)
  const { bindTypertRemote, Remote } = await import(protocol)
  class CrowdtestSync extends Service {
    readonly typertRemote
    constructor() {
      super(ctx, 'crowdtestSync')
      this.typertRemote = bindTypertRemote(this, 'crowdtestSync')
    }
    @Remote({ resources: { session: (request: SyncRequest) => request.sessionId } })
    inspect(request: SyncRequest, signal: AbortSignal) {
      signal.throwIfAborted()
      return backups.inspect(parseRequest(request).sessionId)
    }
    @Remote({ resources: { session: (request: SyncRequest) => request.sessionId } })
    sync(request: SyncRequest, signal: AbortSignal) {
      signal.throwIfAborted()
      return backups.sync(parseRequest(request).sessionId)
    }
  }
  new CrowdtestSync()
  ctx.typert?.register({ package: 'dsh-crowdtest', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: descriptors })
}
