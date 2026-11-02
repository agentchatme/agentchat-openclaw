/**
 * Where the doorbell meets OpenClaw's agent runtime.
 *
 * Two things only, both on the `PluginRuntime` OpenClaw hands a channel entry
 * through `defineChannelPluginEntry({ setRuntime })`:
 *
 * 1. **The gate call** — `runtime.llm.complete({ systemPrompt, messages,
 *    maxTokens, temperature, purpose })` runs one tool-free completion on the
 *    agent's own configured model and credentials (`LlmCompleteParams`,
 *    `plugin-sdk/types`; docs.openclaw.ai/plugins/sdk-runtime/models). Without
 *    an `agentId` OpenClaw uses the ambient default agent; passing one is an
 *    OVERRIDE that OpenClaw 2026.10.9 rejects with
 *    `LLM_COMPLETION_NOT_AUTHORIZED` unless the operator set
 *    `plugins.entries.agentchat.llm.allowAgentIdOverride: true`. The doorbell
 *    therefore passes `agentId` only when the account is genuinely routed to
 *    a non-default agent (`agentIdOverride`), and the wizard / doctor write
 *    the opt-in in that case. The judgement is the agent's; the platform
 *    computes, it never judges.
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

/**
 * The gate caller for production: the agent's own model through
 * `runtime.llm.complete`. `agentIdOverride` is set only when the account is
 * routed to an agent other than OpenClaw's ambient default (see the module
 * header); the default path sends no `agentId` at all.
 */
export function createRuntimeGateCaller(params: {
  agentIdOverride?: string | undefined
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
      ...(params.agentIdOverride ? { agentId: params.agentIdOverride } : {}),
      purpose: 'AgentChat reply gate: the server\'s question about the server\'s cards',
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    })
    return typeof result?.text === 'string' ? result.text : ''
  }
}

/** The config key OpenClaw reads before honouring an `agentId` override on `llm.complete`. */
export const LLM_AGENT_OVERRIDE_PATH = 'plugins.entries.agentchat.llm.allowAgentIdOverride'

export function readLlmAgentOverrideOptIn(cfg: unknown): boolean {
  const entries = (cfg as { plugins?: { entries?: Record<string, unknown> } } | undefined)?.plugins?.entries
  const entry = entries && typeof entries === 'object' ? (entries as Record<string, unknown>).agentchat : undefined
  const llm = entry && typeof entry === 'object' ? (entry as { llm?: unknown }).llm : undefined
  return Boolean(llm && typeof llm === 'object' && (llm as { allowAgentIdOverride?: unknown }).allowAgentIdOverride === true)
}

/** Return a config with the override opt-in set (pure; the caller persists it). */
export function withLlmAgentOverrideOptIn<T extends object>(cfg: T): { cfg: T; changed: boolean } {
  if (readLlmAgentOverrideOptIn(cfg)) return { cfg, changed: false }
  const plugins = { ...((cfg as { plugins?: Record<string, unknown> }).plugins ?? {}) }
  const entries = { ...((plugins.entries as Record<string, unknown> | undefined) ?? {}) }
  const entry = { ...((entries.agentchat as Record<string, unknown> | undefined) ?? {}) }
  const llm = { ...((entry.llm as Record<string, unknown> | undefined) ?? {}) }
  llm.allowAgentIdOverride = true
  entry.llm = llm
  entries.agentchat = entry
  plugins.entries = entries
  return { cfg: { ...cfg, plugins } as T, changed: true }
}

/**
 * Which agent the doorbell wakes, and whether that is an override OpenClaw
 * must be told about. `routed` is what OpenClaw's routing returns for this
 * account (an explicit binding, or the default); `ambient` is OpenClaw's
 * default agent. They differ only when the operator bound the AgentChat
 * account to another agent.
 */
export function resolveGateAgent(params: { routedAgentId: string; ambientAgentId: string | undefined }): {
  agentId: string
  agentIdOverride: string | undefined
} {
  const routed = params.routedAgentId.trim().toLowerCase()
  const ambient = params.ambientAgentId?.trim().toLowerCase()
  return { agentId: routed, agentIdOverride: routed === (ambient ?? routed) ? undefined : routed }
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
