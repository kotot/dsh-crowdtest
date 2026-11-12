import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { NATIVE_SESSION_NAME, type NativeSessionFile } from './native-session.ts'

const BLOCK = 512

function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0')
  header.set(new TextEncoder().encode(`${text}\0`), offset)
}

/**
 * Build a POSIX ustar archive of regular files with fixed metadata, so identical content yields identical bytes.
 * @param files - archive member paths (at most 100 bytes each) and contents.
 * @returns the uncompressed tar stream.
 * @throws {Error} when a member path does not fit the ustar name field.
 */
export function buildTar(files: readonly { path: string; content: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  for (const file of files) {
    const name = encoder.encode(file.path)
    if (name.length > 100) throw new Error(`tar member path is longer than 100 bytes: ${file.path}`)
    const header = new Uint8Array(BLOCK)
    header.set(name, 0)
    writeOctal(header, 100, 8, 0o600)
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, file.content.length)
    writeOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = 0x30
    header.set(encoder.encode('ustar\0'), 257)
    header.set(encoder.encode('00'), 263)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.set(encoder.encode(`${checksum.toString(8).padStart(6, '0')}\0 `), 148)
    chunks.push(header, file.content)
    const padding = (BLOCK - (file.content.length % BLOCK)) % BLOCK
    if (padding > 0) chunks.push(new Uint8Array(padding))
  }
  chunks.push(new Uint8Array(BLOCK * 2))
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const tar = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    tar.set(chunk, offset)
    offset += chunk.length
  }
  return tar
}

export interface SessionArchive {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly sha256: string
  readonly size: number
}

export function validArchiveSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) && id.length + 1 + NATIVE_SESSION_NAME.length <= 100
}

/** Package the unchanged persistence file under its original name. */
export function buildSessionArchive(sessionId: string, file: Pick<NativeSessionFile, 'name' | 'bytes'>): SessionArchive {
  if (!validArchiveSessionId(sessionId)) throw new Error('会话标识无效')
  const bytes = new Uint8Array(gzipSync(buildTar([{ path: `${sessionId}/${file.name}`, content: file.bytes }]), { level: 9 }))
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}
