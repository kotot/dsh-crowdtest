import { createHash } from 'node:crypto'
import valid from 'semver/functions/valid.js'
import * as z from 'zod/mini'
import { digest, PACKAGE, UpdateError, versionText } from './update-protocol.ts'

const RELEASES = 'https://github.com/kotot/dsh-crowdtest/releases'
export const METADATA_NAME = 'dsh-crowdtest-update.json'
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
export const MAX_ARCHIVE = 16 * 1024 * 1024
const positiveInt = z.int().check(z.positive())
export const assetSchema = z.strictObject({
  version: versionText, releaseId: positiveInt, assetId: positiveInt, size: positiveInt.check(z.lte(MAX_ARCHIVE)), sha256: digest,
})
export type ReleaseAsset = z.infer<typeof assetSchema>
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export const stableVersion = (version: string) => /^\d+\.\d+\.\d+$/.test(version) && valid(version) === version

function redirectTarget(location: string | null, from: URL): URL {
  if (!location || /[#\\\s]/.test(location)) throw new UpdateError('release')
  const absolute = location.startsWith('/') && !location.startsWith('//') ? from.origin + location : location
  const next = new URL(absolute)
  if (next.protocol !== 'https:' || !absolute.startsWith('https://' + next.hostname + '/') ||
    next.href !== absolute) throw new UpdateError('release')
  return next
}

async function readBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body || Number(response.headers.get('content-length')) > limit) throw new UpdateError('archive')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, size)
      size += value.byteLength
      if (size > limit) throw new UpdateError('archive')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
}

export class GitHubReleases {
  constructor(private readonly transport: typeof fetch = fetch) {}
  private async request(name: string, version: string | undefined, limit: number) {
    if (version !== undefined && !stableVersion(version)) throw new UpdateError('release')
    const route = version === undefined ? 'latest/download' : 'download/v' + version
    let url = new URL(RELEASES + '/' + route + '/' + name)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 45_000)
    try {
      for (let hop = 0; hop <= 3; hop++) {
        const response = await this.transport(url.href, { redirect: 'manual', signal: abort.signal, credentials: 'omit' })
        if (response.status === 200) {
          if (version === undefined) throw new UpdateError('release')
          return { bytes: await readBody(response, limit), version }
        }
        await response.body?.cancel()
        if (response.status === 429 || response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) throw new UpdateError('rate')
        if ([401, 403, 404].includes(response.status)) throw new UpdateError('access')
        if (![301, 302, 303, 307, 308].includes(response.status)) throw new UpdateError('network')
        const next = redirectTarget(response.headers.get('location'), url)
        if (version === undefined) {
          const tag = next.pathname.split('/').at(-2)
          const taggedVersion = tag?.slice(1)
          if (!taggedVersion || !stableVersion(taggedVersion) ||
            next.href !== RELEASES + '/download/v' + taggedVersion + '/' + name) throw new UpdateError('release')
          version = taggedVersion
        } else if (!ASSET_HOSTS.has(next.hostname)) throw new UpdateError('release')
        url = next
      }
      throw new UpdateError('release')
    } catch (error) {
      throw error instanceof UpdateError ? error : new UpdateError('network')
    } finally { clearTimeout(timer); abort.abort() }
  }
  async metadata(version?: string): Promise<ReleaseAsset> {
    const manifest = await this.request(METADATA_NAME, version, 512 * 1024)
    try {
      const asset = assetSchema.parse(JSON.parse(manifest.bytes.toString('utf8')))
      if (asset.version !== manifest.version) throw new UpdateError('release')
      return asset
    } catch { throw new UpdateError('release') }
  }
  async download(asset: ReleaseAsset): Promise<Buffer> {
    const { bytes: data } = await this.request(`${PACKAGE}-${asset.version}.tgz`, asset.version, asset.size)
    if (data.length !== asset.size || sha256(data) !== asset.sha256) throw new UpdateError('archive')
    return data
  }
}
export function sameAsset(first: ReleaseAsset, second: ReleaseAsset): boolean {
  return first.version === second.version && first.releaseId === second.releaseId && first.assetId === second.assetId &&
    first.size === second.size && first.sha256 === second.sha256
}
