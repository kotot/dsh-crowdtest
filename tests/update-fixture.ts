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
  const release = {
    id: asset.releaseId, tag_name: 'v' + version, draft: false, prerelease: false,
    assets: [{ name: `dsh-crowdtest-${version}.tgz`, id: asset.assetId, size: asset.size, digest: 'sha256:' + asset.sha256 }],
  }
  return { manifest, files, bytes, asset, release }
}
export function tar(files: Record<string, string>, mutate?: (raw: Buffer) => void) {
  const raw = Buffer.from(buildTar(Object.entries(files).map(([path, value]) => ({ path: 'package/' + path, content: Buffer.from(value) }))))
  mutate?.(raw)
  return gzipSync(raw)
}
