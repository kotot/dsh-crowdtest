import type { RunManifest } from '../src/bff.ts'

export const manifest: RunManifest = {
  protocol: 'crowdtest-dsh/v1', harness: 'dsh', projectId: 11, taskId: 21, taskModelRunId: 31,
  sessionId: 's1', title: 'task', serviceName: 'test-service', projectEndTime: 1, prompt: 'test task',
  model: { alias: 'anonymous/model', apiType: 'openai', protocol: 'openai-completions', input: ['text'], baseUrl: 'https://router.example' },
  attachments: [], sessionBackup: { format: 'dsh-session-tree-tar-gzip', maxBytes: 1_000_000 },
}
