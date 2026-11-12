/**
 * CrowdTest Host plugin for DeepSeek Harness.
 *
 * `/crowdtest [S-|B-]<兑换码> [平台地址]` claims one local CrowdTest run: it exchanges the one-time
 * ticket for the run's Router Token, stores the token in the Harness credential store, adds a
 * pi-ai route for the anonymous model, prepares a dedicated workspace with the task attachments,
 * creates the run-bound Session, pins its model and sends the first task message. After every
 * completed turn the Session log is archived and uploaded as the run's session backup;
 * `/crowdtest-upload` uploads on demand.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SessionBackups } from './session-backups.ts'
import { CrowdtestBffClient, type ManifestAttachment, type RunManifest } from './bff.ts'
import type { DshContext, DshModelSelection } from './dsh.ts'
import {
  firstTaskMessage,
  isRunRoute,
  parseJoinArguments,
  piAiProviderProfile,
  runModelSelection,
  scopedResources,
  type RunIdentity,
} from './run.ts'
import { RunBindings, defaultStateFile, RECLAIM_MESSAGE, type RunBinding } from './state.ts'

export const name = 'crowdtest'

export const inject = [
  'typert',
  'commands',
  'credentials',
  'settings',
  'workspaceController',
  'sessionController',
  'agentDefaultModel',
  'sessionPersistence',
  'agents',
]

export interface Config {
  /** BFF base URL used when the join command omits one. */
  serverBaseUrl?: string
  /** Directory that receives one workspace per claimed run; defaults to `~/CrowdTest`. */
  workspaceRoot?: string
  /** Profile entry id of `@deepseek-ai/dsh-llm-pi-ai`; the shipped base bundle uses `llm-pi-ai`. */
  llmEntryId?: string
  /** Send the task prompt as the first message right after claiming; defaults to true. */
  autoSendPrompt?: boolean
  /** Upload the session backup after every completed turn; defaults to true. */
  autoUpload?: boolean
  /** Delay after a turn ends before the automatic upload starts. */
  uploadDebounceMs?: number
  /** Override for the binding state file; defaults to `$DSH_HOME/crowdtest/runs.json`. */
  stateFile?: string
  /** DSH persistence root; defaults to `$DSH_HOME/sessions` or `~/.dsh/sessions`. */
  nativeSessionRoot?: string
}

const PLUGIN_RECORD_BINDING = 'plugin:dsh-crowdtest/binding'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function sha256File(path: string): Promise<string | undefined> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function downloadAttachment(directory: string, attachment: ManifestAttachment, signal: AbortSignal): Promise<string> {
  const fileName = attachment.name
  const target = join(directory, fileName)
  const existing = await sha256File(target)
  if (existing !== undefined && attachment.sha256 !== null && existing === attachment.sha256) return fileName
  const response = await fetch(attachment.url, { signal })
  if (!response.ok) throw new Error(`下载附件 ${fileName} 失败（HTTP ${response.status}）`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length !== attachment.size) throw new Error(`附件 ${fileName} 大小校验失败`)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (attachment.sha256 !== null && digest !== attachment.sha256) throw new Error(`附件 ${fileName} SHA-256 校验失败`)
  await writeFile(target, bytes, { mode: 0o400 })
  return fileName
}

async function sessionExists(ctx: DshContext, sessionId: string): Promise<boolean> {
  if (ctx.agents.get(sessionId) !== undefined) return true
  try {
    const handle = await ctx.sessionPersistence.open(sessionId, 'read')
    await handle.close()
    return true
  } catch (error) {
    if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') return false
    throw error
  }
}

async function recordCreation(ctx: DshContext, manifest: RunManifest, provider: string, claimNonce: string): Promise<void> {
  const agent = ctx.agents.get(manifest.sessionId)
  if (!agent) throw new Error('未找到刚创建的会话，无法记录众测归属')
  const specifier = '@deepseek-ai/dsh-session'
  const { appendPluginRecord } = await import(specifier) as {
    appendPluginRecord: (session: unknown, type: string, data: unknown) => number
  }
  appendPluginRecord(agent.session, PLUGIN_RECORD_BINDING, {
    projectId: manifest.projectId, taskId: manifest.taskId, taskModelRunId: manifest.taskModelRunId,
    provider, model: manifest.model.alias, claimNonce,
  })
  await ctx.sessionPersistence.flush()
}

