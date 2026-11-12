/** CrowdTest BFF `/api/crowdtest/local-runs/*` client for the `crowdtest-dsh/v1` protocol. */

import { validArchiveSessionId } from './archive.ts'
import { PLUGIN_VERSION } from './version.ts'

export const PROTOCOL_VERSION = 'crowdtest-dsh/v1'
export const CLIENT_VERSION = PLUGIN_VERSION

export interface ManifestModel {
  readonly alias: string
  readonly apiType: string
  readonly protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  readonly baseUrl: string
  readonly input: readonly ('text' | 'image')[]
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly reasoningEfforts?: false | Readonly<Record<string, string>>
  readonly reasoningEffort?: string
}

export interface ManifestAttachment {
  readonly name: string
  readonly size: number
  readonly sha256: string | null
  readonly contentType: string
  readonly url: string
}

export interface RunManifest {
  readonly protocol: string
  readonly harness: 'dsh'
  readonly projectId: number
  readonly taskId: number
  readonly taskModelRunId: number
  readonly sessionId: string
  readonly serviceName: string
  readonly title: string
  readonly projectEndTime: number
  readonly model: ManifestModel
  readonly prompt: string
  readonly attachments: readonly ManifestAttachment[]
  readonly sessionBackup: { readonly format: string; readonly maxBytes: number }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function positive(value: unknown): value is number {
  return nonnegative(value) && value > 0
}

function validModel(model: unknown): model is ManifestModel {
  if (!record(model) || !text(model.alias) || !text(model.apiType) || !text(model.baseUrl)) return false
  if (model.protocol !== 'openai-completions' && model.protocol !== 'openai-responses' && model.protocol !== 'anthropic-messages') return false
  if (!Array.isArray(model.input) || !model.input.length || !model.input.every(input => input === 'text' || input === 'image')) return false
  if (model.contextWindow !== undefined && !positive(model.contextWindow)) return false
  if (model.maxTokens !== undefined && !positive(model.maxTokens)) return false
  if (model.reasoningEffort !== undefined && !text(model.reasoningEffort)) return false
  const efforts = model.reasoningEfforts
  if (efforts !== undefined && efforts !== false && !(record(efforts) && Object.entries(efforts).every(([key, value]) => text(key) && text(value)))) return false
  normalizeServerBaseUrl(model.baseUrl)
  return true
}

function validAttachment(file: unknown): file is ManifestAttachment {
  if (!record(file) || !text(file.name) || !nonnegative(file.size) || !text(file.contentType) || !text(file.url)) return false
  if (/^[.-]|[/\\\x00-\x1f\x7f]/u.test(file.name) || Buffer.byteLength(file.name) > 255) return false
  if (file.sha256 !== null && !(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256))) return false
  platformUrl(file.url, true)
  return true
}

function parseManifest(value: unknown): RunManifest {
  if (!record(value)) throw new Error('任务清单无效')
  if (value.protocol !== PROTOCOL_VERSION) throw new Error(`平台协议与插件支持的 ${PROTOCOL_VERSION} 不一致，请更新 CrowdTest 插件`)
  const { projectId, taskId, taskModelRunId, sessionId, title, prompt, serviceName, projectEndTime, model, sessionBackup, attachments } = value
  if (value.harness !== 'dsh' || !positive(projectId) || !positive(taskId) || !positive(taskModelRunId) || !validArchiveSessionId(sessionId)) {
    throw new Error('任务清单中的运行或会话标识无效')
  }
  if (typeof title !== 'string' || typeof prompt !== 'string' || !text(serviceName) || !nonnegative(projectEndTime) || !validModel(model)) {
    throw new Error('任务清单中的任务或模型配置无效')
  }
  if (!record(sessionBackup) || sessionBackup.format !== 'dsh-session-tree-tar-gzip' || !positive(sessionBackup.maxBytes)) {
    throw new Error('任务清单中的备份配置无效')
  }
  if (!Array.isArray(attachments) || !attachments.every(validAttachment)) throw new Error('任务清单中的附件信息无效')
  const names = attachments.map(file => file.name.normalize('NFC').toLowerCase())
  if (new Set(names).size !== names.length) throw new Error('任务清单中的附件文件名重复')
  return { protocol: PROTOCOL_VERSION, harness: 'dsh', projectId, taskId, taskModelRunId, sessionId, title, prompt,
    serviceName, projectEndTime, model, attachments, sessionBackup: { format: sessionBackup.format, maxBytes: sessionBackup.maxBytes } }
}

export interface SessionBackupDescriptor {
  readonly size: number
  readonly sha256: string
  readonly format: string
}

