import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPackage, PUBLICATION_PATHS, publicationPathsFromReport, scanRestrictedContent, verifyPublicationPaths } from '../scripts/check-package.mjs'

const directories = []
const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'crowdtest-package-'))
  directories.push(directory)
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  await mkdir(join(directory, 'lib'))
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
  for (const path of PUBLICATION_PATHS.filter(path => path !== 'package.json')) {
    await writeFile(join(directory, path), path === 'icon.png' ? icon : 'clean publication fixture\n')
  }
  return directory
}

describe('npm publication boundary', () => {
  it('rejects unexpected files and missing build artifacts', () => {
    expect(() => verifyPublicationPaths([...PUBLICATION_PATHS, '.npmrc'])).toThrow(/Unexpected: .npmrc/)
    expect(() => verifyPublicationPaths(PUBLICATION_PATHS.filter(path => path !== 'lib/client.js'))).toThrow(/Missing: lib\/client.js/)
  })

  it('accepts the npm 11 array and npm 12 package-keyed report shapes', () => {
    const manifest = { name: 'dsh-crowdtest', version: '0.2.7' }
    const report = { ...manifest, files: PUBLICATION_PATHS.map(path => ({ path })) }
    expect(publicationPathsFromReport(JSON.stringify([report]), manifest)).toEqual(PUBLICATION_PATHS)
    expect(publicationPathsFromReport(JSON.stringify({ [manifest.name]: report }), manifest)).toEqual(PUBLICATION_PATHS)
    expect(() => publicationPathsFromReport(JSON.stringify({ [manifest.name]: { ...report, version: '0.0.0' } }), manifest)).toThrow(/invalid package report/)
  })

  it('checks the actual clean npm pack file list without invoking lifecycle scripts', async () => {
    const directory = await fixture()
    const result = await checkPackage(directory)
    expect(result.paths.toSorted()).toEqual(PUBLICATION_PATHS.toSorted())
  })

  it('rejects a missing bundle reported by npm pack', async () => {
    const directory = await fixture()
    await rm(join(directory, 'lib/client.js'))
    await expect(checkPackage(directory)).rejects.toThrow(/Missing: lib\/client.js/)
  })

  it('rejects a missing icon reported by npm pack', async () => {
    const directory = await fixture()
    await rm(join(directory, 'icon.png'))
    await expect(checkPackage(directory)).rejects.toThrow(/Missing: icon\.png/)
  })

  it.each([
    ['invalid', Buffer.from('not a PNG')],
    ['oversize', Buffer.concat([icon, Buffer.alloc(256 * 1024)])],
  ])('rejects a published icon with %s content', async (_, content) => {
    const directory = await fixture()
    await writeFile(join(directory, 'icon.png'), content)
    await expect(checkPackage(directory)).rejects.toThrow(/icon\.png must be a PNG no larger than 256 KiB/)
  })

  it.each([undefined, './README.md'])('rejects an icon declaration that does not match the published PNG (%s)', async iconPath => {
    const directory = await fixture()
    const path = join(directory, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.icon = iconPath
    await writeFile(path, JSON.stringify(manifest))
    await expect(checkPackage(directory)).rejects.toThrow(/Package icon must refer to \.\/icon\.png/)
  })

  it.each([
    ['private platform address', ['fixture', 'apigateway-cn-test', 'volceapi', 'com'].join('.')],
    ['registry credential', ['//registry.example/:_authToken', 'dummy'].join('=')],
    ['npm token', `npm_${'x'.repeat(36)}`],
    ['private key', ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')],
  ])('rejects a fake %s in a publishable file without exposing its value', async (kind, secret) => {
    const directory = await fixture()
    await writeFile(join(directory, 'lib/index.js'), secret)
    expect(scanRestrictedContent(secret)).toContain(kind)
    const error = await checkPackage(directory).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain(`lib/index.js contains a possible ${kind}`)
    expect(error.message).not.toContain(secret)
  })
})
