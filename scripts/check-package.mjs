import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import minVersion from 'semver/ranges/min-version.js'
import lt from 'semver/functions/lt.js'

export const PUBLICATION_PATHS = [
  'README.md',
  'cordis.patch.yml',
  'icon.png',
  'lib/client.js',
  'lib/index.js',
  'package.json',
  'usage-guide.png',
]

const RESTRICTED_CONTENT = [
  ['private platform address', /\b[a-z0-9-]+\.apigateway-cn-[a-z0-9-]+\.volceapi\.com\b/i],
  ['registry credential', /^\s*(?:\/\/[^\s]+:)?(?:_authToken|_auth|_password)\s*=\s*[^\s$]+/im],
  ['npm token', /\bnpm_[A-Za-z0-9]{36,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
]

export function scanRestrictedContent(content) {
  return RESTRICTED_CONTENT.filter(([, pattern]) => pattern.test(content)).map(([kind]) => kind)
}

export function verifyPublicationPaths(paths) {
  const unexpected = paths.filter(path => !PUBLICATION_PATHS.includes(path))
  const missing = PUBLICATION_PATHS.filter(path => !paths.includes(path))
  if (unexpected.length || missing.length || paths.length !== PUBLICATION_PATHS.length) {
    throw new Error(`Publication file list rejected. Unexpected: ${unexpected.join(', ') || 'none'}. Missing: ${missing.join(', ') || 'none'}.`)
  }
}

export function publicationPathsFromReport(output, manifest) {
  const value = JSON.parse(output)
  const report = Array.isArray(value) ? value[0] : value?.[manifest.name]
  if (!report || report.name !== manifest.name || report.version !== manifest.version || !Array.isArray(report.files)) {
    throw new Error('npm pack returned an invalid package report.')
  }
  if (report.files.some(file => typeof file?.path !== 'string')) throw new Error('npm pack returned an invalid file list.')
  return report.files.map(file => file.path)
}

const SOURCE_FILES = new Set([
  '.gitignore', '.npmrc', '.github/workflows/release.yml', 'README.md', 'build.mjs', 'cordis.patch.yml',
  'docs/DEVELOPMENT.md', 'icon.png', 'usage-guide.png', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vitest.config.ts',
  'scripts/check-package.mjs', 'scripts/mock-crowdtest.mjs',
])

export async function checkSource(directory = process.cwd()) {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: directory, encoding: 'utf8' }).split('\0').filter(Boolean)
  for (const name of names) {
    if (!SOURCE_FILES.has(name) && !/^(?:src\/(?:client\/)?|tests\/)[a-z][a-z0-9.-]*\.(?:ts|tsx|jsx|mjs)$/.test(name)) {
      throw new Error(`Unexpected source file: ${name}`)
    }
    if (name === 'icon.png' || name === 'usage-guide.png') continue
    const kinds = scanRestrictedContent(await readFile(resolve(directory, name), 'utf8'))
    if (kinds.length) throw new Error(`Source rejected: ${name} contains a possible ${kinds.join(', ')}.`)
  }
  return names.length
}

export async function checkPackage(directory = process.cwd()) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
  verifyPublicationPaths(['package.json', ...manifest.files])
  const minimum = typeof manifest.engines?.dsh === 'string' ? minVersion(manifest.engines.dsh) : null
  if (!minimum || lt(minimum, '0.2.2-rc.1')) throw new Error('Package must require the DSH updater APIs in 0.2.2-rc.1.')
  if (manifest.main !== 'lib/index.js' || manifest.exports?.['.'] !== './lib/index.js' ||
      manifest.exports?.['./client'] !== './lib/client.js' || manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error('Package must declare the CrowdTest host, client and bundle patch entry points.')
  }
  if (manifest.icon !== './icon.png') throw new Error('Package icon must refer to ./icon.png.')
  const entryPoints = [manifest.main, ...Object.values(manifest.exports), manifest.dsh?.bundle?.patch]
  if (entryPoints.some(path => typeof path !== 'string' || !PUBLICATION_PATHS.includes(path.replace(/^\.\//, '')))) {
    throw new Error('Package entry points must refer to publication files.')
  }
  const args = ['pack', '--dry-run', '--ignore-scripts', '--json', '--offline']
  let output
  try {
    output = process.env.npm_execpath
      ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      : execFileSync('npm', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new Error('Could not inspect npm publication files. Run npm pack --dry-run --ignore-scripts --json --offline to diagnose.')
  }
  const paths = publicationPathsFromReport(output, manifest)
  verifyPublicationPaths(paths)
  for (const path of paths) {
    const content = await readFile(resolve(directory, path))
    if (path === 'icon.png' || path === 'usage-guide.png') {
      const maxBytes = path === 'icon.png' ? 256 * 1024 : 5 * 1024 * 1024
      const limit = path === 'icon.png' ? '256 KiB' : '5 MiB'
      if (content.length > maxBytes || !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error(`Publication rejected: ${path} must be a PNG no larger than ${limit}.`)
      }
      continue
    }
    const kinds = scanRestrictedContent(content.toString('utf8'))
    if (kinds.length) throw new Error(`Publication rejected: ${path} contains a possible ${kinds.join(', ')}. Credential values are hidden.`)
  }
  return { name: manifest.name, version: manifest.version, paths }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--source')) {
      console.log(`Checked ${await checkSource()} source files.`)
    } else {
      const result = await checkPackage()
      console.log(`Checked ${result.name}@${result.version} with ${result.paths.length} release files.`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Publication check failed.')
    process.exitCode = 1
  }
}
