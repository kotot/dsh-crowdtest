import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { buildTar } from '../src/archive.ts'
import { sha256 } from '../src/update-github.ts'

const template = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
export function payload(version: string, platforms?: string[]) {
  const manifest = { ...template, version, dsh: { ...template.dsh, bundle: { ...template.dsh.bundle, platforms } } }
  const files = {
    'package.json': JSON.stringify(manifest), 'lib/index.js': `export const version="${version}"`,
    'lib/client.js': 'export {}', 'cordis.patch.yml': '[]', 'icon.png': 'image', 'README.md': 'fixture',
  }
  const bytes = tar(files)
  const asset = { version, releaseId: 11, assetId: 22, size: bytes.length, sha256: sha256(bytes) }
  return { manifest, files, bytes, asset }
}

export const releaseRoot = 'https://github.com/kotot/dsh-crowdtest/releases'
export const metadataName = 'dsh-crowdtest-update.json'
export const latestUrl = releaseRoot + '/latest/download/' + metadataName
export const taggedUrl = (version: string, name = metadataName) => releaseRoot + '/download/v' + version + '/' + name
export const packageUrl = (version: string) => taggedUrl(version, 'dsh-crowdtest-' + version + '.tgz')
export const latestRedirect = (version: string) => Response.redirect(taggedUrl(version), 302)

export function serveReleases(latest: ReturnType<typeof payload>, ...history: ReturnType<typeof payload>[]): typeof fetch {
  return async url => {
    if (String(url) === latestUrl) return latestRedirect(latest.asset.version)
    for (const release of [latest, ...history]) {
      if (String(url) === taggedUrl(release.asset.version)) return Response.json(release.asset)
      if (String(url) === packageUrl(release.asset.version)) return new Response(release.bytes)
    }
    throw new Error('Unexpected fixture request')
  }
}
export function tar(files: Record<string, string>, mutate?: (raw: Buffer) => void) {
  const raw = Buffer.from(buildTar(Object.entries(files).map(([path, value]) => ({ path: 'package/' + path, content: Buffer.from(value) }))))
  mutate?.(raw)
  return gzipSync(raw)
}
