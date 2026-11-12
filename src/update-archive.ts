import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import * as z from 'zod/mini'
import { MAX_ARCHIVE, sha256 } from './update-github.ts'
import { PACKAGE, UpdateError } from './update-protocol.ts'

const unzip = promisify(gunzip)
const MAX_EXPANDED = 32 * 1024 * 1024
const required = ['package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'icon.png']
const allowed = new Set([...required, 'usage-guide.png'])
const manifestSchema = z.looseObject({
  name: z.literal(PACKAGE), version: z.string(), main: z.enum(['lib/index.js', './lib/index.js']),
  exports: z.looseObject({ '.': z.literal('./lib/index.js'), './client': z.literal('./lib/client.js') }),
  dsh: z.looseObject({ bundle: z.object({ patch: z.literal('./cordis.patch.yml'), platforms: z.optional(z.array(z.string())) }) }),
  engines: z.object({ dsh: z.string().check(z.minLength(1)) }),
  dependencies: z.optional(z.strictObject({})), optionalDependencies: z.optional(z.strictObject({})),
  peerDependencies: z.optional(z.record(z.string(), z.string())),
  peerDependenciesMeta: z.optional(z.record(z.string(), z.object({ optional: z.optional(z.boolean()) }))),
  scripts: z.optional(z.record(z.string(), z.string())),
})
export type ArchiveManifest = z.infer<typeof manifestSchema>
export type Compatibility = (manifest: ArchiveManifest) => boolean
export interface VerifiedArchive {
  readonly bytes: Buffer
  readonly files: ReadonlyMap<string, string>
}
function invalid(): never { throw new UpdateError('archive') }

export async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > maxBytes) invalid()
    const data = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset)
      if (bytesRead === 0) invalid()
      offset += bytesRead
    }
    if ((await file.read(Buffer.alloc(1))).bytesRead !== 0) invalid()
    return data
  } finally { await file.close() }
}

// npm packs this bundle as regular USTAR files with short ASCII paths. Reject all extension
// headers so the native extractor cannot see a second name, sparse payload or linked target.
function entries(tar: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  let cursor = 0
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512)
    if (header.every(byte => byte === 0)) {
      if (tar.length - cursor < 1024 || tar.length % 512 || tar.subarray(cursor).some(byte => byte !== 0)) invalid()
      return files
    }
    const nul = header.indexOf(0)
    if (nul < 1 || nul > 99 || header.subarray(nul, 100).some(byte => byte !== 0)) invalid()
    const path = header.toString('latin1', 0, nul)
    const file = path.slice('package/'.length)
    if (!path.startsWith('package/') || !allowed.has(file) || files.has(file)) invalid()
    if (header[156] !== 48 || header.subarray(157, 257).some(byte => byte !== 0) ||
      header.toString('latin1', 257, 265) !== 'ustar\x0000' || header.subarray(345).some(byte => byte !== 0)) invalid()
    const octal = (start: number, end: number) => {
      const field = header.toString('latin1', start, end)
      if (!/^ *[0-7]+[\x00 ]*$/.test(field)) invalid()
      return parseInt(field, 8)
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (octal(148, 156) !== checksum) invalid()
    const size = octal(124, 136)
    cursor += 512
    if (!size || cursor + size > tar.length) invalid()
    files.set(file, tar.subarray(cursor, cursor + size))
    cursor += Math.ceil(size / 512) * 512
  }
  return invalid()
}

export async function verifyArchive(bytes: Buffer, version: string, compatible: Compatibility): Promise<VerifiedArchive> {
  try {
    if (bytes.length > MAX_ARCHIVE) invalid()
    const files = entries(await unzip(bytes, { maxOutputLength: MAX_EXPANDED }))
    if (required.some(path => !files.has(path))) invalid()
    const manifestBytes = files.get('package.json')
    if (!manifestBytes || manifestBytes.length > 128 * 1024) invalid()
    const parsed = manifestSchema.safeParse(JSON.parse(manifestBytes.toString('utf8')))
    if (!parsed.success || parsed.data.version !== version) invalid()
    const manifest = parsed.data
    const peers = Object.keys(manifest.peerDependencies ?? {})
    if (peers.some(name => !name.startsWith('@deepseek-ai/') || manifest.peerDependenciesMeta?.[name]?.optional !== true) ||
      ['preinstall', 'install', 'postinstall', 'prepare'].some(hook => Object.hasOwn(manifest.scripts ?? {}, hook))) invalid()
    if (!compatible(manifest)) throw new UpdateError('compatibility')
    return { bytes, files: new Map([...files].map(([path, data]) => [path, sha256(data)])) }
  } catch (error) { throw error instanceof UpdateError ? error : new UpdateError('archive') }
}

export async function matchesInstalled(directory: string, archive: VerifiedArchive): Promise<boolean> {
  try {
    const files = new Set<string>()
    const list = async (subdir = '') => {
      for (const entry of await readdir(join(directory, subdir), { withFileTypes: true })) {
        const name = subdir + entry.name
        if (entry.isFile() && archive.files.has(name)) files.add(name)
        else if (entry.isDirectory() && name === 'lib') await list('lib/')
        else throw new UpdateError('archive')
      }
    }
    await list()
    if (files.size !== archive.files.size) return false
    for (const file of files) {
      if (sha256(await readRegularFile(join(directory, file), MAX_EXPANDED)) !== archive.files.get(file)) return false
    }
    return true
  } catch { return false }
}
