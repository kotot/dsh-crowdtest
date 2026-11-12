import { describe, expect, it } from 'vitest'
import type { RunManifest } from '../src/bff.ts'
import { normalizeServerBaseUrl } from '../src/bff.ts'
import {
  scopedResources,
  firstTaskMessage,
  isRunRoute,
  parseJoinArguments,
  piAiProviderProfile,
  runModelSelection,
} from '../src/run.ts'

const manifest: RunManifest = {
  protocol: 'crowdtest-dsh/v1',
  harness: 'dsh',
  projectId: 11,
  taskId: 21,
  taskModelRunId: 31,
  sessionId: '5bceb58e-601f-5e17-9607-32d954f16455',
  serviceName: 'autocase-local-31-x',
  title: 'task',
  projectEndTime: 1,
  model: {
    alias: 'anonymous/glm',
    apiType: 'anthropic',
    protocol: 'anthropic-messages',
    baseUrl: 'https://router.example.com',
    input: ['text', 'image'],
    contextWindow: 131072,
    maxTokens: 16384,
    reasoningEfforts: { high: 'high' },
    reasoningEffort: 'high',
  },
  prompt: 'do it',
  attachments: [],
  sessionBackup: { format: 'dsh-session-tree-tar-gzip', maxBytes: 134217728 },
}

describe('join arguments', () => {
  it.each(['S-ABCD-EFGH', 'b-abcd-efgh', 'ABCDEFGH'])('resolves %s with an explicit or configured address', ticket => {
    expect(parseJoinArguments(ticket, 'https://platform.example/base/')).toEqual({ ticket: 'ABCD-EFGH', serverBaseUrl: 'https://platform.example/base' })
    expect(parseJoinArguments(ticket + ' https://other.example', 'https://platform.example')).toEqual({ ticket: 'ABCD-EFGH', serverBaseUrl: 'https://other.example' })
    expect(() => parseJoinArguments(ticket)).toThrow(/平台地址/)
  })

  it('rejects unknown prefixes and malformed tickets', () => {
    expect(() => parseJoinArguments('Z-ABCD-EFGH')).toThrow(/无法识别/)
    expect(() => parseJoinArguments('ABC')).toThrow(/用法/)
    expect(() => parseJoinArguments('A-B')).toThrow(/用法/)
  })

  it('rejects empty and over-long input', () => {
    expect(() => parseJoinArguments('  ')).toThrow(/用法/)
    expect(() => parseJoinArguments('a b c')).toThrow(/用法/)
  })

  it('only allows HTTPS servers, or loopback HTTP for local development', () => {
    expect(normalizeServerBaseUrl('https://bff.example.com/base/')).toBe('https://bff.example.com/base')
    expect(normalizeServerBaseUrl('http://127.0.0.1:8010')).toBe('http://127.0.0.1:8010')
    expect(() => normalizeServerBaseUrl('http://bff.example.com')).toThrow(/HTTPS/)
    expect(() => normalizeServerBaseUrl('https://user:pw@bff.example.com')).toThrow()
    expect(() => normalizeServerBaseUrl('not a url')).toThrow(/无效/)
  })
})

const resources = scopedResources({ ...manifest, serverBaseUrl: 'https://bff.example' }, '/work')

describe('model route', () => {
  it.each([
    { serverBaseUrl: 'https://bff.example/other' }, { projectId: 12 }, { taskId: 22 }, { taskModelRunId: 32 }, { sessionId: 's2' },
  ])('separates every local resource when the identity changes by %j', changed => {
    const other = scopedResources({ ...manifest, serverBaseUrl: 'https://bff.example', ...changed }, '/work')
    expect(other.provider).not.toEqual(resources.provider)
    expect(other.credentialRef).not.toEqual(resources.credentialRef)
    expect(other.workspace).not.toEqual(resources.workspace)
  })

  it('builds a pi-ai profile that references the token only by credential name', () => {
    const profile = piAiProviderProfile(manifest, resources)
    expect(profile).toEqual({
      displayName: 'CrowdTest #31',
      apiKeyEnv: resources.credentialRef,
      api: 'anthropic-messages',
      baseURL: 'https://router.example.com',
      models: [{
        id: 'anonymous/glm',
        name: 'anonymous/glm',
        input: ['text', 'image'],
        contextWindow: 131072,
        maxTokens: 16384,
        reasoningEfforts: { high: 'high' },
      }],
    })
    expect(resources.credentialRef).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    expect(resources.provider).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('pins the selection and recognizes only the run route', () => {
    expect(runModelSelection(manifest, resources)).toEqual({ provider: resources.provider, model: 'anonymous/glm', reasoningEffort: 'high' })
    expect(isRunRoute(manifest.model, resources.provider, { provider: resources.provider, model: 'anonymous/glm' })).toBe(true)
    expect(isRunRoute(manifest.model, resources.provider, { provider: 'deepseek-account', model: 'deepseek-flash' })).toBe(false)
    expect(isRunRoute(manifest.model, resources.provider, { provider: 'crowdtest-run-32', model: 'anonymous/glm' })).toBe(false)
  })
})

describe('first task message', () => {
  it('wraps the prompt and lists attachments when present', () => {
    const message = firstTaskMessage('build it', ['attachments/01-a.txt'])
    expect(message).toContain('<task>\nbuild it\n</task>')
    expect(message).toContain('- attachments/01-a.txt')
    expect(firstTaskMessage('build it', [])).not.toContain('<attachments>')
  })
})
