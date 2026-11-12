import { updateDescriptors } from './update-protocol.ts'

export type SyncPhase = 'checking' | 'synced' | 'dirty' | 'uploading' | 'failed' | 'unknown'
export interface SyncView {
  readonly sessionId: string
  readonly taskId: number
  readonly runId: number
  readonly bindingEpoch: number
  readonly revision: number
  readonly phase: SyncPhase
  readonly uploadedAtMs: number | null
  readonly lastSyncedAtMs: number | null
}
export interface SyncRequest { readonly sessionId: string }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid sync payload')
  return value as Record<string, unknown>
}
export function parseRequest(value: unknown): SyncRequest {
  const request = object(value)
  if (Object.keys(request).length !== 1 || typeof request.sessionId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(request.sessionId)) throw new Error('invalid session id')
  return { sessionId: request.sessionId }
}
export function parseView(value: unknown): SyncView | null {
  if (value === null) return null
  const view = object(value)
  const keys = ['sessionId', 'taskId', 'runId', 'bindingEpoch', 'revision', 'phase', 'uploadedAtMs', 'lastSyncedAtMs']
  if (Object.keys(view).length !== keys.length || keys.some(key => !Object.hasOwn(view, key))) throw new Error('invalid sync view')
  const { sessionId } = parseRequest({ sessionId: view.sessionId })
  const integer = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid sync identity')
    return value
  }
  const phase = view.phase
  if (phase !== 'checking' && phase !== 'synced' && phase !== 'dirty' && phase !== 'uploading' && phase !== 'failed' && phase !== 'unknown') throw new Error('invalid sync phase')
  const uploadedAtMs = view.uploadedAtMs
  if (uploadedAtMs !== null && (typeof uploadedAtMs !== 'number' || !Number.isSafeInteger(uploadedAtMs) || uploadedAtMs <= 0)) throw new Error('invalid sync timestamp')
  const lastSyncedAtMs = view.lastSyncedAtMs
  if (lastSyncedAtMs !== null && (typeof lastSyncedAtMs !== 'number' || !Number.isSafeInteger(lastSyncedAtMs) || lastSyncedAtMs <= 0)) throw new Error('invalid sync timestamp')
  return { sessionId, taskId: integer(view.taskId), runId: integer(view.runId), bindingEpoch: integer(view.bindingEpoch), revision: integer(view.revision), phase, uploadedAtMs, lastSyncedAtMs }
}
export const descriptors = (['inspect', 'sync'] as const).map(method => ({
  id: `dsh-crowdtest#crowdtestSync/${method}`, service: 'crowdtestSync', namespace: 'crowdtestSync', method,
  invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: 'SyncRequest', create: () => ({ parse: parseRequest }) } }],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict' as const, typeSymbol: 'SyncView', create: () => ({ parse: parseView }), decode: parseView },
}))
export const contribution = { package: 'dsh-crowdtest', descriptors: [...descriptors, ...updateDescriptors] }
