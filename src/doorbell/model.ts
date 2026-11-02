/**
 * Where the doorbell meets OpenClaw's agent runtime.
 *
 * Two things only, both on the `PluginRuntime` OpenClaw hands a channel entry
 * through `defineChannelPluginEntry({ setRuntime })`:
 *
 * 1. **The gate call** — `runtime.llm.complete({ systemPrompt, messages,
 *    maxTokens, temperature, agentId, purpose })` runs one tool-free
 *    completion on the agent's own configured model and credentials
 *    (`LlmCompleteParams`, `plugin-sdk/types`; docs.openclaw.ai/plugins/sdk-runtime/models).
 *    The judgement is the agent's; the platform computes, it never judges.
 *
 * 2. **The turn** — `runtime.subagent.run({ sessionKey, message, lane,
 *    deliver: false })` admits one agent run with the fixed prompt as its
 *    message and no delivery of its final text (`SubagentRunParams`;
 *    docs.openclaw.ai/plugins/sdk-runtime/background-work — the same shape
 *    OpenClaw's own background features use with `deliver: false`). The
 *    turn's output is never routed anywhere: the agent's only way to say
 *    something on AgentChat is the hosted `agentchat__agentchat_send_message`
 *    tool during the turn. `runtime.subagent.waitForRun` bounds how long the
 *    invoker waits before it may start the next cycle; it never cancels the
 *    run.
 *
 * The agent id is resolved the way OpenClaw routes inbound for this channel
 * (`channelRuntime.routing.resolveAgentRoute`), so the doorbell wakes the
 * agent the operator bound to the account; `main` when nothing is bound.
 */

import type { PluginRuntime } from 'openclaw/plugin-sdk/channel-core'

import type { GateCaller } from './gate.js'
import { getPluginRuntime } from './runtime-holder.js'
import { AGENTCHAT_CHANNEL_ID } from '../channel-account.js'

/** OpenClaw's default agent id when an account has no explicit binding. */
export const DEFAULT_AGENT_ID = 'main'

/** The gate is a short JSON verdict; `temperature: 0` keeps it as deterministic as the provider allows. */
const GATE_TEMPERATURE = 0

/** How long one turn may run before the invoker moves on. Bounds the wait, not the run. */
export const DEFAULT_TURN_WAIT_MS = 15 * 60_000

export class RuntimeUnavailableError extends Error {
  constructor(what: string) {
    super(`OpenClaw plugin runtime unavailable — ${what} needs setRuntime(...) from defineChannelPluginEntry`)
    this.name = 'RuntimeUnavailableError'
  }
}

/** The slice of OpenClaw's channel runtime surface the doorbell reads. */
export type ChannelRuntimeLike = {
  readonly routing?: {
    readonly resolveAgentRoute?: (params: {
      cfg: unknown
      channel: string
      accountId: string
      peer: { kind: 'direct' | 'group' | 'channel'; id: string | number }
    }) => { agentId?: unknown; sessionKey?: unknown } | undefined
  }
  readonly [key: string]: unknown
}

/**
 * The agent OpenClaw would route this account's inbound to. A synthetic
 * direct peer (`doorbell`) is enough for the agent binding — bindings match
 * on channel and account, and we need no per-peer session here.
 */
export function resolveDoorbellAgentId(params: {
  cfg: unknown
  accountId: string
  channelRuntime: ChannelRuntimeLike | undefined
}): string {
  try {
    const route = params.channelRuntime?.routing?.resolveAgentRoute?.({
      cfg: params.cfg,
      channel: AGENTCHAT_CHANNEL_ID,
      accountId: params.accountId,
      peer: { kind: 'direct', id: 'doorbell' },
    })
    const agentId = route?.agentId
    if (typeof agentId === 'string' && agentId.trim().length > 0) return agentId.trim()
  } catch {
    // Routing is OpenClaw's; a failure there falls back to the default agent.
  }
  return DEFAULT_AGENT_ID
}

/** The gate caller for production: the agent's own model through `runtime.llm.complete`. */
export function createRuntimeGateCaller(params: {
  agentId: string
  runtime?: () => PluginRuntime | null
}): GateCaller {
  const getRuntime = params.runtime ?? getPluginRuntime
  return async ({ systemPrompt, userContent, maxTokens, timeoutMs }) => {
    const runtime = getRuntime()
    if (!runtime) throw new RuntimeUnavailableError('the gate call')
    const result = await runtime.llm.complete({
      systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      maxTokens,
      temperature: GATE_TEMPERATURE,
      agentId: params.agentId,
      purpose: 'AgentChat reply gate: the server\'s question about the server\'s cards',
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    })
    return typeof result?.text === 'string' ? result.text : ''
  }
}

export interface TurnRequest {
  readonly sessionKey: string
  readonly prompt: string
  readonly lane: string
}

export interface TurnOutcome {
  readonly ran: boolean
  readonly runId?: string
  readonly status?: string
  readonly error?: string
}

/** Starts one agent turn and waits for it (bounded). Injectable so the invoker is testable without OpenClaw. */
export type TurnRunner = (request: TurnRequest) => Promise<TurnOutcome>

/**
 * The turn runner for production. `deliver: false` — the final text is
 * recorded by OpenClaw and announced nowhere. The run's result is never read
 * by the doorbell: the agent's send is a hosted-tool call inside the turn.
 */
export function createRuntimeTurnRunner(params: {
  runtime?: () => PluginRuntime | null
  waitMs?: number
} = {}): TurnRunner {
  const getRuntime = params.runtime ?? getPluginRuntime
  const waitMs = params.waitMs ?? DEFAULT_TURN_WAIT_MS
  return async (request) => {
    const runtime = getRuntime()
    if (!runtime) return { ran: false, error: new RuntimeUnavailableError('the agent turn').message }
    let runId: string
    try {
      const admitted = await runtime.subagent.run({
        sessionKey: request.sessionKey,
        message: request.prompt,
        lane: request.lane,
        deliver: false,
      })
      runId = admitted.runId
    } catch (err) {
      return { ran: false, error: err instanceof Error ? err.message : String(err) }
    }
    try {
      const waited = await runtime.subagent.waitForRun({ runId, timeoutMs: waitMs })
      return { ran: true, runId, status: waited.status, ...(waited.error ? { error: waited.error } : {}) }
    } catch (err) {
      // The run was admitted; only the wait failed. The turn is OpenClaw's now.
      return { ran: true, runId, status: 'unknown', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
