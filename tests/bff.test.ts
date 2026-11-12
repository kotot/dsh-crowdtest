import { describe, expect, it, vi } from 'vitest'
import { CrowdtestBffClient, CrowdtestRequestError } from '../src/bff.ts'
import { manifest } from './manifest.ts'
import pkg from '../package.json' with { type: 'json' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('CrowdtestBffClient', () => {
  it('sends the installed package version when requesting the run manifest', async () => {
    const fetchImpl = vi.fn(async () => json(manifest))
    const client = new CrowdtestBffClient('https://bff.example.com', fetchImpl)
    await client.manifest('token')
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ 'x-autocase-client-version': pkg.version }),
    }))
  })

  it.each([
    { harness: 'other' }, { sessionId: 's'.repeat(101) }, { sessionId: 'nested/id' },
    { serviceName: null }, { title: 1 }, { prompt: null }, { projectEndTime: -1 },
    ...[{ alias: '' }, { protocol: 'unknown' }, { baseUrl: 'http://router.example' }, { apiType: null },
      { input: [] }, { input: ['video'] }, { contextWindow: 0 }, { maxTokens: -1 },
      { reasoningEfforts: [] }, { reasoningEfforts: { high: 5 } }, { reasoningEffort: 2 }]
      .map(field => ({ model: { ...manifest.model, ...field } })),
    { sessionBackup: { format: 'unsupported', maxBytes: 1 } }, { sessionBackup: { ...manifest.sessionBackup, maxBytes: 0 } },
  ])('rejects invalid manifest fields %j', async fields => {
    const client = new CrowdtestBffClient('https://bff.example', async () => json({ ...manifest, ...fields }))
    await expect(client.manifest('test-token')).rejects.toThrow()
  })

  it.each([null, { token: ' ', tokenExpiresAt: Date.now() + 100000 }, { token: 'test', tokenExpiresAt: 0 },
    { token: 1, tokenExpiresAt: Date.now() + 100000 }, { token: 'test', tokenExpiresAt: 'invalid' }])('rejects an invalid exchange response %j', async response => {
    const client = new CrowdtestBffClient('https://bff.example', async () => json(response))
    await expect(client.exchangeTicket('ABCD-EFGH')).rejects.toThrow()
  })

  it('accepts an empty title, an unspecified end date and a signed attachment URL', async () => {
    const file = { name: 'notes.txt', size: 0, sha256: null, contentType: 'text/plain', url: 'https://files.example/notes.txt?signature=test' }
    const run = { ...manifest, title: '', projectEndTime: 0, attachments: [file] }
    const client = new CrowdtestBffClient('https://bff.example', async () => json(run))
    expect(await client.manifest('test-token')).toEqual(run)
  })

  it.each(['missing/hash', 'duplicate', 'case duplicate', 'hidden', 'path', 'control', 'scheme'])('rejects attachment %s', async kind => {
    const file = { name: 'notes.txt', size: 0, sha256: null, contentType: 'text/plain', url: 'https://files.example/notes.txt' }
    const bad = { 'missing/hash': { sha256: 'oops' }, duplicate: {}, 'case duplicate': { name: 'Notes.txt' }, hidden: { name: '.hidden' },
      path: { name: 'a/b' }, control: { name: 'a\x01b' }, scheme: { url: 'http://files.example' } }[kind]
    const client = new CrowdtestBffClient('https://bff.example', async () => json({ ...manifest, attachments: [file, { ...file, ...bad }] }))
    await expect(client.manifest('test-token')).rejects.toThrow()
  })

  it('surfaces the BFF detail on a failed ticket exchange', async () => {
    const client = new CrowdtestBffClient('https://bff.example.com', vi.fn(async () => json({ detail: '兑换码无效或已过期' }, 401)))
    const error = await client.exchangeTicket('ABCD-EFGH').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CrowdtestRequestError)
    expect((error as CrowdtestRequestError).status).toBe(401)
    expect((error as Error).message).toContain('兑换码无效或已过期')
  })

  it('surfaces the gateway message on a failed upload URL request', async () => {
    const message = 'session backup format 不受支持'
    const client = new CrowdtestBffClient(
      'https://bff.example.com',
      vi.fn(async () => json({ code: 42200, message, data: null }, 422)),
    )

    await expect(
      client.uploadSessionBackup('router-token', new Uint8Array([1, 2, 3]), {
        size: 3,
        sha256: 'a'.repeat(64),
        format: 'dsh-session-tree-tar-gzip',
      }),
    ).rejects.toThrow(message)
  })

  it('rejects a manifest from another protocol version', async () => {
    const client = new CrowdtestBffClient('https://bff.example.com', vi.fn(async () => json({ protocol: 'crowdtest-dsh/v9' })))
    await expect(client.manifest('token')).rejects.toThrow(/更新 CrowdTest 插件/)
  })

  it('signs, posts the archive as the last form field, then verifies', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/session/upload-url')) {
        return json({ signedPostUrl: 'https://tos.example.com/', formFields: { key: 'k', policy: 'p' }, fileField: 'file' })
      }
      if (String(url) === 'https://tos.example.com/') return new Response(null, { status: 204 })
      return json({ ok: true })
    })
    const client = new CrowdtestBffClient('https://bff.example.com', fetchImpl as typeof fetch)
    const descriptor = { size: 3, sha256: 'a'.repeat(64), format: 'dsh-session-tree-tar-gzip' }

    await client.uploadSessionBackup('router-token', new Uint8Array([1, 2, 3]), descriptor)

    expect(calls.map(call => call.url)).toEqual([
      'https://bff.example.com/api/crowdtest/local-runs/session/upload-url',
      'https://tos.example.com/',
      'https://bff.example.com/api/crowdtest/local-runs/session/verify',
    ])
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(descriptor)
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer router-token')
    const form = calls[1]?.init?.body as FormData
    expect([...form.keys()]).toEqual(['key', 'policy', 'file'])
    expect((calls[1]?.init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined()
  })
})
