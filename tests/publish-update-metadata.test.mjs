import { expect, it, vi } from 'vitest'
import { backfill, publishRelease } from '../scripts/publish-update-metadata.mjs'
import { sha256 } from '../src/update-github.ts'
import { metadataName, payload, tar } from './update-fixture.ts'

const commit = 'a'.repeat(40)
const current = payload('0.3.0')
const name = version => 'dsh-crowdtest-' + version + '.tgz'
const targetAssets = [name(current.asset.version), 'dsh-crowdtest.tgz', metadataName]

function repository() {
  const releases = []
  const tags = new Map()
  const files = new Map()
  let nextId = 1
  function create(tag, draft = false) {
    const release = { id: nextId++, tag_name: tag, draft, prerelease: false, assets: [] }
    releases.push(release)
    return release
  }
  function add(release, name, bytes) {
    const asset = { id: nextId++, name, state: 'uploaded', size: bytes.length, digest: 'sha256:' + sha256(bytes) }
    files.set(asset.id, bytes)
    release.assets.push(asset)
    return asset
  }
  const api = {
    releases: () => structuredClone(releases),
    release: id => structuredClone(releases.find(release => release.id === id)),
    download: (id, limit) => {
      const bytes = files.get(id)
      if (bytes.length > limit) throw new Error('Download exceeds limit')
      return bytes
    },
    createTag: vi.fn((tag, sha) => tags.set(tag, sha)),
    hasTag: tag => tags.has(tag),
    tagCommit: tag => tags.get(tag),
    createDraft: vi.fn(tag => structuredClone(create(tag, true))),
    publishDraft: vi.fn(id => { releases.find(release => release.id === id).draft = false }),
    upload: vi.fn(async (tag, name, bytes) => {
      const release = releases.find(release => release.tag_name === tag)
      if (release.assets.some(asset => asset.name === name)) throw new Error('Asset already exists')
      add(release, name, bytes)
    }),
  }
  function historical(version) {
    const release = create('v' + version)
    const { bytes } = payload(version)
    tags.set(release.tag_name, 'b'.repeat(40))
    const archive = add(release, name(version), bytes)
    return { release, archive, bytes }
  }
  const publish = () => publishRelease(api, { commit, version: current.asset.version, bytes: current.bytes, allowCreateTag: true })
  return { api, create, add, historical, tags, files, releases, publish }
}

it('backfills only published supported stable archives and preserves their identities on replay', async () => {
  const { api, create, historical, files, tags } = repository()
  const history = ['0.2.14', '0.2.15', '0.2.16', '0.2.17'].map(historical)
  history[0].archive.digest = null
  for (const tag of ['nightly', 'v0.2.13', 'v0.2.11', 'v0.2.99+test', 'v0.2.99-rc.1']) create(tag)
  create('v1.0.0', true)
  create('v1.0.1').prerelease = true
  const oldTags = new Map(tags)
  await backfill(api, api.releases())
  expect(api.upload.mock.calls.map(([tag, file]) => [tag, file])).toEqual(history.map(({ release }) => [release.tag_name, metadataName]))
  for (const { release, archive, bytes } of history) {
    expect(release.assets).toHaveLength(2)
    expect(release.assets[0]).toBe(archive)
    expect(files.get(archive.id)).toBe(bytes)
    const manifest = JSON.parse(files.get(release.assets[1].id))
    expect(manifest).toEqual({ version: release.tag_name.slice(1), releaseId: release.id, assetId: archive.id, size: bytes.length, sha256: sha256(bytes) })
  }
  const first = api.releases()
  await backfill(api, api.releases())
  expect(api.releases()).toEqual(first)
  expect(api.upload).toHaveBeenCalledTimes(4)
  expect(tags).toEqual(oldTags)
  expect(api.createDraft).not.toHaveBeenCalled()
  expect(api.publishDraft).not.toHaveBeenCalled()
})

it.each(['missing', 'duplicate', 'wrong name', 'wrong version', 'wrong package', 'digest', 'size', 'state', 'invalid release ID', 'manifest differs'])(
  'rejects a bad supported release before creating the next release (%s)', async problem => {
    const { api, publish, historical, add, files } = repository()
    const { release, archive } = historical('0.2.17')
    if (problem === 'missing') release.assets = []
    if (problem === 'duplicate') release.assets.push(archive)
    if (problem === 'wrong name') archive.name = 'dsh-crowdtest.tgz'
    if (problem === 'wrong version' || problem === 'wrong package') {
      const old = payload('0.2.17')
      const bytes = problem === 'wrong version' ? current.bytes : tar({ ...old.files, 'package.json': JSON.stringify({ ...old.manifest, name: 'other' }) })
      files.set(archive.id, bytes)
      Object.assign(archive, { size: bytes.length, digest: null })
    }
    if (problem === 'digest') archive.digest = 'sha256:' + '0'.repeat(64)
    if (problem === 'size') archive.size++
    if (problem === 'state') archive.state = 'starter'
    if (problem === 'invalid release ID') release.id = 0
    if (problem === 'manifest differs') add(release, metadataName, Buffer.from('{}'))
    await expect(publish()).rejects.toThrow()
    expect(api.upload).not.toHaveBeenCalled()
    expect(api.createTag).not.toHaveBeenCalled()
    expect(api.createDraft).not.toHaveBeenCalled()
    expect(api.publishDraft).not.toHaveBeenCalled()
  })

