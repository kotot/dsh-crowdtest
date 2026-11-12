import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildSessionArchive, buildTar } from '../src/archive.ts'
import { type NativeSessionFile, NATIVE_SESSION_NAME } from '../src/native-session.ts'

const SESSION_ID = '5bceb58e-601f-5e17-9607-32d954f16455'
const content = zstdCompressSync(Buffer.from('{"type":"session","version":4}\n'.repeat(40)))
const file = { name: NATIVE_SESSION_NAME, bytes: content } satisfies Pick<NativeSessionFile, 'name' | 'bytes'>

describe('session archive', () => {
  it('preserves the native filename and exact compressed bytes after system tar extraction', () => {
    const archive = buildSessionArchive(SESSION_ID, file)
    const directory = mkdtempSync(join(tmpdir(), 'crowdtest-archive-'))
    try {
      const path = join(directory, 'session.tar.gz')
      writeFileSync(path, archive.bytes)
      expect(execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).trim()).toBe(`${SESSION_ID}/${NATIVE_SESSION_NAME}`)
      execFileSync('tar', ['-xzf', path, '-C', directory])
      expect(readFileSync(join(directory, SESSION_ID, NATIVE_SESSION_NAME))).toEqual(content)
      expect(archive.size).toBe(archive.bytes.length)
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('is deterministic for identical original bytes', () => {
    expect(buildSessionArchive(SESSION_ID, file)).toEqual(buildSessionArchive(SESSION_ID, file))
  })
  it('pads members to 512-byte blocks and ends with two zero blocks', () => {
    const tar = buildTar([{ path: 'a/b.txt', content: new Uint8Array(513) }])
    expect(tar.length).toBe(512 + 1024 + 1024)
    expect(gunzipSync(buildSessionArchive(SESSION_ID, file).bytes).length % 512).toBe(0)
  })
  it('rejects member paths that do not fit the ustar name field or unsafe session ids', () => {
    expect(() => buildTar([{ path: 'x'.repeat(101), content: new Uint8Array() }])).toThrow(/100 bytes/)
    expect(() => buildSessionArchive('../other', file)).toThrow()
  })
})
