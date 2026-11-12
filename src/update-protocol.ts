import * as z from 'zod/mini'

export const PACKAGE = 'dsh-crowdtest'
export const versionText = z.string().check(z.maxLength(128), z.regex(/^[0-9A-Za-z.+-]+$/))
export const digest = z.string().check(z.regex(/^[a-f0-9]{64}$/))
export const updateErrors = {
  credential: '请配置可读取此私有仓库内容的 GitHub 令牌，然后重新检查。',
  access: 'GitHub 拒绝访问。请检查令牌的仓库、Contents 读取权限和请求限额。',
  network: '连接 GitHub 失败，请稍后重试。',
  release: 'GitHub 发布信息或安装包标识无效。',
  changed: '发布内容或本机安装已变化，请重新检查更新。',
  archive: '安装包的大小、摘要或内容校验失败。',
  compatibility: '安装包与当前操作系统或 DSH 版本不兼容。',
  rollback: '无法验证当前版本的还原包，本次安装已停止。',
  install: 'DSH 未能完成安装。',
  unsupported: '此安装不由当前配置管理，或来自开发目录。',
  interrupted: '上一次更新中断，请核对插件页的安装版本。',
  state: '无法读取或保存更新记录。',
  credentialSaveUnconfirmed: '未能确认 GitHub 凭据是否已保存，请重试。',
  credentialRemovalUnconfirmed: '未能确认 GitHub 凭据是否已移除，请重试。',
  credentialStore: '无法保存或移除 GitHub 凭据，请重试。',
} as const
export type UpdateErrorCode = keyof typeof updateErrors
const errorCode = z.enum(Object.keys(updateErrors) as [UpdateErrorCode, ...UpdateErrorCode[]])
export class UpdateError extends Error {
  constructor(readonly code: UpdateErrorCode) { super(updateErrors[code]) }
}
export const phase = z.enum(['checking', 'downloading', 'validating', 'backup', 'installing', 'restoring'])
export type Phase = z.infer<typeof phase>
const status = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('idle') }),
  z.strictObject({ kind: z.literal('verify-install') }),
  z.strictObject({ kind: z.literal('current') }),
  z.strictObject({ kind: z.literal('available'), candidateId: z.uuid() }),
  z.strictObject({ kind: z.literal('busy'), phase }),
  z.strictObject({ kind: z.literal('restart-required') }),
  z.strictObject({ kind: z.literal('completed') }),
  z.strictObject({ kind: z.literal('failed'), code: errorCode }),
  z.strictObject({ kind: z.literal('restored') }),
  z.strictObject({ kind: z.literal('recovery-needed'), jobId: z.uuid() }),
])
const view = z.strictObject({
  runningVersion: versionText, installedVersion: z.nullable(versionText), latestVersion: z.nullable(versionText),
  configured: z.boolean(), status, actionError: z.optional(errorCode),
})
export type UpdateView = z.infer<typeof view>
export type UpdateStatus = UpdateView['status']
export type UpdateRemoteResult = { ok: true; value: UpdateView } | { ok: false }
export const requests = {
  inspect: z.strictObject({}),
  check: z.strictObject({}),
  start: z.strictObject({ candidateId: z.uuid() }),
  saveCredential: z.strictObject({ token: z.string().check(z.regex(/^[A-Za-z0-9_.-]{1,512}$/)) }),
  removeCredential: z.strictObject({}),
}
export type UpdateMethod = keyof typeof requests
export type UpdateRemote = {
  [M in UpdateMethod]: (request: z.infer<(typeof requests)[M]>, signal: AbortSignal) => Promise<UpdateRemoteResult>
}
export function validated<S extends z.ZodMiniType>(schema: S, input: unknown): z.output<S> {
  const value = schema.safeParse(input)
  if (!value.success) throw new Error('Invalid CrowdTest update message')
  return value.data
}
export const updateDescriptors = (Object.keys(requests) as UpdateMethod[]).map(method => {
  const parse = (value: unknown) => validated(requests[method], value)
  const decode = (value: unknown) => validated(view, value)
  return {
    id: `dsh-crowdtest#crowdtestUpdate/${method}`, service: 'crowdtestUpdate', namespace: 'crowdtestUpdate', method,
    invocation: { kind: 'direct' as const },
    parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: 'UpdateRequest', create: () => ({ parse }) } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict' as const, typeSymbol: 'UpdateView', create: () => ({ parse: decode }), decode },
  }
})
