/**
 * A turn's run, as OpenClaw reports it: admitted, watched until OpenClaw
 * confirms it ended, and what AgentChat calls it made.
 *
 * Why the watch never gives up on a timeout
 * ─────────────────────────────────────────
 * `runtime.subagent.waitForRun({ runId, timeoutMs })` bounds the WAIT, not
 * the run: "timeoutMs bounds the wait call; it does not cancel the run"
 * (docs.openclaw.ai/plugins/sdk-runtime/background-work). A `timeout`
 * status therefore says one of two things — the wait elapsed while the run
 * goes on, or the run hit its own deadline (`agents.defaults.timeoutSeconds`,
 * 48 h by default) and is over. Treating the first as an end would let the
 * conversation be gated again and a second turn answer it while the first
 * is still running. So the watch waits again until OpenClaw says the run
 * is over, with OpenClaw's own rule for telling the two apart
 * (`isTerminalAgentWaitTimeout` and the `untilTerminal` loop in
 * github.com/openclaw/openclaw `src/agents/run-wait.ts`):
 *
 *   - `ok`, `error`                      → ended
 *   - `pending`                          → running (a normal non-terminal observation)
 *   - `timeout` with `pendingError`      → running (a failed attempt may still recover)
 *   - `timeout` with `endedAt`, `stopReason` or `livenessState` → ended (the run's own deadline)
 *   - `timeout` that is a hard timeout → ended: a `timeoutPhase` of
 *     preflight / provider / tool_execution / post_turn, or `providerStarted`
 *     without a restart stop (`resolveAgentRunTerminalFacts`); an elapsed
 *     wait only ever reports `queue` or `gateway_draining`
 *   - `timeout` with an `error`          → ended
 *   - any other `timeout`                → running (the wait elapsed)
 *
 * Older OpenClaw lines (2026.6 and 2026.7, e.g. 2026.6.10 and 2026.7.35)
 * hand a plugin only `{ status, error }` (the wait metadata is dropped on the
 * way out). There a terminal timeout
 * is told apart by when it arrives: the gateway answers from the run's
 * terminal record as soon as there is one, while an elapsed wait (and a
 * failed attempt that may still recover) is answered when the wait's own
 * timer fires. A `timeout` that comes back in under half the requested
 * wait is an end; one that took the whole wait is asked again — if the run
 * did end meanwhile, the next wait is answered at once from that record.
 *
 * Nothing here cancels a run: the plugin runtime has no abort for a
 * subagent run, and OpenClaw's own run deadline is what bounds a run that
 * never finishes. The watch stops early only when the plugin runtime is
 * gone (the gateway is shutting down or the plugin was unloaded) — then
 * there is nothing left to ask, and nothing left in this process to start
 * a second turn either.
 */

import type { PluginRuntime } from 'openclaw/plugin-sdk/channel-core'

import { MCP_SERVER_NAME, MCP_TOOL_DELIMITER } from './turn.js'

/** One wait per call. Shorter than the old 15-minute bound so a live run is reported as live in the log. */
export const DEFAULT_RUN_WAIT_CHUNK_MS = 5 * 60_000

/** Back-off between failed waits (the gateway did not answer); the last value repeats. */
export const RUN_WAIT_RETRY_MS: readonly number[] = [1_000, 5_000, 15_000, 30_000, 60_000]

/** A wait that returns sooner than this, without saying the run went on, is not allowed to loop hot. */
const MIN_WAIT_SPACING_MS = 1_000

/** Transcript rows read after a run; one wake turn is a handful of tool calls. */
export const TRANSCRIPT_READ_LIMIT = 200

/** What `waitForRun` answers, across the OpenClaw versions the plugin supports. Every field is optional on purpose. */
export interface RunWaitObservation {
  readonly status?: unknown
  readonly error?: unknown
  readonly endedAt?: unknown
  readonly stopReason?: unknown
  readonly livenessState?: unknown
  readonly pendingError?: unknown
  readonly timeoutPhase?: unknown
  readonly startedAt?: unknown
  readonly providerStarted?: unknown
}

/** How a run ended, as OpenClaw confirmed it. `timeout` is the run's own deadline, never an elapsed wait. */
export type RunEndStatus = 'ok' | 'error' | 'timeout'

export type RunEnd =
  | { readonly ended: false }
  | { readonly ended: true; readonly status: RunEndStatus; readonly error?: string }

/** Keys only a release that forwards the gateway's wait metadata sends. */
const METADATA_KEYS = ['endedAt', 'stopReason', 'livenessState', 'pendingError', 'timeoutPhase', 'startedAt', 'providerStarted'] as const

