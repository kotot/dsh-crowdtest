import { vi } from 'vitest'
import type { DshContext, DshSessionEvent } from '../src/dsh.ts'

type SessionEventListener = (session: { readonly id: string }, event: DshSessionEvent) => void
type AgentRequestListener = Parameters<DshContext['on']>[1]
type CommandDefinition = Parameters<DshContext['commands']['register']>[0]

export function createContext() {
  const cleanups: Array<() => void | Promise<void>> = []
  const commands = new Map<string, CommandDefinition>()
  const logger = {
    info: vi.fn((..._args: unknown[]) => {}),
    warn: vi.fn((..._args: unknown[]) => {}),
  }
  let sessionEventListener: SessionEventListener | undefined
  let agentRequestListener: AgentRequestListener | undefined

  function on(name: 'session/event', listener: SessionEventListener): () => void
  function on(name: 'agent/request', listener: AgentRequestListener): () => void
  function on(
    name: 'session/event' | 'agent/request',
    listener: SessionEventListener | AgentRequestListener,
  ): () => void {
    if (name === 'session/event') {
      const registered = listener as SessionEventListener
      sessionEventListener = registered
      return () => {
        if (sessionEventListener === registered) sessionEventListener = undefined
      }
    }
    const registered = listener as AgentRequestListener
    agentRequestListener = registered
    return () => {
      if (agentRequestListener === registered) agentRequestListener = undefined
    }
  }

  const ctx: DshContext = {
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => {
          commands.delete(definition.name)
        }
      },
    },
    credentials: {
      set: async () => {},
      resolve: async () => ({ value: 'router-token', source: 'file' }),
    },
    settings: { mutate: async () => {} },
    workspaceController: {
      create: async ({ path }) => ({ workspace: { workspaceId: 'workspace', path }, created: true }),
    },
    sessionController: {
      create: async ({ sessionId }) => ({ sessionId: sessionId ?? 's1' }),
      selectModel: async () => ({ selected: { provider: 'provider', model: 'model' } }),
      prompt: async () => ({ accepted: true }),
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'provider', model: 'model' }),
      saveSelection: async () => {},
    },
    sessionPersistence: {
      flush: async () => {},
      stat: async () => ({ header: { id: 's1' }, revision: 'test' }),
      open: async () => ({
        header: { id: 's1' },
        read: async () => ({ events: [] }),
        close: async () => {},
      }),
    },
    agents: { get: () => undefined },
    logger,
    effect(execute) {
      cleanups.push(execute())
    },
    on,
  }

  return {
    ctx,
    commands,
    logger,
    getAgentRequestListener: () => agentRequestListener,
    getSessionEventListener: () => sessionEventListener,
    async dispose() {
      for (const cleanup of cleanups.reverse()) await cleanup()
    },
  }
}
