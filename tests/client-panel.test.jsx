import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { apply } from '../src/client/index.tsx'

it('shows the installed version and the tarball update path', async () => {
  let Panel
  await apply({
    remote: { $mount: async () => {} },
    inject: async () => {},
    slots: {
      inject(_name, register) { register() },
      register(_options, component) { Panel = component; return () => {} },
    },
  })
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const markup = renderToStaticMarkup(<Panel />)
  expect(markup).toContain(`当前插件版本 ${manifest.version}`)
  expect(markup).toContain('GitHub Releases')
  expect(markup).toContain('dsh-crowdtest.tgz')
  expect(markup).toContain('带平台地址')
})
