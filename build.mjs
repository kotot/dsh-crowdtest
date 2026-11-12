// Build both halves the DSH Loader consumes:
// - lib/index.js: ESM Host plugin; DSH packages resolve from the running Harness at runtime.
// - lib/client.js: browser factory registered through window.__ModuleLoader__, matching the
//   closure-factory artifact DSH's own client preset emits. Platform modules (React, Cordis)
//   come from the shell's shared module table through the injected `require`.
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
const PLATFORM_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis']
const releaseVersion = {
  name: 'release-version',
  setup(builder) {
    builder.onLoad({ filter: /[/\\]src[/\\]version\.ts$/ }, () => ({
      contents: `export const PLUGIN_VERSION = ${JSON.stringify(manifest.version)}`,
      loader: 'ts',
    }))
  },
}

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  plugins: [releaseVersion],
  logLevel: 'info',
})

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  plugins: [releaseVersion],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})
