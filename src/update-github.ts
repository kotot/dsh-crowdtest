import { createHash } from 'node:crypto'
import valid from 'semver/functions/valid.js'
import prerelease from 'semver/functions/prerelease.js'
import * as z from 'zod/mini'
import { digest, PACKAGE, UpdateError, versionText } from './update-protocol.ts'

const RELEASES = 'https://api.github.com/repos/kotot/dsh-crowdtest/releases'
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
export const MAX_ARCHIVE = 16 * 1024 * 1024
const positiveInt = z.int().check(z.positive())
export const assetSchema = z.strictObject({
  version: versionText, releaseId: positiveInt, assetId: positiveInt, size: positiveInt.check(z.lte(MAX_ARCHIVE)), sha256: digest,
})
export type ReleaseAsset = z.infer<typeof assetSchema>
const release = z.object({
  id: positiveInt, tag_name: z.string(), draft: z.literal(false), prerelease: z.literal(false),
  assets: z.array(z.object({ name: z.string(), id: positiveInt, size: positiveInt, digest: z.nullable(z.string()) })),
})
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function releaseAsset(json: unknown): ReleaseAsset {
  const parsed = release.safeParse(json)
  if (!parsed.success) throw new UpdateError('release')
  const { id, assets, tag_name: tag } = parsed.data
  const version = tag.slice(1)
  if (!tag.startsWith('v') || !valid(version) || prerelease(version) || !/^[0-9]/.test(version)) throw new UpdateError('release')
  const matches = assets.filter(asset => asset.name === `${PACKAGE}-${version}.tgz`)
  const asset = matches[0]
  if (!asset || matches.length !== 1 || !asset.digest?.startsWith('sha256:')) throw new UpdateError('release')
  const result = assetSchema.safeParse({ version, releaseId: id, assetId: asset.id, size: asset.size, sha256: asset.digest.slice(7) })
  if (!result.success) throw new UpdateError('release')
  return result.data
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
  private async request(path: string, limit: number, asset: boolean): Promise<Buffer> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 45_000)
    try {
      let url = new URL(path)
      for (let hop = 0; hop <= 3; hop++) {
        const headers: Record<string, string> = { Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json' }
        if (url.origin === 'https://api.github.com') {
          headers['X-GitHub-Api-Version'] = '2022-11-28'
        }
        const response = await this.transport(url.href, { headers, redirect: 'manual', signal: abort.signal, credentials: 'omit' })
        if (response.status === 200) return await readBody(response, limit)
        await response.body?.cancel()
        if (response.status === 429 || response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) throw new UpdateError('rate')
        if ([401, 403, 404].includes(response.status)) throw new UpdateError('access')
        if (!asset || ![301, 302, 303, 307, 308].includes(response.status)) throw new UpdateError('network')
        const location = response.headers.get('location')
        if (!location) throw new UpdateError('release')
        const next = new URL(location, url)
        if (next.protocol !== 'https:' || next.username || next.password || next.port || !ASSET_HOSTS.has(next.hostname)) throw new UpdateError('release')
        url = next
      }
      throw new UpdateError('release')
    } catch (error) {
      throw error instanceof UpdateError ? error : new UpdateError('network')
    } finally { clearTimeout(timer); abort.abort() }
  }
  async metadata(version?: string): Promise<ReleaseAsset> {
    if (version !== undefined && (!valid(version) || !/^[0-9]/.test(version))) throw new UpdateError('release')
    const route = version === undefined ? 'latest' : `tags/v${encodeURIComponent(version)}`
    const data = await this.request(`${RELEASES}/${route}`, 512 * 1024, false)
    try {
      const result = releaseAsset(JSON.parse(data.toString('utf8')))
      if (version !== undefined && result.version !== version) throw new UpdateError('release')
      return result
    } catch { throw new UpdateError('release') }
  }
  async download(asset: ReleaseAsset): Promise<Buffer> {
    const data = await this.request(`${RELEASES}/assets/${asset.assetId}`, asset.size, true)
    if (data.length !== asset.size || sha256(data) !== asset.sha256) throw new UpdateError('archive')
    return data
  }
}
export function sameAsset(first: ReleaseAsset, second: ReleaseAsset): boolean {
  return first.version === second.version && first.releaseId === second.releaseId && first.assetId === second.assetId &&
    first.size === second.size && first.sha256 === second.sha256
}