/**
 * Whether one wait observation means the run is over. Pure. `elapsedMs` is
 * how long the wait call took and `requestedMs` what it was asked to wait;
 * they matter only for a release that drops the wait metadata.
 */
export function runEndOf(wait: RunWaitObservation | null | undefined, timing: { readonly requestedMs: number; readonly elapsedMs: number }): RunEnd {
  const status = wait?.status
  const error = nonEmpty(wait?.error)
  if (status === 'ok') return { ended: true, status: 'ok' }
  if (status === 'error') {
    // OpenClaw itself reads an `error` whose text is "completed" as a clean end.
    if (error && error.trim().toLowerCase() === 'completed') return { ended: true, status: 'ok' }
    return { ended: true, status: 'error', ...(error ? { error } : {}) }
  }
  if (status !== 'timeout') {
    // `pending`, or a status this version does not know: not an end.
    return { ended: false }
  }
  const ended = { ended: true as const, status: 'timeout' as const, ...(error ? { error } : {}) }
  const hasMetadata = wait !== null && wait !== undefined && METADATA_KEYS.some((key) => key in wait)
  if (!hasMetadata) {
    // Metadata dropped (OpenClaw 2026.6 / 2026.7 lines): only the timing tells. The
    // gateway answers from the run's terminal record as soon as there is
    // one; an elapsed wait — and a failed attempt that may still recover —
    // is answered when the wait's own timer fires.
    return timing.elapsedMs < timing.requestedMs / 2 ? ended : { ended: false }
  }
  if (wait.pendingError === true) return { ended: false }
  if (typeof wait.endedAt === 'number' || nonEmpty(wait.stopReason) || nonEmpty(wait.livenessState)) return ended
  if (isHardTimeout(wait)) return ended
  return error ? ended : { ended: false }
}

/** Timeout phases only a run's own deadline reports (OpenClaw `HARD_TIMEOUT_PHASES`). */
const HARD_TIMEOUT_PHASES: ReadonlySet<string> = new Set(['preflight', 'provider', 'tool_execution', 'post_turn'])

/**
 * OpenClaw's `hard_timeout` reading of a `timeout` snapshot (the third leg of
 * `isTerminalAgentWaitTimeout`): a phase only the run's own deadline reports,
 * or a timeout after the provider started that was not a restart stop.
 */
export function isHardTimeout(wait: RunWaitObservation): boolean {
  const phase = typeof wait.timeoutPhase === 'string' ? wait.timeoutPhase.trim() : ''
  if (HARD_TIMEOUT_PHASES.has(phase)) return true
  return wait.status === 'timeout' && wait.providerStarted === true && nonEmpty(wait.stopReason) !== 'restart'
}

/** What the watch reports. `gone`: the plugin runtime disappeared before OpenClaw confirmed an end. */
export type RunWatchResult =
  | { readonly ended: true; readonly status: RunEndStatus; readonly error?: string; readonly elapsedMs: number }
  | { readonly ended: false; readonly reason: 'gone'; readonly elapsedMs: number }

