import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureNativeSession, decodeNativeSession, NATIVE_SESSION_NAME, resolveNativeSessionRoot } from '../src/native-session.ts'

const ID = 'FAKE_TEST_ONLY_SESSION'
const SECRET = 'FAKE_TEST_ONLY_TOKEN'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(cwd?: string, project = '_no-cwd') {
  const root = await mkdtemp(join(tmpdir(), 'native-session-')); dirs.push(root)
  const path = join(root, project, ID, NATIVE_SESSION_NAME)
  await mkdir(dirname(path), { recursive: true })
  const header = { type: 'session', version: 4, id: ID, ...(cwd === undefined ? {} : { cwd }) }
  const stat = vi.fn(async () => ({ header, revision: 'first' }))
  const persistence = { stat, flush: async () => {}, open: vi.fn() }
  const options = { persistence, sessionId: ID, nativeSessionRoot: root, secret: SECRET, maxBytes: 1024 * 1024 }
  const save = async (text: string) => writeFile(path, zstdCompressSync(Buffer.from(text)))
  await save(JSON.stringify(header) + '\n')
  return { options, path, header, save, stat }
}

describe('native persistence snapshot', () => {
  it.each([
    [undefined, '_no-cwd'], ['/Users/a.b/中~:x', '--Users-a.b-~4E2D~007E-x--'], ['/', '--root--'],
  ])('uses the official exact project path for %s', async (cwd, key) => {
    const f = await fixture(cwd, key)
    const result = await captureNativeSession(f.options)
    expect(result.name).toBe(NATIVE_SESSION_NAME)
    expect(result.bytes).toEqual(await readFile(f.path))
    expect(f.options.persistence.open).not.toHaveBeenCalled()
  })
  it('observes all frames, including a header and credential split between frames', async () => {
    const f = await fixture()
    const text = JSON.stringify(f.header) + '\n' + JSON.stringify({ text: SECRET }) + '\n'
    const split = text.indexOf(SECRET) + 8
    const native = Buffer.concat([zstdCompressSync(Buffer.from(text.slice(0, 5))), zstdCompressSync(Buffer.from(text.slice(5, split))), zstdCompressSync(Buffer.from(text.slice(split)))])
    expect(Buffer.from(decodeNativeSession(native)).toString()).toBe(text)
    await writeFile(f.path, native)
    await expect(captureNativeSession(f.options)).rejects.toThrow('平台凭证')
  })
  it.each(['later', 'escaped'])('detects a credential in %s frame JSON values', async mode => {
    const f = await fixture()
    const secret = mode === 'escaped' ? [...SECRET].map(ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('') : SECRET
    await writeFile(f.path, Buffer.concat([zstdCompressSync(Buffer.from(JSON.stringify(f.header) + '\n')), zstdCompressSync(Buffer.from(`{"text":"${secret}"}\n`))]))
    await expect(captureNativeSession(f.options)).rejects.toThrow('平台凭证')
  })
  it.each(['id', 'cwd', 'version'])('rejects a mismatched native %s', async field => {
    const f = await fixture()
    await f.save(JSON.stringify({ ...f.header, [field]: field === 'version' ? 3 : '/foreign' }) + '\n')
    await expect(captureNativeSession(f.options)).rejects.toThrow()
  })
  it('refuses a changed persistence revision after the raw file read', async () => {
    const f = await fixture()
    f.stat.mockResolvedValueOnce({ header: f.header, revision: 'first' }).mockResolvedValue({ header: f.header, revision: 'changed' })
    await expect(captureNativeSession(f.options)).rejects.toThrow('发生变化')
  })
  it.each(['truncated', 'trailing', 'later-truncated'])('rejects %s compressed input', async kind => {
    const bytes = zstdCompressSync(Buffer.from('x'.repeat(100)))
    const invalid = kind === 'trailing' ? Buffer.concat([bytes, Buffer.from('junk')]) : kind === 'later-truncated' ? Buffer.concat([bytes, bytes.subarray(0, bytes.length - 1)]) : bytes.subarray(0, bytes.length - 1)
    expect(() => decodeNativeSession(invalid)).toThrow()
  })
  it('bounds cumulative output across frames', () => {
    const bytes = zstdCompressSync(Buffer.from('x'.repeat(50)))
    expect(() => decodeNativeSession(Buffer.concat([bytes, bytes]), 99)).toThrow()
    expect(decodeNativeSession(Buffer.concat([bytes, bytes]), 100)).toHaveLength(100)
  })
})


it('resolves a configured relative source root once without filesystem discovery', () => {
  expect(resolveNativeSessionRoot('./FAKE_TEST_ONLY_ROOT')).toBe(join(process.cwd(), 'FAKE_TEST_ONLY_ROOT'))
})

it('rejects a symlink source instead of following it', async () => {
  const f = await fixture()
  const target = join(dirname(f.path), 'foreign.zstd')
  await writeFile(target, await readFile(f.path))
  await rm(f.path)
  await symlink(target, f.path)
  await expect(captureNativeSession(f.options)).rejects.toThrow()
})

it('rejects wrong persistence identity before reading any archive', async () => {
  const f = await fixture()
  f.stat.mockResolvedValue({ header: { ...f.header, id: 'OTHER_TEST_ONLY_SESSION' }, revision: 'first' })
  await expect(captureNativeSession(f.options)).rejects.toThrow('身份')
})

it('rejects physical source drift before finishing the capture', async () => {
  const f = await fixture()
  f.stat.mockImplementationOnce(async () => ({ header: f.header, revision: 'first' })).mockImplementation(async () => {
    await f.save(JSON.stringify(f.header) + '\n' + '{"external":"FAKE_TEST_ONLY_WRITE"}\n')
    return { header: f.header, revision: 'first' }
  })
  await expect(captureNativeSession(f.options)).rejects.toThrow('发生变化')
})


it('rejects appended skippable frames and scans raw bytes before upload', async () => {
  const f = await fixture()
  const header = Buffer.alloc(8)
  header.writeUInt32LE(0x184d2a50)
  header.writeUInt32LE(Buffer.byteLength(SECRET), 4)
  const bytes = Buffer.concat([await readFile(f.path), header, Buffer.from(SECRET)])
  expect(() => decodeNativeSession(bytes)).toThrow('非标准')
  await writeFile(f.path, bytes)
  await expect(captureNativeSession(f.options)).rejects.toThrow('平台凭证')
})
