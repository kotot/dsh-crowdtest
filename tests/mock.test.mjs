import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createMockCrowdtest } from '../scripts/mock-crowdtest.mjs'
import { CrowdtestBffClient } from '../src/bff.ts'
const servers = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))) })
it('keeps two mock runs independent and derives metadata from received archive bytes', async () => {
  const server = createMockCrowdtest()
  servers.push(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const client = new CrowdtestBffClient(base)
  const a = await client.exchangeTicket('ABCD-EFGH')
  const b = await client.exchangeTicket('IJKL-MNOP')
  const manifestA = await client.manifest(a.token)
  const manifestB = await client.manifest(b.token)
  expect(manifestA.sessionId).not.toBe(manifestB.sessionId)
  expect(await client.sessionStatus(a.token)).toBeNull()
  const bytes = new TextEncoder().encode('fake archive test bytes')
  const descriptor = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, format: manifestA.sessionBackup.format }
  await client.uploadSessionBackup(a.token, bytes, descriptor)
  expect(await client.sessionStatus(a.token)).toMatchObject(descriptor)
  expect(await client.sessionStatus(b.token)).toBeNull()
  const verified = await fetch(`${base}/api/crowdtest/local-runs/session/verify`, { method: 'POST', headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' }, body: JSON.stringify(descriptor) })
  expect(verified.status).toBe(409)
  const badBytes = new TextEncoder().encode('wrong archive')
  await expect(client.uploadSessionBackup(b.token, badBytes, descriptor)).rejects.toThrow('409')
  await fetch(`${base}/__control`, { method: 'POST', body: JSON.stringify({ runId: 31, statusCode: 503 }) })
  await expect(client.sessionStatus(a.token)).rejects.toThrow('503')
  await fetch(`${base}/__control`, { method: 'POST', body: JSON.stringify({ runId: 31, statusCode: 200, backup: null, failUploads: 1 }) })
  expect(await client.sessionStatus(a.token)).toBeNull()
  await expect(client.uploadSessionBackup(a.token, bytes, descriptor)).rejects.toThrow('503')
  await client.uploadSessionBackup(a.token, bytes, descriptor)
  expect(await client.sessionStatus(a.token)).toMatchObject(descriptor)
})
