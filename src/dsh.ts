/**
 * DeepSeek Harness Host services this plugin calls, declared structurally.
 *
 * The plugin deliberately avoids compiling against the pre-stable `@deepseek-ai/dsh-*`
 * declarations so one build keeps loading across desktop auto-updates; each interface
 * lists only the members used here, matching the shipped 0.2.x Host signatures.
 */

import type { NativeManager } from './update-install.ts'

export type Disposer = () => void

/** A durable Session event as persisted by DSH (`SessionEvent`). */
export interface DshSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
}

/** A live Session (`@deepseek-ai/dsh-session` `Session`). */
export interface DshSession {
  readonly id: string
}

/** A live Agent (`@deepseek-ai/dsh-agent` `Agent`); its id equals its Session id. */
export interface DshAgent {
  readonly id: string
  readonly session: DshSession
}

export interface DshLlmCallConfig {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface DshModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export type DshCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

export interface DshCommandInvocation {
  readonly agent: DshAgent
  readonly rawInput: string
  readonly signal: AbortSignal
}

export interface DshCommands {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly input?: { readonly hint: string }
    readonly recordInput?: boolean
    readonly handler: (invocation: DshCommandInvocation) => DshCommandResult | Promise<DshCommandResult>
  }): Disposer
}

export interface DshCredentials {
  set(ref: string, value: string): Promise<void>
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
}

export interface DshSettings {
  mutate(
    ns: string,
    ops: readonly ({ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] })[],
    expectedRevision?: number,
  ): Promise<void>
}

export interface DshWorkspaceController {
  create(request: { path: string }): Promise<{ workspace: { workspaceId: string; path: string }; created: boolean }>
}

export interface DshSessionController {
  create(request: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<{ sessionId: string }>
  selectModel(request: DshModelSelection & { sessionId: string }): Promise<{ selected: DshModelSelection }>
  prompt(
    request: {
      requestId: string
      sessionId: string
      mode: 'queue' | 'steer'
      content: readonly { type: 'text'; text: string }[]
    },
    signal: AbortSignal,
  ): Promise<{ accepted: true }>
}

export interface DshAgentDefaultModel {
  currentSelection(): DshModelSelection
  saveSelection(next: DshModelSelection): Promise<void>
}

export interface DshSessionHandle {
  readonly header: unknown
  read(offset?: number, length?: number): Promise<{ events: readonly DshSessionEvent[] }>
  close(): Promise<void>
}

export interface DshSessionPersistence {
  stat(id: string): Promise<{ readonly header: unknown; readonly revision: string } | undefined>
  open(id: string, access: 'read' | 'write'): Promise<DshSessionHandle>
  flush(): Promise<void>
}

export interface DshAgents {
  get(id: string): DshAgent | undefined
}

export interface DshLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

/** The Cordis Context members the plugin uses. */
export interface DshContext {
  readonly pluginManager?: NativeManager
  readonly profileContext?: { dir: string }
  readonly typert?: { register(contribution: unknown): unknown }
  readonly commands: DshCommands
  readonly credentials: DshCredentials
  readonly settings: DshSettings
  readonly workspaceController: DshWorkspaceController
  readonly sessionController: DshSessionController
  readonly agentDefaultModel: DshAgentDefaultModel
  readonly sessionPersistence: DshSessionPersistence
  readonly agents: DshAgents
  readonly logger: DshLogger
  effect(execute: () => Disposer | (() => Promise<void>)): void
  on(
    name: 'session/event',
    listener: (session: DshSession, event: DshSessionEvent) => void,
  ): Disposer
  on(
    name: 'agent/request',
    listener: (
      payload: { agent: DshAgent; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<DshLlmCallConfig>,
    ) => Promise<DshLlmCallConfig>,
  ): Disposer
}
