/**
 * Where the integration meets OpenClaw's agent runtime.
 *
 * Two things only, both on the `PluginRuntime` OpenClaw hands a channel entry
 * through `defineChannelPluginEntry({ setRuntime })`:
 *
 * 1. **The gate call** — `runtime.llm.complete({ messages, maxTokens,
 *    temperature, purpose })` runs one tool-free completion on the agent's
 *    own configured model and credentials (`LlmCompleteParams`,
 *    `plugin-sdk/types`; docs.openclaw.ai/plugins/sdk-runtime/models). The
 *    prompt is the SDK's rendering of the server's question and cards
 *    (`gate.buildPrompt`); nothing of ours is added. No tools are passed:
 *    the gate is a triage, and the integration records the verdicts. Without
 *    an `agentId` OpenClaw uses the ambient default agent; passing one is an
 *    OVERRIDE that OpenClaw 2026.10.9 rejects with
 *    `LLM_COMPLETION_NOT_AUTHORIZED` unless the operator set
 *    `plugins.entries.agentchat.llm.allowAgentIdOverride: true`. The
 *    integration therefore passes `agentId` only when the account is
 *    genuinely routed to a non-default agent (`agentIdOverride`), and the
 *    wizard / doctor write the opt-in in that case.
 *
 * 2. **The turn** — `runtime.subagent.run({ sessionKey, message, lane,
 *    deliver: false })` admits one agent run with the prompt as its message
 *    and no delivery of its final text (`SubagentRunParams`;
 *    docs.openclaw.ai/plugins/sdk-runtime/background-work — the same shape
 *    OpenClaw's own background features use with `deliver: false`). The
 *    turn's output is never routed anywhere: the agent's only way to say
 *    something on AgentChat is the hosted `agentchat__agentchat_send_message`
 *    tool during the turn. Admission and completion are reported separately
 *    (`TurnAdmission`): the invoker records the `reply` verdict the moment
 *    the run is admitted, and `runtime.subagent.waitForRun` bounds how long
 *    it waits before the next cycle may start; it never cancels the run.
 *
 * The agent id is resolved the way OpenClaw routes inbound for this channel
 * (`channelRuntime.routing.resolveAgentRoute`), so the integration wakes the
 * agent the operator bound to the account; `main` when nothing is bound.
 */

import type { PluginRuntime } from 'openclaw/plugin-sdk/channel-core'
import type { GateModelCall } from 'agentchatme'

import { getPluginRuntime } from './runtime-holder.js'
import { describeMcpEntry } from './mcp.js'
import { MCP_SERVER_NAME } from './turn.js'
import { AGENTCHAT_CHANNEL_ID } from '../channel-account.js'
import { API_KEY_ENV } from '../credentials/read-env.js'

export type { GateModelCall }

/** OpenClaw's default agent id when an account has no explicit binding. */
export const DEFAULT_AGENT_ID = 'main'

/** The gate is a short JSON verdict; `temperature: 0` keeps it as deterministic as the provider allows. */
const GATE_TEMPERATURE = 0

/** Output ceiling for the verdict JSON: a few dozen tokens per card. The tray is capped at 50 cards server-side. */
export const DEFAULT_GATE_MAX_TOKENS = 2048

/** Decision-call timeout. The gate must never block the integration forever. */
export const DEFAULT_GATE_TIMEOUT_MS = 20_000

/** How long one turn may run before the invoker moves on. Bounds the wait, not the run. */
export const DEFAULT_TURN_WAIT_MS = 15 * 60_000

export class RuntimeUnavailableError extends Error {
  constructor(what: string) {
    super(`OpenClaw plugin runtime unavailable — ${what} needs setRuntime(...) from defineChannelPluginEntry`)
    this.name = 'RuntimeUnavailableError'
  }
}

/** The slice of OpenClaw's channel runtime surface the integration reads. */
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
 * direct peer (`wake`) is enough for the agent binding — bindings match on
 * channel and account, and we need no per-peer session here.
 */
export function resolveIntegrationAgentId(params: {
  cfg: unknown
  accountId: string
  channelRuntime: ChannelRuntimeLike | undefined
}): string {
  try {
    const route = params.channelRuntime?.routing?.resolveAgentRoute?.({
      cfg: params.cfg,
      channel: AGENTCHAT_CHANNEL_ID,
      accountId: params.accountId,
      peer: { kind: 'direct', id: 'wake' },
    })
    const agentId = route?.agentId
    if (typeof agentId === 'string' && agentId.trim().length > 0) return agentId.trim()
  } catch {
    // Routing is OpenClaw's; a failure there falls back to the default agent.
  }
  return DEFAULT_AGENT_ID
}

/**
 * The gate's model call for production: one tool-free completion on the
 * agent's own model through `runtime.llm.complete`. The SDK's rendered
 * prompt is the single user message; no system prompt, no tools.
 * `agentIdOverride` is set only when the account is routed to an agent
 * other than OpenClaw's ambient default (see the module header); the
 * default path sends no `agentId` at all.
 */