export interface RunWatchOptions {
  readonly runtime: () => PluginRuntime | null
  readonly runId: string
  readonly chunkMs?: number
  readonly retryMs?: readonly number[]
  /** Called each time a wait elapses with the run still going (for the "still running" log line). */
  readonly onStillRunning?: (elapsedMs: number) => void
  /** Called when a wait call fails; the watch tries again after the next back-off step. */
  readonly onWaitError?: (error: string, attempt: number, retryInMs: number) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Wait until OpenClaw confirms the run ended. Never rejects. Resolves with
 * `ended: true` and the run's status, or `ended: false` only when the
 * plugin runtime is gone.
 *
 * A wait call that fails is not an end either (the gateway did not answer;
 * the run is OpenClaw's): the watch backs off and asks again. A run the
 * gateway does not know is answered like a wait that elapsed (`timeout`,
 * `timeoutPhase: 'queue'` — OpenClaw has no "not found" for `agent.wait`), so
 * it is watched until the account lets go of it (`./hung.ts`).
 */
export async function watchRunUntilEnded(options: RunWatchOptions): Promise<RunWatchResult> {
  const chunkMs = options.chunkMs ?? DEFAULT_RUN_WAIT_CHUNK_MS
  const retryMs = options.retryMs ?? RUN_WAIT_RETRY_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const started = now()
  let failures = 0
  for (;;) {
    const runtime = options.runtime()
    if (!runtime) return { ended: false, reason: 'gone', elapsedMs: now() - started }
    const waitStarted = now()
    let observation: RunWaitObservation
    try {
      observation = (await runtime.subagent.waitForRun({ runId: options.runId, timeoutMs: chunkMs })) as RunWaitObservation
    } catch (err) {
      const message = describe(err)
      const delay = retryMs[Math.min(failures, retryMs.length - 1)] ?? 60_000
      failures += 1
      options.onWaitError?.(message, failures, delay)
      await sleep(delay)
      continue
    }
    failures = 0
    const elapsedMs = now() - waitStarted
    const end = runEndOf(observation, { requestedMs: chunkMs, elapsedMs })
    if (end.ended) return { ...end, elapsedMs: now() - started }
    options.onStillRunning?.(now() - started)
    if (elapsedMs < MIN_WAIT_SPACING_MS) await sleep(MIN_WAIT_SPACING_MS - elapsedMs)
  }
}

/** AgentChat tool calls a run made, read from its transcript. */
export interface AgentChatCalls {
  /** AgentChat tool results in the transcript. */
  readonly made: number
  /** Of those, the ones that came back as errors. */
  readonly failed: number
}

/**
 * Count the AgentChat tool results in a run's transcript. Pure. Returns
 * null when the transcript says nothing usable (no rows, or no row of a
 * shape this version knows) — the caller then treats the count as unknown,
 * never as zero.
 *
 * Two shapes are recognised, both read from OpenClaw transcripts:
 *   - a direct call: a `toolResult` row whose `toolName` is
 *     `agentchat__<tool>` (MCP tools exposed one by one);
 *   - a call through OpenClaw's tool-search surface: a `toolResult` row
 *     for the `tool_call` meta tool whose `details.tool` names the MCP
 *     server `agentchat` (or the `agentchat__<tool>` name).
 * `isError: true` marks a failed call. Rows tagged with another run's id
 * (`__openclaw.runId`) are skipped.
 */
export function countAgentChatCalls(messages: readonly unknown[], runId?: string): AgentChatCalls | null {
  if (messages.length === 0) return null
  let recognised = false
  let made = 0
  let failed = 0
  for (const row of messages) {
    const message = unwrapMessage(row)
    if (!message) continue
    const role = message.role
    if (role === 'assistant' || role === 'user') recognised = true
    if (role !== 'toolResult' && role !== 'tool') continue
    recognised = true
    const meta = asRecord(message.__openclaw)
    if (runId && typeof meta?.runId === 'string' && meta.runId !== runId) continue
    if (!isAgentChatToolResult(message)) continue
    made += 1
    if (message.isError === true) failed += 1
  }
  return recognised ? { made, failed } : null
}

/**
 * Read the run's transcript and count its AgentChat calls. Never throws:
 * a runtime that cannot read the session (no method, a refusal, an empty
 * session) gives null — unknown.
 */
export async function readAgentChatCalls(runtime: PluginRuntime | null, sessionKey: string, runId?: string): Promise<AgentChatCalls | null> {
  if (!runtime || typeof runtime.subagent?.getSessionMessages !== 'function') return null
  try {
    const result = await runtime.subagent.getSessionMessages({ sessionKey, limit: TRANSCRIPT_READ_LIMIT })
    const messages: unknown = result?.messages
    return Array.isArray(messages) ? countAgentChatCalls(messages, runId) : null
  } catch {
    return null
  }
}

const TOOL_PREFIX = `${MCP_SERVER_NAME}${MCP_TOOL_DELIMITER}`

function isAgentChatToolResult(message: Record<string, unknown>): boolean {
  const toolName = typeof message.toolName === 'string' ? message.toolName : typeof message.name === 'string' ? message.name : ''
  if (toolName.startsWith(TOOL_PREFIX)) return true
  const tool = asRecord(asRecord(message.details)?.tool)
  if (!tool) return false
  if (typeof tool.name === 'string' && tool.name.startsWith(TOOL_PREFIX)) return true
  if (tool.sourceName === MCP_SERVER_NAME) return true
  const mcp = asRecord(tool.mcp)
  return mcp?.serverName === MCP_SERVER_NAME
}

/** A transcript row is either the message itself or an event wrapping it (`{ type: 'message', message }`). */
function unwrapMessage(row: unknown): Record<string, unknown> | null {
  const record = asRecord(row)
  if (!record) return null
  if (typeof record.role === 'string') return record
  const inner = asRecord(record.message)
  return inner && typeof inner.role === 'string' ? inner : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
