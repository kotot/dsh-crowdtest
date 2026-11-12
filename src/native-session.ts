import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { DshSessionPersistence } from './dsh.ts'

export const NATIVE_SESSION_NAME = 'session.v4.jsonl.zstd'
const MAX_DECODED_BYTES = 128 * 1024 * 1024
const MAX_FRAMES = 65_536

export interface NativeSessionFile {
  readonly name: typeof NATIVE_SESSION_NAME
  readonly bytes: Uint8Array
  readonly sourceRevision: string
}

interface SourceOptions {
  readonly persistence: DshSessionPersistence
  readonly sessionId: string
  readonly nativeSessionRoot?: string
}

// Matches DSH session-persistence-jsonl's UTF-16 path encoding.
function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('会话路径为空')
  if (raw === '.' || raw === '..') return raw.replaceAll('.', '~002E')
  let encoded = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    encoded += /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return encoded
}

function projectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i]!
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else {
      readable += /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

function sessionIdentity(value: unknown, sessionId: string): { id: string; cwd?: string } {
  if (typeof value !== 'object' || value === null || !('id' in value) || value.id !== sessionId) {
    throw new Error('原生会话身份与当前运行不匹配')
  }
  if ('cwd' in value && value.cwd !== undefined) {
    if (typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) throw new Error('原生会话目录无效')
    return { id: sessionId, cwd: value.cwd }
  }
  return { id: sessionId }
}

function fileRevision(identity: Awaited<ReturnType<typeof fileStat>>): string {
  if (!identity.isFile()) throw new Error('原生会话不是普通文件')
  return [identity.dev, identity.ino, identity.size, identity.mtimeNs, identity.ctimeNs].join(':')
}

async function fileStat(path: string) {
  return lstat(path, { bigint: true })
}

export function resolveNativeSessionRoot(root?: string): string {
  return resolve(root ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions'))
}

async function source(options: SourceOptions) {
  const snapshot = await options.persistence.stat(options.sessionId)
  if (!snapshot) throw new Error('未找到当前原生会话')
  const header = sessionIdentity(snapshot.header, options.sessionId)
  const root = resolveNativeSessionRoot(options.nativeSessionRoot)
  const path = join(root, header.cwd === undefined ? '_no-cwd' : projectKey(header.cwd), encodeSegment(header.id), NATIVE_SESSION_NAME)
  return { path, header, revision: String(snapshot.revision) }
}

export async function nativeSessionRevision(options: SourceOptions): Promise<string> {
  const current = await source(options)
  return `${current.revision}:${fileRevision(await fileStat(current.path))}`
}

export function decodeNativeSession(bytes: Uint8Array, maxBytes = MAX_DECODED_BYTES): Uint8Array {
  const chunks: Buffer[] = []
  let offset = 0
  let total = 0
  while (offset < bytes.length) {
    if (chunks.length >= MAX_FRAMES) throw new Error('原生会话压缩帧超过上限')
    if (bytes[offset] !== 0x28 || bytes[offset + 1] !== 0xb5 || bytes[offset + 2] !== 0x2f || bytes[offset + 3] !== 0xfd) throw new Error('原生会话包含非标准压缩帧')
    const decoded: unknown = zstdDecompressSync(bytes.subarray(offset), { info: true, maxOutputLength: Math.max(1, maxBytes - total) })
    if (typeof decoded !== 'object' || decoded === null || !('buffer' in decoded) || !Buffer.isBuffer(decoded.buffer)
      || !('engine' in decoded) || typeof decoded.engine !== 'object' || decoded.engine === null
      || !('bytesWritten' in decoded.engine) || typeof decoded.engine.bytesWritten !== 'number'
      || decoded.engine.bytesWritten <= 0 || decoded.engine.bytesWritten > bytes.length - offset) {
      throw new Error('原生会话压缩帧无效')
    }
    total += decoded.buffer.length
    if (total > maxBytes) throw new Error('原生会话解压后超过大小上限')
    chunks.push(decoded.buffer)
    offset += decoded.engine.bytesWritten
  }
  if (offset === 0) throw new Error('原生会话为空')
  return Buffer.concat(chunks, total)
}

function containsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false
  const pending = [value]
  while (pending.length > 0) {
    const next = pending.pop()
    if (typeof next === 'string' && next.includes(secret)) return true
    if (next !== null && typeof next === 'object') {
      for (const [key, child] of Object.entries(next)) {
        if (key.includes(secret)) return true
        pending.push(child)
      }
    }
  }
  return false
}

function validateNativeSession(bytes: Uint8Array, header: { id: string; cwd?: string }, secret: string): void {
  if (secret && Buffer.from(bytes).includes(secret)) throw new Error('会话中出现了平台凭证原文，已停止上传；请联系项目管理员处理')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(decodeNativeSession(bytes)) }
  catch { throw new Error('原生会话压缩内容无效或超过大小上限') }
  if (secret && text.includes(secret)) throw new Error('会话中出现了平台凭证原文，已停止上传；请联系项目管理员处理')
  let first = true
  for (const line of text.split('\n')) {
    if (line === '') continue
    let record: unknown
    try { record = JSON.parse(line) }
    catch { throw new Error('原生会话 JSONL 无效') }
    if (first) {
      const identity = sessionIdentity(record, header.id)
      if (typeof record !== 'object' || record === null || !('type' in record) || record.type !== 'session'
        || !('version' in record) || record.version !== 4 || identity.cwd !== header.cwd) {
        throw new Error('原生会话头与当前运行不匹配')
      }
      first = false
    }
    if (containsSecret(record, secret)) throw new Error('会话中出现了平台凭证原文，已停止上传；请联系项目管理员处理')
  }
  if (first) throw new Error('原生会话缺少会话头')
}

export async function captureNativeSession(options: SourceOptions & { readonly secret: string; readonly maxBytes: number }): Promise<NativeSessionFile> {
  const current = await source(options)
  const handle = await open(current.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  let revision: string
  try {
    const before = await handle.stat({ bigint: true })
    revision = fileRevision(before)
    if (before.size <= 0 || before.size > BigInt(Math.min(options.maxBytes, MAX_DECODED_BYTES))) throw new Error('原生会话超过大小上限')
    bytes = Buffer.alloc(Number(before.size) + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== Number(before.size) || fileRevision(await handle.stat({ bigint: true })) !== revision
      || fileRevision(await fileStat(current.path)) !== revision) throw new Error('原生会话在读取期间发生变化，请重试')
    bytes = bytes.subarray(0, offset)
  } finally { await handle.close() }
  const sourceRevision = `${current.revision}:${revision}`
  validateNativeSession(bytes, current.header, options.secret)
  if (await nativeSessionRevision(options) !== sourceRevision) throw new Error('原生会话在读取期间发生变化，请重试')
  return { name: NATIVE_SESSION_NAME, bytes, sourceRevision }
}
