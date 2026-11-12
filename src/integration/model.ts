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
 *    tool during the turn. Admission and the run's end are reported
 *    separately (`TurnAdmission`): `done` resolves only once OpenClaw
 *    confirms the run is over (`./run.ts` — a `waitForRun` timeout bounds
 *    the wait, never the run, so it is asked again), with the AgentChat
 *    calls the run made read from its transcript when OpenClaw allows it.
 *
 * The agent id is resolved the way OpenClaw routes inbound for this channel
 * (`channelRuntime.routing.resolveAgentRoute`), so the integration wakes the
 * agent the operator bound to the account; `main` when nothing is bound.
 */

import type { PluginRuntime } from 'openclaw/plugin-sdk/channel-core'
import type { GateModelCall } from 'agentchatme'

import { getPluginRuntime } from './runtime-holder.js'
import { readAgentChatCalls, watchRunUntilEnded, type AgentChatCalls, type RunEndStatus } from './run.js'
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
  return async (prompt, options) => {
    const runtime = getRuntime()
    if (!runtime) throw new RuntimeUnavailableError('the gate call')
    // Two reasons to stop: our own timeout, and the kit's gate-call deadline
    // (the loop aborts its signal when it no longer wants the answer).
    // OpenClaw's `llm.complete` takes an AbortSignal, so both reach the call.
    const signals = [
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? [AbortSignal.timeout(timeoutMs)] : []),
      ...(options?.signal ? [options.signal] : []),
    ]
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    const result = await runtime.llm.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
      temperature: GATE_TEMPERATURE,
      ...(params.agentIdOverride ? { agentId: params.agentIdOverride } : {}),
      purpose: 'AgentChat reply gate: the server\'s question about the server\'s cards (tool-free triage)',
      ...(signal ? { signal } : {}),
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

/**
 * How an admitted turn's run ended, once OpenClaw confirmed it. `status`:
 * `ok` / `error` / `timeout` (the run's own deadline — never an elapsed
 * wait), or `gone` when the plugin runtime disappeared before an end was
 * confirmed (the gateway is going down; nothing in this process starts
 * another turn after it).
 */
export interface TurnOutcome {
  readonly ran: boolean
  readonly runId?: string
  readonly status?: RunEndStatus | 'gone'
  readonly error?: string
  /** AgentChat tool calls the run made, from its transcript; null when unknown — the transcript could not be read, or may be cut, or a call's outcome cannot be read from it (never zero, never all-ok). */
  readonly agentchatCalls?: AgentChatCalls | null
  /** From admission to the confirmed end. */
  readonly elapsedMs?: number
}

/**
 * What starting a turn reports: refused (OpenClaw did not admit
 * the run — no runtime, a thrown `subagent.run`), or admitted with the
 * promise of its end. `done` never rejects and resolves only when OpenClaw
 * confirmed the end (or the runtime is gone).
 */
export type TurnAdmission =
  | { readonly ran: false; readonly error: string }
  | { readonly ran: true; readonly runId: string; readonly sessionKey: string; readonly done: Promise<TurnOutcome> }

/** Starts one agent turn. Injectable so the loop wiring is testable without OpenClaw. */
export type TurnStarter = (request: TurnRequest) => Promise<TurnAdmission>

/** Whether a turn started now can look at AgentChat at all; `reason` is the operator line when it cannot. */
export type TurnReadiness = { readonly ready: true } | { readonly ready: false; readonly reason: string }

/**
 * The gateway config as it is NOW. OpenClaw hot-applies `mcp.*` changes (a
 * running gateway's turns have the tools right after `openclaw doctor --fix`
 * wrote the entry), so a readiness check must not read the snapshot the
 * account started with. `runtime.config.current()` (OpenClaw main) or
 * `runtime.config.loadConfig()` (older releases) is that live read;
 * without a usable runtime, or if it throws, the snapshot is what there is
 * (`live: false`) — and then a config fix needs a restart to be seen.
 */
