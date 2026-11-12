/** Pure translation from a CrowdTest run manifest to DSH configuration and the first task message. */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { normalizeServerBaseUrl, type ManifestModel, type RunManifest } from './bff.ts'
import type { DshModelSelection } from './dsh.ts'

export interface RunIdentity {
  readonly serverBaseUrl: string
  readonly projectId: number
  readonly taskId: number
  readonly taskModelRunId: number
  readonly sessionId: string
}

export interface RunResources {
  readonly credentialRef: string
  readonly provider: string
  readonly workspace: string
}

export function identityKey(run: RunIdentity): string {
  return JSON.stringify([run.serverBaseUrl, run.projectId, run.taskId, run.taskModelRunId, run.sessionId])
}

export function scopedResources(identity: RunIdentity, workspaceRoot: string): RunResources {
  const key = createHash('sha256').update(identityKey(identity)).digest('hex')
  return {
    credentialRef: `CROWDTEST_RUN_${key.toUpperCase()}_TOKEN`,
    provider: `crowdtest-run-${key}`,
    workspace: join(workspaceRoot, `${identity.projectId}-${identity.taskId}-${identity.taskModelRunId}-${key}`),
  }
}

export function parseJoinArguments(rawInput: string, configuredBaseUrl?: string): { ticket: string; serverBaseUrl: string } {
  const [input, explicitUrl, extra] = rawInput.trim().split(/\s+/)
  const match = /^(?:([A-Z])-)?([A-Z2-9]{4})-?([A-Z2-9]{4})$/.exec(input?.toUpperCase() ?? '')
  if (!match || extra !== undefined) throw new Error('用法：/crowdtest <领取口令> <平台地址>，请从评测页复制完整命令')
  if (match[1] && match[1] !== 'S' && match[1] !== 'B') throw new Error('口令前缀无法识别，请从评测页复制完整命令')
  const base = explicitUrl ?? configuredBaseUrl
  if (!base) throw new Error('缺少平台地址，请从评测页复制完整命令 /crowdtest <领取口令> <平台地址>')
  return { ticket: `${match[2]}-${match[3]}`, serverBaseUrl: normalizeServerBaseUrl(base) }
}

/**
 * Build the `@deepseek-ai/dsh-llm-pi-ai` provider profile for one run. The profile names the token only
 * through its credential reference, so the profile document never contains a secret.
 * @param manifest - run manifest from the BFF.
 * @returns the profile written under `providers.<routeKey>`.
 */
export function piAiProviderProfile(manifest: RunManifest, resources: RunResources): Record<string, unknown> {
  const model = manifest.model
  const entry: Record<string, unknown> = { id: model.alias, name: model.alias, input: [...model.input] }
  if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow
  if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens
  if (model.reasoningEfforts !== undefined) entry.reasoningEfforts = model.reasoningEfforts
  return {
    displayName: `CrowdTest #${manifest.taskModelRunId}`,
    apiKeyEnv: resources.credentialRef,
    api: model.protocol,
    baseURL: model.baseUrl,
    models: [entry],
  }
}

/** Model selection that pins a run's Session to its platform route and reasoning level. */
export function runModelSelection(manifest: RunManifest, resources: RunResources): DshModelSelection {
  const selection: DshModelSelection = { provider: resources.provider, model: manifest.model.alias }
  if (manifest.model.reasoningEffort !== undefined) selection.reasoningEffort = manifest.model.reasoningEffort
  return selection
}

/** Whether a request config stays on the run's platform route and model. */
export function isRunRoute(model: ManifestModel, provider: string, config: { provider: string; model: string }): boolean {
  return config.provider === provider && config.model === model.alias
}

/**
 * Compose the first user message, mirroring the Claude Code local runner's task and attachment blocks.
 * @param prompt - task prompt from the platform.
 * @param attachmentPaths - workspace-relative paths of downloaded attachments.
 * @returns the message text.
 */
export function firstTaskMessage(prompt: string, attachmentPaths: readonly string[]): string {
  const sections = [
    '<crowdtest-runtime-contract>',
    '每轮回答结束不代表任务完成。请先读取附件并完成全部实现与验证；完成后，向用户汇报完成内容和验证结果。',
    '任务产物由用户本人在 CrowdTest 平台的评测页上传并提交评测，不要自行上传，也不要读取、打印或展示平台凭据。',
    '会话由 CrowdTest 插件自动备份，无需也不得由模型自行上传。需要用户输入时，直接在当前会话中提问并等待。',
    '</crowdtest-runtime-contract>',
    '',
    '<task>',
    prompt,
    '</task>',
  ]
  if (attachmentPaths.length > 0) {
    sections.push(
      '',
      '<attachments>',
      '附件已下载到以下路径，请先读取并结合附件完成任务：',
      ...attachmentPaths.map(path => `- ${path}`),
      '上述路径是原始附件；如需解压或转换，请写入工作区其他位置，不要修改附件目录。',
      '</attachments>',
    )
  }
  return sections.join('\n')
}