async function matchesCreationRecord(ctx: DshContext, saved: RunBinding): Promise<boolean> {
  if (!saved.claimNonce) return false
  const handle = await ctx.sessionPersistence.open(saved.sessionId, 'read')
  try {
    const { events } = await handle.read()
    return events.some(event => event.ignorable === true && event.type === PLUGIN_RECORD_BINDING &&
      typeof event.data === 'object' && event.data !== null && 'claimNonce' in event.data && event.data.claimNonce === saved.claimNonce)
  } finally { await handle.close() }
}

/**
 * Pin the run's model on its Session. `selectModel` also saves the selection as the profile default, so
 * the previous default is restored once that save lands; ordinary Sessions never inherit the run route.
 */
async function pinRunModel(ctx: DshContext, sessionId: string, selection: DshModelSelection): Promise<void> {
  const previous = ctx.agentDefaultModel.currentSelection()
  await ctx.sessionController.selectModel({ sessionId, ...selection })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const current = ctx.agentDefaultModel.currentSelection()
    if (current.provider === selection.provider && current.model === selection.model && current.reasoningEffort === selection.reasoningEffort) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (previous.provider !== selection.provider || previous.model !== selection.model || previous.reasoningEffort !== selection.reasoningEffort) {
    await ctx.agentDefaultModel.saveSelection(previous)
  }
}

