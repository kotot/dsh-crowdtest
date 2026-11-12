import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('provides a short GitHub installation guide and a packaged illustration', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const steps = [...readme.matchAll(/^\d+\. (.+)$/gm)].map(match => match[1].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'))
  expect(steps).toHaveLength(4)
  expect(steps.join('').length).toBeGreaterThanOrEqual(100)
  expect(steps.join('').length).toBeLessThanOrEqual(200)
  expect(readme).toContain('https://github.com/kotot/dsh-crowdtest/releases/latest')
  expect(readme).toContain('含口令和平台地址')
  expect(readme).toContain('已同步')
  expect(readme).toContain('立即同步')
  expect(readme).toContain('(./usage-guide.png)')
  expect(manifest.files).toContain('usage-guide.png')
  const image = await readFile(new URL('../usage-guide.png', import.meta.url))
  expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
})