export function createRuntimeModelCall(params: {
  agentIdOverride?: string | undefined
  runtime?: () => PluginRuntime | null
  maxTokens?: number
  timeoutMs?: number
}): GateModelCall {
  const getRuntime = params.runtime ?? getPluginRuntime
  const maxTokens = params.maxTokens ?? DEFAULT_GATE_MAX_TOKENS
  const timeoutMs = params.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS
  return async (prompt) => {
    const runtime = getRuntime()
    if (!runtime) throw new RuntimeUnavailableError('the gate call')
    const result = await runtime.llm.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
      temperature: GATE_TEMPERATURE,
      ...(params.agentIdOverride ? { agentId: params.agentIdOverride } : {}),
      purpose: 'AgentChat reply gate: the server\'s question about the server\'s cards (tool-free triage)',
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
 * Which agent the integration wakes, and whether that is an override
 * OpenClaw must be told about. `routed` is what OpenClaw's routing returns
 * for this account (an explicit binding, or the default); `ambient` is
 * OpenClaw's default agent. They differ only when the operator bound the
 * AgentChat account to another agent.
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

/**
 * What starting a turn tells the invoker: refused (OpenClaw did not admit
 * the run — no runtime, a thrown `subagent.run`), or admitted with a bounded
 * promise of the outcome.
 */
export type TurnAdmission =
  | { readonly ran: false; readonly error: string }
  | { readonly ran: true; readonly runId: string; readonly done: Promise<TurnOutcome> }

/** Starts one agent turn. Injectable so the invoker is testable without OpenClaw. */
export type TurnStarter = (request: TurnRequest) => Promise<TurnAdmission>

/** Whether a turn started now can look at AgentChat at all; `reason` is the operator line when it cannot. */
export type TurnReadiness = { readonly ready: true } | { readonly ready: false; readonly reason: string }

/**
 * The gateway config as it is NOW. OpenClaw hot-applies `mcp.*` changes (a
 * running gateway's turns have the tools right after `openclaw doctor --fix`
 * wrote the entry), so a readiness check must not read the snapshot the
 * account started with. `runtime.config.loadConfig()` is that live read;
 * without a usable runtime, or if it throws, the snapshot is what there is
 * (`live: false`) — and then a config fix needs a restart to be seen.
 */
export function readLiveConfig(fallback: unknown, runtime: () => PluginRuntime | null = getPluginRuntime): { cfg: unknown; live: boolean } {
  try {
    const loaded: unknown = runtime()?.config?.loadConfig?.()
    if (loaded && typeof loaded === 'object') return { cfg: loaded, live: true }
  } catch {
    // fall through to the snapshot
  }
  return { cfg: fallback, live: false }
}

/**
 * What can be known from inside the gateway about the hosted tools a turn
 * will have. OpenClaw discovers MCP servers per turn and the plugin runtime
 * exposes no tool catalog, so the plugin cannot ask which tools a run gets;
 * it can check the two things that decide it: the `mcp.servers.agentchat`
 * entry is in the gateway config (enabled), and the credential its bearer
 * template names is in this process's environment (OpenClaw resolves
 * `${AGENTCHAT_API_KEY}` from the gateway env; a gateway started before the
 * wizard wrote `.env` holds the unresolved template until it restarts or
 * reloads). A hand-written entry is the operator's and counts as ready.
 *
 * The invoker checks this before the gate: while unready nothing is asked,
 * nothing recorded, the cards wait on the tray and the ladder re-wakes —
 * instead of a turn running blind and then marking the conversation read.
 * `live: false` means `cfg` is the start-time snapshot (see `readLiveConfig`),
 * so a config fix is only seen after a restart; the reason says so then.
 */
export function turnReadiness(params: { cfg: unknown; apiBase: string; apiKey: string; env?: NodeJS.ProcessEnv; live?: boolean }): TurnReadiness {
  const env = params.env ?? process.env
  const restart = params.live === false ? ', then restart the gateway (this gateway cannot re-read its config while running)' : ''
  switch (describeMcpEntry(params.cfg, params.apiBase, params.apiKey)) {
    case 'missing':
      return { ready: false, reason: `mcp.servers.${MCP_SERVER_NAME} is not in the gateway config — run \`openclaw doctor --fix\`${restart}` }
    case 'disabled':
      return { ready: false, reason: `mcp.servers.${MCP_SERVER_NAME} is disabled in the gateway config — enable it${restart}` }
    case 'user_managed':
      return { ready: true }
    case 'ours': {
      const value = env[API_KEY_ENV]
      if (typeof value !== 'string' || value.trim().length === 0) {
        return {
          ready: false,
          reason: `${API_KEY_ENV} is not set in the gateway process, so the hosted tools' bearer template cannot resolve — restart the gateway (or reload its config) once ~/.openclaw/.env carries it`,
        }
      }
      return { ready: true }
    }
  }
}

/**
 * The turn starter for production. `deliver: false` — the final text is
 * recorded by OpenClaw and announced nowhere. The run's result is never read
 * by the integration: the agent's send is a hosted-tool call inside the
 * turn. `done` resolves when the run ends or `waitMs` passes, whichever
 * comes first; it never rejects.
 */
export function createRuntimeTurnStarter(params: {
  runtime?: () => PluginRuntime | null
  waitMs?: number
} = {}): TurnStarter {
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
    const done = runtime.subagent
      .waitForRun({ runId, timeoutMs: waitMs })
      .then(
        (waited): TurnOutcome => ({ ran: true, runId, status: waited.status, ...(waited.error ? { error: waited.error } : {}) }),
        // The run was admitted; only the wait failed. The turn is OpenClaw's now.
        (err): TurnOutcome => ({ ran: true, runId, status: 'unknown', error: err instanceof Error ? err.message : String(err) }),
      )
    return { ran: true, runId, done }
  }
}