export function readLiveConfig(fallback: unknown, runtime: () => PluginRuntime | null = getPluginRuntime): { cfg: unknown; live: boolean } {
  const config = (runtime() as { config?: { current?: () => unknown; loadConfig?: () => unknown } } | null)?.config
  // OpenClaw main: `runtime.config.current()` (`loadConfig` is gone there);
  // older releases: `runtime.config.loadConfig()`.
  for (const read of [config?.current, config?.loadConfig]) {
    if (typeof read !== 'function') continue
    try {
      const loaded: unknown = read.call(config)
      if (loaded && typeof loaded === 'object') return { cfg: loaded, live: true }
    } catch {
      // try the next way, then the snapshot
    }
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
 * The receive loop checks this before the gate: while unready nothing is asked,
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
 * recorded by OpenClaw and announced nowhere; the agent's send is a
 * hosted-tool call inside the turn. `done` resolves when OpenClaw confirms
 * the run ended (`watchRunUntilEnded`), then carries the AgentChat calls
 * counted from the run's transcript. It never rejects.
 */
export function createRuntimeTurnStarter(params: {
  runtime?: () => PluginRuntime | null
  /** One `waitForRun` call; the watch asks again until the run is over. */
  waitChunkMs?: number
  /** Called each time a wait elapses with the run still going. */
  onStillRunning?: (info: { runId: string; sessionKey: string; elapsedMs: number }) => void
  /** Called when a wait call fails (the watch retries). */
  onWaitError?: (info: { runId: string; sessionKey: string; error: string; attempt: number; retryInMs: number }) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
} = {}): TurnStarter {
  const getRuntime = params.runtime ?? getPluginRuntime
  return async (request) => {
    const runtime = getRuntime()
    if (!runtime) return { ran: false, error: new RuntimeUnavailableError('the agent turn').message }
    let runId: string
    // The session OpenClaw accepted the run in: newer releases return the
    // normalized key, which is where its transcript lives.
    let sessionKey = request.sessionKey
    try {
      const admitted = await runtime.subagent.run({
        sessionKey: request.sessionKey,
        message: request.prompt,
        lane: request.lane,
        deliver: false,
      })
      runId = admitted.runId
      const accepted = (admitted as { sessionKey?: unknown }).sessionKey
      if (typeof accepted === 'string' && accepted.trim().length > 0) sessionKey = accepted.trim()
    } catch (err) {
      return { ran: false, error: err instanceof Error ? err.message : String(err) }
    }
    const done = watchRunUntilEnded({
      runtime: getRuntime,
      runId,
      ...(params.waitChunkMs !== undefined ? { chunkMs: params.waitChunkMs } : {}),
      ...(params.onStillRunning ? { onStillRunning: (elapsedMs: number) => params.onStillRunning?.({ runId, sessionKey, elapsedMs }) } : {}),
      ...(params.onWaitError
        ? { onWaitError: (error: string, attempt: number, retryInMs: number) => params.onWaitError?.({ runId, sessionKey, error, attempt, retryInMs }) }
        : {}),
      ...(params.now ? { now: params.now } : {}),
      ...(params.sleep ? { sleep: params.sleep } : {}),
    }).then(async (watched): Promise<TurnOutcome> => {
      if (!watched.ended) return { ran: true, runId, status: 'gone', elapsedMs: watched.elapsedMs }
      const agentchatCalls = await readAgentChatCalls(getRuntime(), sessionKey, runId)
      return {
        ran: true,
        runId,
        status: watched.status,
        ...(watched.error ? { error: watched.error } : {}),
        agentchatCalls,
        elapsedMs: watched.elapsedMs,
      }
    })
    return { ran: true, runId, sessionKey, done }
  }
}

/**
 * Watches a run this process did not start — one OpenClaw's restart resume
 * started in a turn's session — until OpenClaw reports it ended, and what
 * AgentChat calls it made. Resolves null only when the plugin runtime is
 * gone. Never rejects.
 */
export function createRunWatcher(params: {
  runtime?: () => PluginRuntime | null
  onStillRunning?: (info: { runId: string; sessionKey: string; elapsedMs: number }) => void
  waitChunkMs?: number
} = {}): (run: { runId: string; sessionKey: string }) => Promise<TurnOutcome | null> {
  const getRuntime = params.runtime ?? getPluginRuntime
  return async ({ runId, sessionKey }) => {
    const watched = await watchRunUntilEnded({
      runtime: getRuntime,
      runId,
      ...(params.waitChunkMs !== undefined ? { chunkMs: params.waitChunkMs } : {}),
      ...(params.onStillRunning ? { onStillRunning: (elapsedMs: number) => params.onStillRunning?.({ runId, sessionKey, elapsedMs }) } : {}),
    })
    if (!watched.ended) return null
    const agentchatCalls = await readAgentChatCalls(getRuntime(), sessionKey, runId)
    return { ran: true, runId, status: watched.status, ...(watched.error ? { error: watched.error } : {}), agentchatCalls, elapsedMs: watched.elapsedMs }
  }
}