it('stages new packages after backfill, publishes the manifest last and resumes a partial release', async () => {
  const { historical, api, publish, releases, files } = repository()
  historical('0.2.17')
  const tag = 'v' + current.asset.version
  const upload = api.upload.getMockImplementation()
  api.upload.mockImplementation(async (...args) => {
    if (args[0] === tag && args[1] === metadataName) throw new Error('Disconnected')
    return upload(...args)
  })
  await expect(publish()).rejects.toThrow('Disconnected')
  expect(releases[1].draft).toBe(true)
  expect(api.publishDraft).not.toHaveBeenCalled()
  const packages = structuredClone(releases[1].assets)
  api.upload.mockImplementation(upload)
  await publish()
  expect(api.upload.mock.calls.map(([tag, name]) => [tag, name])).toEqual([
    ['v0.2.17', metadataName], [tag, name(current.asset.version)], [tag, 'dsh-crowdtest.tgz'], [tag, metadataName], [tag, metadataName],
  ])
  expect(releases[1].assets.slice(0, 2)).toEqual(packages)
  for (const file of packages) expect(files.get(file.id)).toEqual(current.bytes)
  expect(releases[1].draft).toBe(false)
  const complete = api.releases()
  await publish()
  expect(api.releases()).toEqual(complete)
  expect(api.upload).toHaveBeenCalledTimes(5)
  expect(api.publishDraft).toHaveBeenCalledTimes(1)
})

it.each([name(current.asset.version), 'dsh-crowdtest.tgz', metadataName])('refuses to replace different existing bytes for %s', async assetName => {
  const { historical, add, publish, tags, api } = repository()
  const { release, archive } = historical(current.asset.version)
  tags.set(release.tag_name, commit)
  if (assetName === archive.name) release.assets = []
  add(release, assetName, Buffer.from('conflicting bytes'))
  await expect(publish()).rejects.toThrow()
  expect(api.upload.mock.calls.every(([, name]) => name !== assetName)).toBe(true)
  expect(api.publishDraft).not.toHaveBeenCalled()
})

it('rejects a different existing tag commit before writing any assets', async () => {
  const { historical, publish, tags, api } = repository()
  historical('0.2.17')
  tags.set('v' + current.asset.version, 'c'.repeat(40))
  await expect(publish()).rejects.toThrow('another commit')
  expect(api.upload).not.toHaveBeenCalled()
  expect(api.createTag).not.toHaveBeenCalled()
})

it.each(targetAssets.flatMap(asset => ['missing', 'corrupt'].map(problem => [asset, problem])))(
  'keeps the draft private when the uploaded %s is %s', async (assetName, problem) => {
    const { api, releases, publish } = repository()
    const upload = api.upload.getMockImplementation()
    api.upload.mockImplementation(async (tag, file, bytes) => {
      if (file !== assetName) return upload(tag, file, bytes)
      if (problem === 'corrupt') return upload(tag, file, Buffer.alloc(bytes.length))
    })
    await expect(publish()).rejects.toThrow()
    expect(releases[0].draft).toBe(true)
    expect(api.publishDraft).not.toHaveBeenCalled()
    expect(api.upload.mock.calls.map(([, file]) => file)).toEqual(targetAssets.slice(0, targetAssets.indexOf(assetName) + 1))
  })

it.each(targetAssets.flatMap(asset => ['missing', 'conflicting'].map(problem => [asset, problem])))(
  'performs no writes when a published target has a %s asset that is %s', async (assetName, problem) => {
    const { api, publish, releases, historical, files } = repository()
    await publish()
    const release = releases[0]
    const asset = release.assets.find(asset => asset.name === assetName)
    if (problem === 'missing') release.assets = release.assets.filter(other => other !== asset)
    else {
      const bytes = Buffer.alloc(asset.size)
      files.set(asset.id, bytes)
      asset.digest = 'sha256:' + sha256(bytes)
    }
    historical('0.2.17')
    vi.clearAllMocks()
    await expect(publish()).rejects.toThrow()
    expect(api.upload).not.toHaveBeenCalled()
    expect(api.publishDraft).not.toHaveBeenCalled()
    expect(api.createTag).not.toHaveBeenCalled()
    expect(api.createDraft).not.toHaveBeenCalled()
  })

it('replays an identical published target without writing to any release', async () => {
  const { api, publish, historical } = repository()
  await publish()
  historical('0.2.17')
  const before = api.releases()
  vi.clearAllMocks()
  await publish()
  expect(api.releases()).toEqual(before)
  expect(api.upload).not.toHaveBeenCalled()
  expect(api.publishDraft).not.toHaveBeenCalled()
  expect(api.createTag).not.toHaveBeenCalled()
  expect(api.createDraft).not.toHaveBeenCalled()
})
