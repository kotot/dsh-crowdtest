import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import gte from 'semver/functions/gte.js'
import { verifyArchive } from '../src/update-archive.ts'
import { assetSchema, MAX_ARCHIVE, METADATA_NAME, sha256, stableVersion } from '../src/update-github.ts'
import { PACKAGE } from '../src/update-protocol.ts'

const repository = 'kotot/dsh-crowdtest'
const versionedName = version => `${PACKAGE}-${version}.tgz`
const positiveId = id => Number.isSafeInteger(id) && id > 0

function releaseAsset(release, name) {
  const matches = release.assets.filter(asset => asset.name === name)
  if (matches.length > 1) throw new Error(`Duplicate asset: ${name}`)
  return matches[0]
}

function verifiedBytes(api, asset, limit) {
  if (!positiveId(asset.id) || asset.state !== 'uploaded' || !positiveId(asset.size) || asset.size > limit) {
    throw new Error('Invalid release asset')
  }
  const bytes = api.download(asset.id, limit)
  if (bytes.length !== asset.size || (asset.digest != null && asset.digest !== 'sha256:' + sha256(bytes))) {
    throw new Error('Release asset size or digest mismatch')
  }
  return bytes
}

async function ensureAsset(api, release, name, bytes, allowUpload) {
  let asset = releaseAsset(release, name)
  if (!asset && allowUpload) {
    await api.upload(release.tag_name, name, bytes)
    const refreshed = api.release(release.id)
    if (refreshed.id !== release.id || refreshed.tag_name !== release.tag_name ||
        refreshed.draft !== release.draft || refreshed.prerelease !== false) throw new Error('Release changed during upload')
    asset = releaseAsset(refreshed, name)
  }
  if (!asset) throw new Error(`Missing ${name}`)
  if (!verifiedBytes(api, asset, bytes.length).equals(bytes)) throw new Error(`Different published bytes: ${name}`)
  return asset
}

function verifyRelease(release, version) {
  if (!positiveId(release.id) || release.tag_name !== 'v' + version || typeof release.draft !== 'boolean' || release.prerelease !== false) {
    throw new Error('Unexpected release identity')
  }
}

function metadataBytes(release, version, archive, bytes) {
  const metadata = assetSchema.parse({ version, releaseId: release.id, assetId: archive.id, size: bytes.length, sha256: sha256(bytes) })
  return Buffer.from(JSON.stringify(metadata, null, 2) + '\n')
}

async function ensureReleaseAssets(api, release, version, bytes) {
  verifyRelease(release, version)
  const archive = await ensureAsset(api, release, versionedName(version), bytes, release.draft)
  await ensureAsset(api, release, PACKAGE + '.tgz', bytes, release.draft)
  await ensureAsset(api, release, METADATA_NAME, metadataBytes(release, version, archive, bytes), release.draft)
}

export async function backfill(api, releases, excludeTag) {
  for (const release of releases) {
    const tag = release.tag_name
    if (tag === excludeTag || release.draft || release.prerelease || !tag.startsWith('v')) continue
    const version = tag.slice(1)
    if (!stableVersion(version) || !gte(version, '0.2.14')) continue
    verifyRelease(release, version)
    const name = versionedName(version)
    const archive = releaseAsset(release, name)
    if (!archive) throw new Error(`Missing ${name}`)
    const bytes = verifiedBytes(api, archive, MAX_ARCHIVE)
    await verifyArchive(bytes, version, () => true)
    await ensureAsset(api, release, METADATA_NAME, metadataBytes(release, version, archive, bytes), true)
  }
}

export async function publishRelease(api, { version, commit, allowCreateTag, bytes }) {
  if (!stableVersion(version) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release tag or commit')
  const tag = 'v' + version
  await verifyArchive(bytes, version, () => true)
  const verifyTag = () => {
    if (api.tagCommit(tag) !== commit) throw new Error('The release tag points to another commit')
  }
  const exists = api.hasTag(tag)
  if (exists || !allowCreateTag) verifyTag()
  const releases = api.releases()
  const existing = releases.find(release => release.tag_name === tag)
  if (existing?.prerelease) throw new Error('Cannot publish over a prerelease')
  if (existing && !existing.draft) {
    verifyTag()
    await ensureReleaseAssets(api, existing, version, bytes)
    return
  }
  await backfill(api, releases, tag)
  if (!exists && allowCreateTag) api.createTag(tag, commit)
  verifyTag()
  const release = existing ?? api.createDraft(tag)
  if (!release.draft) throw new Error('Expected a draft release')
  await ensureReleaseAssets(api, release, version, bytes)
  api.publishDraft(release.id)
}

function github() {
  function gh(args, maxBuffer = MAX_ARCHIVE) {
    try {
      return execFileSync('gh', args, { maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch { throw new Error(`GitHub ${args[0]} request failed`) }
  }
  const api = (path, ...args) => gh(['api', 'repos/' + repository + '/' + path, ...args])
  const json = (path, ...args) => JSON.parse(api(path, ...args).toString('utf8'))
  return {
    releases: () => json('releases?per_page=100', '--paginate', '--slurp').flat(),
    release: id => json('releases/' + id),
    download: (id, limit) => gh(['api', 'repos/' + repository + '/releases/assets/' + id, '-H', 'Accept: application/octet-stream'], limit),
    hasTag: tag => json('git/matching-refs/tags/' + tag).some(ref => ref.ref === 'refs/tags/' + tag),
    tagCommit: tag => json('commits/tags%2F' + tag).sha,
    createTag: (tag, commit) => api('git/refs', '-f', 'ref=refs/tags/' + tag, '-f', 'sha=' + commit),
    createDraft: tag => json('releases', '-f', 'tag_name=' + tag, '-F', 'draft=true', '-F', 'generate_release_notes=true'),
    publishDraft: id => api('releases/' + id, '--method', 'PATCH', '-F', 'draft=false'),
    async upload(tag, name, bytes) {
      const directory = await mkdtemp(join(tmpdir(), 'crowdtest-release-'))
      try {
        const path = join(directory, name)
        await writeFile(path, bytes)
        gh(['release', 'upload', tag, path, '--repo', repository])
      } finally { await rm(directory, { recursive: true, force: true }) }
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { GITHUB_ACTIONS, GITHUB_REPOSITORY, GITHUB_REF, GITHUB_EVENT_NAME, GITHUB_SHA, GH_TOKEN } = process.env
  if (GITHUB_ACTIONS !== 'true' || GITHUB_REPOSITORY !== repository || !GH_TOKEN) throw new Error('Requires the release workflow')
  const api = github()
  const dispatch = GITHUB_EVENT_NAME === 'workflow_dispatch'
  if (!dispatch && GITHUB_EVENT_NAME !== 'push') throw new Error('Unexpected release event')
  if (dispatch && GITHUB_REF !== 'refs/heads/main') throw new Error('Dispatch the workflow on main')
  if (process.argv.length === 3 && process.argv[2] === '--metadata-only' && dispatch) {
    await backfill(api, api.releases())
  } else if (process.argv.length === 2) {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    if (!stableVersion(version) || (!dispatch && GITHUB_REF !== 'refs/tags/v' + version)) throw new Error('Unexpected release ref')
    await publishRelease(api, { version, commit: GITHUB_SHA, allowCreateTag: dispatch, bytes: await readFile(versionedName(version)) })
  } else throw new Error('Unknown release mode')
}
