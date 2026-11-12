import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import inc from 'semver/functions/inc.js'
import { expect, it, vi } from 'vitest'
import { PLUGIN_VERSION } from '../src/version.ts'
import { payload } from './update-fixture.ts'

it('constructs and calls the native updater without accessing the credential service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crowdtest-native-update-'))
  const target = payload(inc(PLUGIN_VERSION, 'patch'))
  try {
    const modules = {
      cordis: `export class Service { constructor(ctx, name) { this.ctx = ctx; ctx[name] = this } }`,
      'dsh-typert-protocol': `export const Remote = () => {}; export const bindTypertRemote = () => ({}); export const principalOf = invocation => invocation;`,
      'dsh-app-boot': `export const assertBundlePlatform = () => {}; export const evaluatePluginCompatibility = () => undefined; export const getDshRuntimeVersion = () => '0.2.2-rc.1';`,
      'dsh-atomic-write': `import { writeFile } from 'node:fs/promises'; export const withFileLock = async (_file, action) => action(); export const writeFileAtomic = writeFile;`,
    }
    for (const [name, source] of Object.entries(modules)) {
      const path = join(directory, 'node_modules', '@deepseek-ai', name)
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
      await writeFile(join(path, 'index.js'), source)
    }
    const outfile = join(directory, 'updater.mjs')
    await build({ entryPoints: ['src/update-remote.ts'], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' })
    const profile = join(directory, 'profile')
    await mkdir(join(profile, 'node_modules', 'dsh-crowdtest'), { recursive: true })
    const ctx = {
      profileContext: { dir: profile },
      pluginManager: { listBundles: async () => [{ name: 'dsh-crowdtest', version: PLUGIN_VERSION, source: `dsh-crowdtest@${PLUGIN_VERSION}`, installed: true, removable: true, enabled: true, official: false, availability: 'profile' }] },
      get credentials() { throw Error('Updater must not access saved credentials') },
    }
    const transport = vi.fn(async (_url, options) => {
      expect(options.credentials).toBe('omit')
      expect(new Headers(options.headers).has('authorization')).toBe(false)
      expect(new Headers(options.headers).has('cookie')).toBe(false)
      return Response.json(target.release)
    })
    vi.stubGlobal('fetch', transport)
    const { installUpdateService } = await import(pathToFileURL(outfile).href)
    await installUpdateService(ctx)
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.crowdtestUpdate))).toEqual(['constructor', 'inspect', 'check', 'start'])
    expect(await ctx.crowdtestUpdate.inspect({})).not.toHaveProperty('configured')
    expect((await ctx.crowdtestUpdate.check({})).status.kind).toBe('available')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(join(profile, '.crowdtest-updater', 'receipt.json'), 'utf8')).kind).toBe('checked')
  } finally {
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  }
})