export async function apply(ctx: DshContext, config: Config = {}): Promise<void> {
  const bindings = new RunBindings(config.stateFile ?? defaultStateFile())
  await bindings.load()
  const llmEntryId = config.llmEntryId ?? 'llm-pi-ai'
  const workspaceRoot = config.workspaceRoot ?? join(homedir(), 'CrowdTest')
  const backups = new SessionBackups(ctx, bindings, config)
  ctx.effect(() => () => backups.dispose())
  if (ctx.typert) {
    const { installRemote } = await import('./remote-host.ts')
    await installRemote(ctx, backups)
  }
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    backups.changed(session.id, event.type === 'turn/end')
  }))

  ctx.effect(() => ctx.on('agent/request', async (payload, next) => {
    const saved = bindings.get(payload.agent.id)
    if (saved && saved.resourceStatus !== 'ready') throw new Error(RECLAIM_MESSAGE)
    const resolved = await next()
    const binding = bindings.get(payload.agent.id)
    if (binding !== undefined && !isRunRoute(binding.model, binding.provider, resolved)) {
      throw new Error(`CrowdTest 任务会话只能使用平台下发的模型 ${binding.model.alias}，请切换回该模型后重试`)
    }
    return resolved
  }))

  async function claim(rawInput: string, signal: AbortSignal): Promise<string> {
    const { ticket, serverBaseUrl } = parseJoinArguments(rawInput, config.serverBaseUrl)
    signal.throwIfAborted()
    const client = new CrowdtestBffClient(serverBaseUrl)
    const { token } = await client.exchangeTicket(ticket, signal)
    const manifest = await client.manifest(token, signal)
    const { projectId, taskId, taskModelRunId, sessionId } = manifest
    const identity: RunIdentity = { serverBaseUrl, projectId, taskId, taskModelRunId, sessionId }
    const saved = bindings.ownerForClaim(identity)
    const existing = await sessionExists(ctx, sessionId)
    if (existing && !saved) throw new Error('平台分配的会话标识已被普通会话占用，无法领取')
    if (existing && saved?.workspaceConflict) throw new Error('此会话的工作区与其他运行共用，请从平台重新创建本机运行')
    const recovering = saved?.resourceStatus === 'creating' || saved?.claimNonce !== undefined
    if (existing && saved && recovering && !await matchesCreationRecord(ctx, saved)) {
      throw new Error('无法核实此会话的创建记录，请从平台重新创建本机运行')
    }
    const resources = saved && saved.resourceStatus !== 'reclaim-required' ? saved : scopedResources(identity, workspaceRoot)
    const { credentialRef, provider } = resources
    const workspace = saved && !saved.workspaceConflict ? saved.workspace : resources.workspace
    const binding: RunBinding = {
      ...identity, credentialRef, provider, workspace, resourceStatus: 'ready', model: manifest.model,
      backupFormat: manifest.sessionBackup.format, backupMaxBytes: manifest.sessionBackup.maxBytes,
    }
    const claimNonce = existing ? undefined : saved?.claimNonce ?? randomUUID()
    if (claimNonce) await bindings.put({ ...binding, resourceStatus: 'creating', claimNonce })
    await ctx.credentials.set(credentialRef, token)
    await ctx.settings.mutate(llmEntryId, [
      { op: 'set', path: ['providers', provider], value: piAiProviderProfile(manifest, resources) },
    ])

    const attachmentDirectory = join(workspace, 'attachments')
    await mkdir(workspace, { recursive: true })
    const attachmentPaths: string[] = []
    if (manifest.attachments.length > 0) {
      await mkdir(attachmentDirectory, { recursive: true })
      for (const attachment of manifest.attachments) {
        attachmentPaths.push(`attachments/${await downloadAttachment(attachmentDirectory, attachment, signal)}`)
      }
    }

    if (claimNonce) {
      const { workspace: registered } = await ctx.workspaceController.create({ path: workspace })
      const created = await ctx.sessionController.create({ workspaceId: registered.workspaceId, sessionId })
      if (created.sessionId !== sessionId) throw new Error('创建的会话标识与平台分配的不一致，无法绑定众测运行')
      await recordCreation(ctx, manifest, provider, claimNonce)
    }
    await pinRunModel(ctx, sessionId, runModelSelection(manifest, resources))
    await bindings.put(binding)
    if (existing && !recovering) return `已更新任务「${manifest.title}」的运行凭证与模型路由。请在侧栏打开工作区 ${workspace} 中的会话继续。`
    const message = firstTaskMessage(manifest.prompt, attachmentPaths)
    if (config.autoSendPrompt === false) {
      return `已领取任务「${manifest.title}」，工作区 ${workspace}。请在新会话中发送任务：\n\n${message}`
    }
    await ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId: manifest.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: message }],
    }, signal)
    return `已领取任务「${manifest.title}」：工作区 ${workspace}，模型 ${manifest.model.alias}。首轮任务已在新会话中发送，每轮结束后会自动上传会话备份。`
  }

  let claimQueue = Promise.resolve()
  ctx.effect(() => ctx.commands.register({
    name: 'crowdtest',
    description: '领取 CrowdTest 众测任务：配置测试模型、下载附件并在新会话中开始任务',
    input: { hint: '<领取口令> <平台地址>' },
    // The ticket is a one-time credential; keep it out of the Session log.
    recordInput: false,
    handler: async ({ rawInput, signal }) => {
      try {
        const result = claimQueue.then(() => claim(rawInput, signal))
        claimQueue = result.then(() => undefined, () => undefined)
        return { kind: 'success', text: await result }
      } catch (error) {
        return { kind: 'error', text: `领取 CrowdTest 任务失败：${errorText(error)}` }
      }
    },
  }))

  ctx.effect(() => ctx.commands.register({
    name: 'crowdtest-upload',
    description: '立即把当前 CrowdTest 任务会话上传到平台',
    handler: async ({ agent }) => {
      const binding = bindings.get(agent.id)
      if (binding === undefined) {
        return { kind: 'error', text: '当前会话不是 CrowdTest 任务会话，请在领取任务时创建的会话中执行' }
      }
      try {
        const view = await backups.sync(binding.sessionId)
        if (view === null) return { kind: 'error', text: '同步已取消' }
        return { kind: 'success', text: view.phase === 'synced' ? '会话备份已同步到平台' : '会话又有新内容，尚未全部同步，请再次同步' }
      } catch (error) {
        return { kind: 'error', text: `上传会话备份失败：${errorText(error)}` }
      }
    },
  }))
}