export interface ServerBackup extends SessionBackupDescriptor { readonly uploadedAtMs: number | null }
export function parseBackup(value: unknown): ServerBackup | null {
  if (typeof value !== 'object' || value === null || !('backup' in value) || Object.keys(value).length !== 1) throw new Error('invalid backup status')
  const backup = value.backup
  if (backup === null) return null
  if (typeof backup !== 'object' || !('sha256' in backup) || !('size' in backup) || !('format' in backup) || !('uploadedAtMs' in backup) || Object.keys(backup).length !== 4) throw new Error('invalid backup metadata')
  if (typeof backup.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(backup.sha256) || typeof backup.size !== 'number' || !Number.isSafeInteger(backup.size) || backup.size <= 0 || typeof backup.format !== 'string' || backup.format !== 'dsh-session-tree-tar-gzip' || (backup.uploadedAtMs !== null && (typeof backup.uploadedAtMs !== 'number' || !Number.isSafeInteger(backup.uploadedAtMs) || backup.uploadedAtMs <= 0))) throw new Error('invalid backup metadata')
  return { sha256: backup.sha256, size: backup.size, format: backup.format, uploadedAtMs: backup.uploadedAtMs }
}

/** A BFF or storage failure carrying the HTTP status and server-provided `detail` or `message` text. */
export class CrowdtestRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'CrowdtestRequestError'
  }
}

async function failure(response: Response, action: string): Promise<CrowdtestRequestError> {
  let detail = ''
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null) {
      if ('detail' in body && typeof body.detail === 'string') detail = body.detail
      else if ('message' in body && typeof body.message === 'string') detail = body.message
    }
  } catch {
    // A non-JSON error body (gateway HTML, TOS XML) leaves only the status to report.
  }
  return new CrowdtestRequestError(response.status, `${action}失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`)
}

function platformUrl(value: string, allowQuery: boolean): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('平台地址无效') }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('平台地址必须使用 HTTPS')
  if (url.username || url.password || url.hash || (!allowQuery && url.search)) throw new Error('平台地址包含不支持的账号、查询参数或片段')
  return url
}

export function normalizeServerBaseUrl(value: string): string {
  const url = platformUrl(value, false)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export class CrowdtestBffClient {
  constructor(readonly serverBaseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private url(path: string): string {
    return `${this.serverBaseUrl}/api/crowdtest/local-runs${path}`
  }

  async sessionStatus(token: string, signal?: AbortSignal): Promise<ServerBackup | null> {
    const response = await this.fetchImpl(this.url('/session/status'), { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal })
    if (!response.ok) throw await failure(response, '检查会话备份')
    return parseBackup(await response.json())
  }

  async exchangeTicket(ticket: string, signal?: AbortSignal): Promise<{ token: string; tokenExpiresAt: number }> {
    const response = await this.fetchImpl(this.url('/dsh/ticket/exchange'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
      signal,
    })
    if (!response.ok) throw await failure(response, '兑换领取口令')
    const value: unknown = await response.json()
    if (!record(value) || !text(value.token) || !positive(value.tokenExpiresAt) || value.tokenExpiresAt <= Date.now()) {
      throw new Error('平台返回的运行凭证无效或已过期，请重新领取')
    }
    return { token: value.token, tokenExpiresAt: value.tokenExpiresAt }
  }

  async manifest(token: string, signal?: AbortSignal): Promise<RunManifest> {
    const response = await this.fetchImpl(this.url('/dsh/manifest'), {
      headers: { authorization: `Bearer ${token}`, 'x-autocase-client-version': CLIENT_VERSION },
      signal,
    })
    if (!response.ok) throw await failure(response, '拉取任务清单')
    return parseManifest(await response.json())
  }

  /**
   * Upload one session backup: request an exact-size signed POST, send the archive to TOS, then let the BFF verify it.
   * @param token - local-run Router Token.
   * @param archive - complete archive bytes.
   * @param descriptor - size, SHA-256 and format the BFF signs and verifies.
   * @param signal - cancellation.
   */
  async uploadSessionBackup(
    token: string,
    archive: Uint8Array<ArrayBuffer>,
    descriptor: SessionBackupDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const signed = await this.fetchImpl(this.url('/session/upload-url'), {
      method: 'POST', headers, body: JSON.stringify(descriptor), signal,
    })
    if (!signed.ok) throw await failure(signed, '申请会话上传地址')
    const post = await signed.json() as { signedPostUrl: string; formFields: Record<string, string>; fileField: string }
    const form = new FormData()
    for (const [key, value] of Object.entries(post.formFields)) form.append(key, value)
    form.append(post.fileField, new Blob([archive], { type: 'application/gzip' }), 'session.tar.gz')
    const uploaded = await this.fetchImpl(post.signedPostUrl, { method: 'POST', body: form, signal })
    if (!uploaded.ok) throw await failure(uploaded, '上传会话归档')
    const verified = await this.fetchImpl(this.url('/session/verify'), {
      method: 'POST', headers, body: JSON.stringify(descriptor), signal,
    })
    if (!verified.ok) throw await failure(verified, '校验会话备份')
  }
}
