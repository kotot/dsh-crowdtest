import { expect, it, vi } from 'vitest'
import { verifyArchive } from '../src/update-archive.ts'
import { GitHubReleases, MAX_ARCHIVE } from '../src/update-github.ts'
import { dispatchUpdate } from '../src/update-install.ts'
import { requests, updateDescriptors } from '../src/update-protocol.ts'
import { payload, tar } from './update-fixture.ts'

const next = payload('0.2.16')
const secret = 'unit-test-secret'
const ok = () => true
it('requires an owner before resolving any service, including malformed calls', async () => {
  const get = vi.fn()
  for (const method of Object.keys(requests) as (keyof typeof requests)[]) {
    await expect(dispatchUpdate({ kind: 'user', grants: ['*'] }, method, { token: secret }, get)).rejects.toThrow('仅限所有者')
  }
  for (const field of ['version', 'path', 'url', 'repo', 'credentialRef', 'token']) {
    for (const method of ['inspect', 'check', 'start'] as const) {
      const request = { [field]: secret }
      await expect(dispatchUpdate(undefined, method, request, get)).rejects.toThrow('Invalid CrowdTest')
    }
  }
  expect(Object.keys(requests)).toEqual(['inspect', 'check', 'start'])
  expect(updateDescriptors.map(descriptor => descriptor.method)).toEqual(['inspect', 'check', 'start'])
  expect(get).not.toHaveBeenCalled()
  expect(() => updateDescriptors[0]?.result.decode({ token: secret })).toThrow('Invalid CrowdTest')
})
it('fetches latest, rollback metadata and assets anonymously at every hop', async () => {
  const requests: { url: string; authorization: string | null; cookie: string | null; credentials?: RequestCredentials; redirect?: string }[] = []
  const transport: typeof fetch = async (input, options) => {
    const url = String(input)
    requests.push({ url, redirect: options?.redirect, authorization: new Headers(options?.headers).get('authorization'), cookie: new Headers(options?.headers).get('cookie'), credentials: options?.credentials })
    if (url.endsWith('/latest') || url.endsWith('/tags/v0.2.16')) return Response.json({ ...next.release, assets: [...next.release.assets, { ...next.release.assets[0], id: 27, name: 'dsh-crowdtest.tgz' }] })
    if (url.endsWith('/assets/22')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file?signature=fixture' } })
    return new Response(next.bytes)
  }
  const github = new GitHubReleases(transport)
  const asset = await github.metadata()
  expect(asset).toEqual(next.asset)
  expect(await github.metadata(next.asset.version)).toEqual(next.asset)
  expect(await github.download(asset)).toEqual(next.bytes)
  expect(requests.map(request => request.url)).toEqual([
    'https://api.github.com/repos/kotot/dsh-crowdtest/releases/latest',
    'https://api.github.com/repos/kotot/dsh-crowdtest/releases/tags/v0.2.16',
    'https://api.github.com/repos/kotot/dsh-crowdtest/releases/assets/22',
    'https://release-assets.githubusercontent.com/file?signature=fixture',
  ])
  expect(requests.every(value => value.authorization === null && value.cookie === null && value.credentials === 'omit')).toBe(true)
  expect(requests.every(value => value.redirect === 'manual')).toBe(true)
})
it.each(['http://objects.githubusercontent.com/a', 'https://objects.githubusercontent.com.example.test/a',
  'https://user@objects.githubusercontent.com/a', 'https://objects.githubusercontent.com:8443/a',
  'https://api.github.com/user', 'https://example.test/asset'])('rejects an unsafe redirect before a second request (%s)', async location => {
  const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location } }))
  await expect(new GitHubReleases(transport).download(next.asset)).rejects.toMatchObject({ code: 'release' })
  expect(transport).toHaveBeenCalledTimes(1)
})
it('bounds chained redirects and never follows a metadata redirect', async () => {
  const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/next' } }))
  const github = new GitHubReleases(transport)
  await expect(github.download(next.asset)).rejects.toThrow()
  expect(transport).toHaveBeenCalledTimes(4)
  transport.mockClear()
  await expect(github.metadata()).rejects.toThrow()
  expect(transport).toHaveBeenCalledTimes(1)
})
it.each([
  { draft: true }, { prerelease: true }, { tag_name: 'v0.2.16-rc.1' }, { tag_name: 'vOops' },
  { assets: [] }, { assets: [...next.release.assets, ...next.release.assets] },
  { assets: [{ ...next.release.assets[0], size: MAX_ARCHIVE + 1 }] },
  { assets: [{ ...next.release.assets[0], digest: null }] },
  { assets: [{ ...next.release.assets[0], name: 'dsh-crowdtest-0.2.15.tgz' }] },
])('rejects invalid or ambiguous release metadata %#', async overrides => {
  const github = new GitHubReleases(async () => Response.json({ ...next.release, ...overrides }))
  await expect(github.metadata()).rejects.toMatchObject({ code: 'release' })
})
it('rejects body length and digest mismatches, and sanitizes error bodies and transport exceptions', async () => {
  for (const bytes of [Buffer.alloc(4), Buffer.alloc(next.bytes.length + 1), Buffer.alloc(next.bytes.length)]) {
    await expect(new GitHubReleases(async () => new Response(bytes)).download(next.asset)).rejects.toMatchObject({ code: 'archive' })
  }
  for (const status of [401, 403, 404, 429, 500]) {
    const error = await new GitHubReleases(async () => new Response(secret, { status })).metadata().catch(value => value)
    expect(error.message).not.toContain(secret)
    expect(error.message).not.toMatch(/令牌|PAT|Contents/)
    if (status === 429) expect(error.code).toBe('rate')
    if ([401, 403, 404].includes(status)) expect(error.code).toBe('access')
  }
  await expect(new GitHubReleases(async () => { throw Error(secret) }).metadata()).rejects.toMatchObject({ code: 'network' })
})
it.each([
  { header: 'x-ratelimit-remaining', value: '0', code: 'rate' },
  { header: 'retry-after', value: '60', code: 'rate' },
  { header: 'x-ratelimit-remaining', value: '1', code: 'access' },
])('classifies anonymous GitHub 403 limits from response headers %#', async ({ header, value, code }) => {
  const github = new GitHubReleases(async () => new Response('private error body', { status: 403, headers: { [header]: value } }))
  await expect(github.metadata()).rejects.toMatchObject({ code })
})
it('rejects invalid rollback versions and mismatched tagged releases', async () => {
  const transport = vi.fn(async () => Response.json(next.release))
  const github = new GitHubReleases(transport)
  await expect(github.metadata('../outside')).rejects.toMatchObject({ code: 'release' })
  expect(transport).not.toHaveBeenCalled()
  await expect(github.metadata('0.2.15')).rejects.toMatchObject({ code: 'release' })
  expect(transport).toHaveBeenCalledTimes(1)
})
it('accepts the npm bundle shape and delegates compatibility to the native evaluator', async () => {
  const compatible = vi.fn(ok)
  expect((await verifyArchive(next.bytes, '0.2.16', compatible)).files.size).toBe(6)
  expect(compatible).toHaveBeenCalledWith(expect.objectContaining({ name: 'dsh-crowdtest', version: '0.2.16', peerDependencies: next.manifest.peerDependencies }))
  await expect(verifyArchive(next.bytes, '0.2.16', () => false)).rejects.toMatchObject({ code: 'compatibility' })
})
it.each([
  { name: 'unrelated-package' }, { version: '0.2.15' }, { main: 'unexpected.js' }, { exports: {} },
  { dsh: { bundle: { patch: '../outside' } } }, { engines: {} },
  { dependencies: { another: '*' } }, { scripts: { install: 'fixture' } }, { peerDependencies: { external: '*' } },
])('rejects wrong package identity or entry points %#', async changes => {
  const files = { ...next.files, 'package.json': JSON.stringify({ ...next.manifest, ...changes }) }
  await expect(verifyArchive(tar(files), next.manifest.version, ok)).rejects.toMatchObject({ code: 'archive' })
})
it('rejects missing entries, traversal, links, duplicate names and trailing members without extracting', async () => {
  const { 'lib/client.js': ignored, ...missingFile } = next.files
  const extra = tar({ ...next.files, '../outside': 'fixture' })
  const checksum = (header: Buffer) => {
    header.fill(32, 148, 156)
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  }
  const link = tar(next.files, raw => { raw[156] = 50; checksum(raw.subarray(0, 512)) })
  const duplicateEntries = tar(next.files, raw => {
    const index = raw.indexOf('package/README.md')
    raw.fill(0, index, index + 100); raw.write('package/icon.png', index); checksum(raw.subarray(index, index + 512))
  })
  const trailing = tar(next.files, raw => { raw[raw.length - 1] = 1 })
  for (const data of [tar(missingFile), extra, link, duplicateEntries, trailing, Buffer.alloc(MAX_ARCHIVE + 1), Buffer.from('invalid')]) {
    await expect(verifyArchive(data, next.manifest.version, ok)).rejects.toMatchObject({ code: 'archive' })
  }
})

it('bounds expanded archive size even for a small, otherwise valid compressed file', async () => {
  const packed = tar({ ...next.files, 'README.md': 'x'.repeat(32 * 1024 * 1024) })
  expect(packed.byteLength).toBeLessThan(MAX_ARCHIVE)
  await expect(verifyArchive(packed, next.asset.version, ok)).rejects.toMatchObject({ code: 'archive' })
})
