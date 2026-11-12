import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { apply } from '../src/index.ts'
import { createContext } from './host.ts'
import type { DshSessionEvent } from '../src/dsh.ts'
import type { RunBinding } from '../src/state.ts'

const failureMessage = 'session backup format 不受支持'
const sessionEvent: DshSessionEvent = { type: 'turn/end', seq: 0, time: 1, data: {} }

function createBinding(): Omit<RunBinding, 'provider' | 'resourceStatus'> {
  return {
    sessionId: 's1',
    projectId: 1,
    taskId: 1,
    taskModelRunId: 1,
    serverBaseUrl: 'https://bff.example.com',
    credentialRef: 'CROWDTEST_RUN_1_TOKEN',
    model: {
      alias: 'anonymous/model',
      apiType: 'openai-completions',
      protocol: 'openai-completions',
      baseUrl: 'https://router.example.com',
      input: ['text'],
    },
    backupFormat: 'dsh-session-tree-tar-gzip',
    backupMaxBytes: 134217728,
    workspace: '/tmp/crowdtest-run',
  }
}

async function withUploadHarness(run: (harness: ReturnType<typeof createContext>) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-crowdtest-upload-'))
  const stateFile = join(directory, 'runs.json')
  const harness = createContext()
  const unhandledReasons: unknown[] = []
  const onUnhandledRejection = (reason: unknown) => unhandledReasons.push(reason)
  process.on('unhandledRejection', onUnhandledRejection)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ code: 42200, message: failureMessage, data: null }), { status: 422 })),
  )

  try {
    writeFileSync(stateFile, JSON.stringify({ version: 1, runs: [createBinding()] }))
    const nativeSessionRoot = join(directory, 'sessions')
    const nativeDir = join(nativeSessionRoot, '_no-cwd', 's1')
    mkdirSync(nativeDir, { recursive: true })
    writeFileSync(join(nativeDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from('{"type":"session","version":4,"id":"s1"}\n')))
    await apply(harness.ctx, { stateFile, nativeSessionRoot, uploadDebounceMs: 0 })
    await run(harness)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(unhandledReasons).toEqual([])
  } finally {
    await harness.dispose()
    vi.unstubAllGlobals()
    process.off('unhandledRejection', onUnhandledRejection)
    rmSync(directory, { recursive: true, force: true })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('session upload failures', () => {
  it('logs automatic upload failures without an unhandled rejection', async () => {
    await withUploadHarness(async harness => {
      const listener = harness.getSessionEventListener()
      if (listener === undefined) throw new Error('session/event listener was not registered')
      listener({ id: 's1' }, sessionEvent)

      await vi.waitFor(() => expect(harness.logger.warn).toHaveBeenCalled())
      expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining(failureMessage))
    })
  })

  it('returns manual upload failures without an unhandled rejection', async () => {
    await withUploadHarness(async harness => {
      const command = harness.commands.get('crowdtest-upload')
      if (command === undefined) throw new Error('crowdtest-upload command was not registered')
      const result = await command.handler({
        agent: { id: 's1', session: { id: 's1' } },
        rawInput: '',
        signal: new AbortController().signal,
      })

      expect(result).toEqual({
        kind: 'error',
        text: expect.stringContaining(failureMessage),
      })
    })
  })
})
