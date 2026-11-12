import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const FORMAT = 'dsh-session-tree-tar-gzip'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export function createMockCrowdtest({ outputRoot } = {}) {
  const runs = [
    { ticket: 'ABCD-EFGH', runId: 31, taskId: 21, sessionId: '5bceb58e-601f-5e17-9607-32d954f16455' },
    { ticket: 'IJKL-MNOP', runId: 32, taskId: 22, sessionId: '6bceb58e-601f-5e17-9607-32d954f16456' },
  ].map(run => ({ ...run, token: `FAKE_TEST_ONLY_${randomBytes(8).toString('hex')}`, used: false, backup: null, statusCode: 200, statusDelayMs: 0, uploadDelayMs: 0, failUploads: 0, uploads: 0 }))
  const posts = new Map()
  const attachment = Buffer.from('CrowdTest mock attachment\n')
  function send(response, status, payload) {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(payload))
  }
  const server = createServer(async (request, response) => {
    try {
      const address = server.address()
      const base = `http://127.0.0.1:${address.port}`
      const url = new URL(request.url, base)
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      const json = () => JSON.parse(raw.toString() || '{}')
      const run = runs.find(item => request.headers.authorization === `Bearer ${item.token}`)
      if (url.pathname === '/__control' && request.method === 'POST') {
        const control = json()
        const target = runs.find(item => item.runId === control.runId)
        if (!target) return send(response, 400, { detail: 'unknown run' })
        for (const key of ['statusCode', 'statusDelayMs', 'uploadDelayMs', 'failUploads']) {
          if (Number.isSafeInteger(control[key]) && control[key] >= 0) target[key] = control[key]
        }
        if (control.backup === null) target.backup = null
        return send(response, 200, { runId: target.runId, uploads: target.uploads, backup: target.backup })
      }
      if (url.pathname === '/api/crowdtest/local-runs/dsh/ticket/exchange') {
        const target = runs.find(item => item.ticket === json().ticket)
        if (!target || target.used) return send(response, 401, { detail: '兑换码无效或已过期' })
        target.used = true
        return send(response, 200, { token: target.token, tokenExpiresAt: Date.now() + 86_400_000 })
      }
      if (url.pathname.startsWith('/api/crowdtest/local-runs/') && !run) return send(response, 401, { detail: 'invalid local run token' })
      if (url.pathname === '/api/crowdtest/local-runs/dsh/manifest') {
        return send(response, 200, {
          protocol: 'crowdtest-dsh/v1', harness: 'dsh', projectId: 11, taskId: run.taskId, taskModelRunId: run.runId,
          sessionId: run.sessionId, serviceName: `autocase-local-${run.runId}-mock`, title: `Mock CrowdTest task ${run.taskId}`, projectEndTime: Date.now() + 86_400_000,
          model: { alias: `anonymous/mock-${run.runId}`, apiType: 'openai-completions', protocol: 'openai-completions', baseUrl: `${base}/v1`, input: ['text'], contextWindow: 65536, maxTokens: 4096, reasoningEfforts: false },
          prompt: '请阅读附件并用一句话总结其内容。',
          attachments: [{ name: '01-readme.txt', size: attachment.length, sha256: sha256(attachment), contentType: 'text/plain', url: `${base}/files/01-readme.txt` }],
          sessionBackup: { format: FORMAT, maxBytes: 134217728 },
        })
      }
      if (url.pathname === '/files/01-readme.txt') { response.writeHead(200, { 'content-type': 'text/plain' }); return response.end(attachment) }
      if (url.pathname === '/v1/chat/completions') {
        if (!run) return send(response, 401, { error: { message: 'bad router token' } })
        const payload = json()
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunk = delta => `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: payload.model, choices: [{ index: 0, ...delta }] })}\n\n`
        response.write(chunk({ delta: { role: 'assistant', content: `任务 ${run.taskId} 的附件是一句 CrowdTest 模拟说明。` } }))
        response.write(chunk({ delta: {}, finish_reason: 'stop' }))
        response.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: payload.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\n`)
        return response.end('data: [DONE]\n\n')
      }
      if (url.pathname === '/api/crowdtest/local-runs/session/status') {
        await delay(run.statusDelayMs)
        if (run.statusCode !== 200) return send(response, run.statusCode, { detail: 'controlled status failure' })
        return send(response, 200, { backup: run.backup })
      }
      if (url.pathname === '/api/crowdtest/local-runs/session/upload-url') {
        const descriptor = json()
        if (descriptor.format !== FORMAT || !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0 || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) return send(response, 400, { detail: 'invalid descriptor' })
        const postId = randomBytes(12).toString('hex')
        posts.set(postId, { run, descriptor })
        return send(response, 200, { uploadMethod: 'POST', signedPostUrl: `${base}/tos/${postId}`, formFields: { key: `${run.runId}/session.tar.gz` }, fileField: 'file' })
      }
      if (url.pathname.startsWith('/tos/')) {
        const post = posts.get(url.pathname.slice(5))
        if (!post) return send(response, 404, { detail: 'unknown upload' })
        posts.delete(url.pathname.slice(5))
        await delay(post.run.uploadDelayMs)
        if (post.run.failUploads > 0) { post.run.failUploads--; return send(response, 503, { detail: 'controlled upload failure' }) }
        const form = await new Response(raw, { headers: { 'content-type': request.headers['content-type'] } }).formData()
        const file = form.get('file')
        if (!file || typeof file === 'string') return send(response, 400, { detail: 'missing archive' })
        const bytes = Buffer.from(await file.arrayBuffer())
        if (bytes.length !== post.descriptor.size || sha256(bytes) !== post.descriptor.sha256) return send(response, 409, { detail: 'archive mismatch' })
        post.run.backup = { sha256: sha256(bytes), size: bytes.length, format: FORMAT, uploadedAtMs: Date.now() }
        post.run.uploads++
        if (outputRoot) { mkdirSync(outputRoot, { recursive: true }); writeFileSync(join(outputRoot, `${post.run.runId}.tar.gz`), bytes) }
        response.writeHead(204)
        return response.end()
      }
      if (url.pathname === '/api/crowdtest/local-runs/session/verify') {
        const descriptor = json()
        if (!run.backup || ['sha256', 'size', 'format'].some(key => descriptor[key] !== run.backup[key])) return send(response, 409, { detail: 'backup absent or mismatched' })
        return send(response, 200, { ok: true, ...descriptor })
      }
      send(response, 404, { detail: 'not found' })
    } catch { if (!response.headersSent) send(response, 500, { detail: 'mock request failed' }); else response.end() }
  })
  return server
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8790)
  const server = createMockCrowdtest({ outputRoot: process.env.MOCK_OUTPUT_ROOT ?? join(process.cwd(), '.mock-crowdtest') })
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock CrowdTest http://127.0.0.1:${port}`)
    console.log(`/crowdtest ABCD-EFGH http://127.0.0.1:${port}`)
    console.log(`/crowdtest IJKL-MNOP http://127.0.0.1:${port}`)
  })
}
