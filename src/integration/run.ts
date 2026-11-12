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
 *     without a restart stop (`resolveAgentRunTerminalFacts`)
 *   - `timeout` with an `error`          → ended
 *   - any other `timeout`                → running (the wait elapsed)
 *
 * On OpenClaw main a wait that elapses comes back bare — `{ runId, status:
 * 'timeout' }`, no snapshot (`src/gateway/agent-turn/agent-wait.ts`) — a
 * queued run as `pending` with `timeoutPhase: 'queue'`, and a gateway
 * lifecycle reset as `timeout` with `timeoutPhase: 'gateway_draining'`. A
 * bare `timeout` carries none of the metadata keys, so it is read by the
 * timing rule below: one that took the whole wait is asked again.
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

/** Transcript rows read after a run; one wake turn is a handful of tool calls. A longer session reads as unknown (`countAgentChatCalls`). */
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
 * gateway does not know is answered like a wait that elapsed (a bare
 * `{ status: 'timeout' }` after the whole wait — OpenClaw has no "not found"
 * for `agent.wait`), so it is watched until the turn is handed off and let
 * go of (`./running.ts`).
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
 * Count the AgentChat tool calls in a run's transcript. Pure.
 *
 * The count decides a READ: on a second silent look the kit's after-turn
 * rule dismisses the conversation (marks it read) only when the calls are
 * known and none failed, and defers otherwise (`integration.turnOutcome`).
 * So the count is exact for the row shapes OpenClaw writes, and null —
 * unknown, which the rule never reads as success — whenever it cannot be:
 *
 *   - the transcript says nothing usable (no rows, or a row that is not a
 *     message);
 *   - the rows read may not be the whole turn: the first is not message 1
 *     of the session (`__openclaw.seq`; a wake turn has a session of its
 *     own, so message 1 is where it starts), or the read holds a compaction
 *     or reset marker or an oversized-message placeholder, which stand for
 *     rows that are not there;
 *   - an AgentChat call's outcome cannot be read from its row (`callVerdict`);
 *   - the turn used Code Mode (`usedCodeMode`) on a release that does not
 *     record the calls a script makes (see the nested rows below);
 *   - the turn handed work to another session's run (`sessions_spawn`,
 *     `sessions_send`): that run's calls are in its own session;
 *   - the session holds rows of another run (`__openclaw.runId`, which
 *     OpenClaw writes on assistant and tool rows from the 2026.8 line on —
 *     `attachSessionTranscriptRunId`, `src/sessions/transcript-events.ts`):
 *     a turn OpenClaw resumed after a gateway restart runs again in the same
 *     session, and counting one run of it would be a partial count.
 *
 * The row shapes (OpenClaw's own; 2026.6.10 is the oldest supported release,
 * 2026.11.3 the newest at the time of writing, `main` its repository):
 *
 *   A direct call — `toolName` `agentchat__<tool>` (`toolResult` row from
 *   the agent loop, `packages/agent-core`):
 *     ok      `isError: false`, `details: { mcpServer: 'agentchat', mcpTool }`
 *             (`mcpOperation` for the resource / prompt helpers), from the
 *             MCP materializer (`src/agents/agent-bundle-mcp-materialize.ts`,
 *             `src/agents/mcp-content.ts`).
 *     failed  the server answered `isError: true` → `details.status: 'error'`;
 *             the call threw → the tool adapter's
 *             `details: { status: 'error', tool, error }`
 *             (`src/agents/agent-tool-definition-adapter.ts`); a hook vetoed
 *             it → `details.status: 'blocked'`; the loop never ran it →
 *             `isError: true`, `details: {}`. Before 2026.9.3 the first three
 *             keep `isError: false` — only the details say the call failed;
 *             from 2026.9.3 `AgentSession.afterToolCall` sets `isError` from
 *             them too (`src/agents/sessions/agent-session-base.ts`,
 *             openclaw/openclaw#139758).
 *   A call through Tool Search — the dispatcher `tool_call` (renamed
 *   `dispatch_action` in 2026.10.10, openclaw/openclaw#169552):
 *     ok      `details: { tool: <catalog entry>, result: <the direct result> }`.
 *     failed  `details.result` holds the failed direct result (2026.9.3+
 *             also `details.status: 'failed'` and `isError: true`); the
 *             target threw → the adapter's `details: { status: 'error',
 *             tool: '<dispatcher>', error }`, with no entry — the target is
 *             then read from the assistant's call (`arguments.id` / `toolId`
 *             / `name`, as `src/agents/tool-search.ts` reads it).
 *
 *   A nested call — a call a Tool Search dispatcher or a Code Mode script
 *   made, recorded by the release as its own row (`role: 'custom'`,
 *   `customType: 'openclaw.nested-tool.v1'`, `details: { runId,
 *   parentToolCallId, toolCallId, toolName, result, isError, … }`;
 *   `src/sessions/nested-tool-activity.ts`, written by
 *   `src/agents/embedded-agent-runner/run/attempt-tool-search-executor.ts`
 *   from the 2026.8 line on). Its `isError` is OpenClaw's reading of the
 *   result (`isError || isToolResultError(result)`, `handleToolExecutionEnd`,
 *   `src/agents/embedded-agent-subscribe.handlers.tools.ts`); the result is
 *   kept up to 32 KiB. A dispatcher row with nested rows under it is not
 *   counted itself: its call is the nested row.
 *   Known limit: the executor writes the row only while its attempt is
 *   still the current one (`if (!params.isCurrent()) return false` before
 *   `appendMessageAsync`, `attempt-tool-search-executor.ts`). A nested call
 *   that finishes after its attempt was superseded or aborted leaves no
 *   row, and nothing in the transcript says one is missing — such a turn
 *   is counted from the rows that are there.
 *
 *   A row whose details were too large to store — over 8 KiB, the
 *   persistence guard keeps `{ persistedDetailsTruncated, originalDetailKeys }`
 *   and the top-level `status` / `error` / `success`
 *   (`src/agents/session-tool-result-guard.payload.ts`). A direct call keeps
 *   its failure marks at the top level on every release, so it is still
 *   read exactly. A dispatcher row keeps only its own top-level status,
 *   which says failure from 2026.9.3 on: there `isError: false` with no
 *   status is a success; before, the failure was nested and is lost, so the
 *   row is unknown.
 *
 * Which release wrote the rows is read from the rows where they show it —
 * a nested row (the release records nested calls), a `dispatch_action`
 * dispatcher (2026.10.10 and later) — and otherwise from `openclawVersion`,
 * the host's OpenClaw version (`runtime.version`).
 *
 * Failure in `details` is read with OpenClaw's own rule
 * (`isToolResultError`, `src/agents/tool-result-error.ts`).
 */
export function countAgentChatCalls(messages: readonly unknown[], runId?: string, host: { readonly openclawVersion?: string } = {}): AgentChatCalls | null {
  if (messages.length === 0) return null
  const rows: Record<string, unknown>[] = []
  for (const row of messages) {
    const message = unwrapMessage(row)
    if (!message) return null
    rows.push(message)
  }
  if (!coversWholeSession(rows)) return null
  if (runId && rows.some((row) => isOtherRun(row, runId))) return null
  const calls = assistantToolCalls(rows)
  const nested = rows.flatMap((row) => {
    const call = nestedCallOf(row)
    return call ? [call] : []
  })
  const release = releaseOf(rows, calls, nested, host.openclawVersion)
  if (delegatedToChild(rows, calls, nested)) return null
  if (usedCodeMode(rows, calls) && !release.recordsNestedCalls) return null
  // A dispatcher (or Code Mode) row whose calls have nested rows: the nested rows are those calls.
  const parents = new Set(nested.flatMap((call) => (typeof call.parentToolCallId === 'string' ? [call.parentToolCallId] : [])))
  let made = 0
  let failed = 0
  for (const message of rows) {
    let verdict: CallVerdict
    const call = nestedCallOf(message)
    if (call) verdict = nestedVerdict(call)
    else if (message.role !== 'toolResult' && message.role !== 'tool') continue
    else if (typeof message.toolCallId === 'string' && parents.has(message.toolCallId)) continue
    else verdict = callVerdict(message, calls, release)
    if (verdict === 'not_agentchat') continue
    if (verdict === 'unknown') return null
    made += 1
    if (verdict === 'failed') failed += 1
  }
  return { made, failed }
}

/**
 * Read the run's transcript and count its AgentChat calls. Never throws:
 * a runtime that cannot read the session (no method, a refusal, an empty
 * session) gives null — unknown, as `countAgentChatCalls` does for a read
 * it cannot trust.
 */
export async function readAgentChatCalls(runtime: PluginRuntime | null, sessionKey: string, runId?: string): Promise<AgentChatCalls | null> {
  if (!runtime || typeof runtime.subagent?.getSessionMessages !== 'function') return null
  try {
    const result = await runtime.subagent.getSessionMessages({ sessionKey, limit: TRANSCRIPT_READ_LIMIT })
    const messages: unknown = result?.messages
    const openclawVersion = typeof runtime.version === 'string' ? runtime.version : undefined
    return Array.isArray(messages) ? countAgentChatCalls(messages, runId, openclawVersion ? { openclawVersion } : {}) : null
  } catch {
    return null
  }
}

const TOOL_PREFIX = `${MCP_SERVER_NAME}${MCP_TOOL_DELIMITER}`

/** OpenClaw's Tool Search dispatcher, by release: `tool_call`, then `dispatch_action` (2026.10.10). */
const DISPATCHER_TOOL_NAMES: ReadonlySet<string> = new Set(['tool_call', 'dispatch_action'])

/** Statuses OpenClaw reads as a failed tool result (`TOOL_RESULT_FAILURE_STATUSES`, `src/agents/tool-result-error.ts`). */
const FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'error',
  'failed',
  'failure',
  'timeout',
  'timed_out',
  'blocked',
  'denied',
  'forbidden',
  'unavailable',
  'approval-unavailable',
  'disabled',
  'aborted',
  'cancelled',
  'canceled',
  'killed',
  'invalid',
])

type CallVerdict = 'ok' | 'failed' | 'unknown' | 'not_agentchat'

/**
 * Whether the rows read are the whole session. `sessions.get` (behind
 * `getSessionMessages`) numbers each message by its place in the session,
 * `__openclaw.seq` from 1 (2026.6.10 `src/gateway/session-utils.fs.ts`,
 * 2026.11.3 and main `src/gateway/session-transcript-entry-message.ts`), and
 * reads from the end — a session longer than the limit, or past the read's
 * byte cap, starts later. A compaction or reset marker, or an oversized
 * message's placeholder (`__openclaw.truncated`), stands for rows the read
 * does not carry.
 */
function coversWholeSession(rows: readonly Record<string, unknown>[]): boolean {
  if (asRecord(rows[0]?.__openclaw)?.seq !== 1) return false
  return rows.every((row) => {
    const meta = asRecord(row.__openclaw)
    return meta?.kind !== 'compaction' && meta?.kind !== 'reset' && meta?.truncated !== true
  })
}

/** A row OpenClaw attributes to a run other than `runId`. */
function isOtherRun(row: Record<string, unknown>, runId: string): boolean {
  const tagged = asRecord(row.__openclaw)?.runId ?? nestedCallOf(row)?.runId
  return typeof tagged === 'string' && tagged.trim().length > 0 && tagged.trim() !== runId
}

/** Tool Search's code mode (2026.6.10: `tool_search_code`, `src/agents/tool-search.ts`) and Code Mode's resume tool (`wait`, `src/agents/code-mode-control-tools.ts`); no other tool has these names. */
const CODE_MODE_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(['tool_search_code', 'wait'])

/**
 * Whether the turn ran a Code Mode script. Code Mode's `exec` shares its name
 * with the shell's `exec` (`src/agents/code-mode-control-tools.ts`), so an
 * `exec` counts as Code Mode unless it is recognisably the shell's: Code
 * Mode's takes the script as `code` (the shell's schema has no `code`,
 * `src/agents/bash-tools.schemas.ts`) and its result carries `telemetry`;
 * the shell's result carries `exitCode` / `durationMs` / `aggregated`
 * (`src/agents/bash-tools.exec-runtime.ts`). Anything in between counts as
 * Code Mode — never as a turn without it.
 */
function usedCodeMode(rows: readonly Record<string, unknown>[], calls: ReadonlyMap<string, Record<string, unknown>>): boolean {
  for (const call of calls.values()) {
    const name = typeof call.name === 'string' ? call.name : ''
    if (CODE_MODE_ONLY_TOOL_NAMES.has(name)) return true
    if (name === 'exec' && typeof callArguments(call)?.code === 'string') return true
  }
  return rows.some((row) => {
    if (row.role !== 'toolResult' && row.role !== 'tool') return false
    const name = typeof row.toolName === 'string' ? row.toolName : typeof row.name === 'string' ? row.name : ''
    if (CODE_MODE_ONLY_TOOL_NAMES.has(name)) return true
    return name === 'exec' && !isShellExecResult(row, calls)
  })
}

function isShellExecResult(row: Record<string, unknown>, calls: ReadonlyMap<string, Record<string, unknown>>): boolean {
  const call = typeof row.toolCallId === 'string' ? calls.get(row.toolCallId) : undefined
  const args = callArguments(call)
  if (!args || typeof args.command !== 'string' || args.code !== undefined) return false
  const details = asRecord(row.details)
  if (!details || details.telemetry !== undefined) return false
  return details.exitCode !== undefined || typeof details.durationMs === 'number' || typeof details.aggregated === 'string'
}

/** The assistant's tool calls by id (agent-core `toolCall` content blocks). */
function assistantToolCalls(rows: readonly Record<string, unknown>[]): ReadonlyMap<string, Record<string, unknown>> {
  const calls = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    if (row.role !== 'assistant' || !Array.isArray(row.content)) continue
    for (const block of row.content) {
      const call = asRecord(block)
      if (call?.type === 'toolCall' && typeof call.id === 'string') calls.set(call.id, call)
    }
  }
  return calls
}

/** What a release is known to write. */
interface Release {
  /** Nested calls get rows of their own (`openclaw.nested-tool.v1`). */
  readonly recordsNestedCalls: boolean
  /** A failed call's row says so at its top level: `isError`, and a dispatcher's own `status` (2026.9.3). */
  readonly marksFailedRows: boolean
}

/** The first release this code trusts by version alone: failures marked on the row (openclaw/openclaw#139758) and nested calls recorded. */
const TRUSTED_RELEASE = '2026.9.3'

function releaseOf(rows: readonly Record<string, unknown>[], calls: ReadonlyMap<string, Record<string, unknown>>, nested: readonly Record<string, unknown>[], version: string | undefined): Release {
  const byVersion = version !== undefined && openclawVersionAtLeast(version, TRUSTED_RELEASE)
  // `dispatch_action` is the dispatcher's name from 2026.10.10 on.
  const dispatchAction = rows.some((row) => toolNameOf(row) === 'dispatch_action') || [...calls.values()].some((call) => call.name === 'dispatch_action')
  return { recordsNestedCalls: nested.length > 0 || dispatchAction || byVersion, marksFailedRows: dispatchAction || byVersion }
}

/** `a >= b` for OpenClaw's `YYYY.M.N` versions; a prerelease is below its release, anything unreadable is below everything. */
export function openclawVersionAtLeast(a: string, b: string): boolean {
  const parse = (v: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v.trim())
    return match ? { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] !== undefined } : null
  }
  const [x, y] = [parse(a), parse(b)]
  if (!x || !y) return false
  for (let i = 0; i < 3; i += 1) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return !x.pre || y.pre
}

function toolNameOf(row: Record<string, unknown>): string {
  return typeof row.toolName === 'string' ? row.toolName : typeof row.name === 'string' ? row.name : ''
}

/** OpenClaw's nested-call row (`NESTED_TOOL_ACTIVITY_CUSTOM_TYPE`, `src/sessions/nested-tool-activity.ts`): its details. */
const NESTED_TOOL_ACTIVITY = 'openclaw.nested-tool.v1'

function nestedCallOf(row: Record<string, unknown>): Record<string, unknown> | null {
  if (row.role !== 'custom' || row.customType !== NESTED_TOOL_ACTIVITY) return null
  return asRecord(row.details)
}

/** A nested call: `isError` is OpenClaw's own reading of the result, and the result's details are read too when kept. */
function nestedVerdict(call: Record<string, unknown>): CallVerdict {
  const toolName = typeof call.toolName === 'string' ? call.toolName : ''
  if (!toolName.startsWith(TOOL_PREFIX)) return 'not_agentchat'
  const result = asRecord(call.result)
  if (call.isError === true || (result !== null && failedResult(result.isError, asRecord(result.details)))) return 'failed'
  return call.isError === false ? 'ok' : 'unknown'
}

/**
 * Tools that hand work to another session's run, whose calls are stored in
 * that session: `sessions_spawn` starts a child session
 * (`src/agents/tools/sessions-spawn-tool.ts`; 2026.6.10
 * `openclaw-tools-*.js`, 2026.11.3 `sessions-spawn-tool-*.mjs`), and
 * `sessions_send` starts a run in an existing one
 * (`src/agents/tools/sessions-send-tool.ts`, result `{ runId, status:
 * 'accepted', sessionKey, … }`; the same chunks).
 */
const OTHER_SESSION_TOOLS: ReadonlySet<string> = new Set(['sessions_spawn', 'sessions_send'])

/** Whether the turn handed work to another session's run — called directly, through Tool Search, or from a script. */
function delegatedToChild(rows: readonly Record<string, unknown>[], calls: ReadonlyMap<string, Record<string, unknown>>, nested: readonly Record<string, unknown>[]): boolean {
  const names = (value: unknown) => typeof value === 'string' && OTHER_SESSION_TOOLS.has(value)
  for (const call of calls.values()) {
    if (names(call.name)) return true
    if (typeof call.name === 'string' && DISPATCHER_TOOL_NAMES.has(call.name) && names(dispatchTarget(call))) return true
  }
  if (nested.some((call) => names(call.toolName))) return true
  return rows.some((row) => names(toolNameOf(row)) || names(asRecord(asRecord(row.details)?.tool)?.name))
}

/** What one tool row says about an AgentChat call (see `countAgentChatCalls` for the shapes). */
function callVerdict(message: Record<string, unknown>, calls: ReadonlyMap<string, Record<string, unknown>>, release: Release): CallVerdict {
  const toolName = toolNameOf(message)
  const details = asRecord(message.details)
  if (toolName.startsWith(TOOL_PREFIX)) return directVerdict(message.isError, details)
  const entry = asRecord(details?.tool)
  if (entry && isAgentChatEntry(entry)) return dispatchedVerdict(message.isError, details)
  if (!DISPATCHER_TOOL_NAMES.has(toolName) || entry) return 'not_agentchat'
  // A dispatcher row without a catalog entry: the target threw or never
  // resolved, and only the assistant's call says what it was.
  const target = dispatchTarget(typeof message.toolCallId === 'string' ? calls.get(message.toolCallId) : undefined)
  if (target === null) return 'unknown'
  if (!target.startsWith(TOOL_PREFIX)) return 'not_agentchat'
  if (failedResult(message.isError, details)) return 'failed'
  // Details over 8 KiB: from 2026.9.3 a failure keeps its top-level status, so none is a success.
  if (release.marksFailedRows && isTruncated(details) && message.isError === false && details?.status === undefined) return 'ok'
  return 'unknown'
}

/** Details the persistence guard replaced (`persistedDetailsTruncated`). */
function isTruncated(details: Record<string, unknown> | null): boolean {
  return details?.persistedDetailsTruncated === true
}

/** A direct hosted-tool row. */
function directVerdict(isError: unknown, details: Record<string, unknown> | null): CallVerdict {
  if (failedResult(isError, details)) return 'failed'
  if (isError !== false) return 'unknown'
  if (isTruncated(details)) return details?.status === undefined && wasHostedResult(details) ? 'ok' : 'unknown'
  return isHostedSuccessDetails(details) ? 'ok' : 'unknown'
}

/** A truncated row whose original details were the MCP materializer's (their keys are kept). */
function wasHostedResult(details: Record<string, unknown> | null): boolean {
  const keys = Array.isArray(details?.originalDetailKeys) ? (details.originalDetailKeys as unknown[]) : []
  return keys.includes('mcpServer') && (keys.includes('mcpTool') || keys.includes('mcpOperation'))
}

/** A dispatcher row whose catalog entry is an AgentChat tool. */
function dispatchedVerdict(isError: unknown, details: Record<string, unknown> | null): CallVerdict {
  const result = asRecord(details?.result)
  if (failedResult(isError, details)) return 'failed'
  if (result && failedResult(result.isError, asRecord(result.details))) return 'failed'
  const ok = isError === false && details?.status === undefined && isHostedSuccessDetails(asRecord(result?.details))
  return ok ? 'ok' : 'unknown'
}

function failedResult(isError: unknown, details: Record<string, unknown> | null): boolean {
  return isError === true || detailsSayFailed(details)
}

/**
 * OpenClaw's reading of a failed result from its details (`isToolResultError`,
 * `src/agents/tool-result-error.ts` — the same rule on 2026.6.10, 2026.11.3
 * and main).
 */
function detailsSayFailed(details: Record<string, unknown> | null): boolean {
  if (!details) return false
  if (details.ok === false || details.success === false) return true
  const status = typeof details.status === 'string' ? details.status.trim().toLowerCase() : ''
  const explicitlyOk = details.ok === true || details.success === true
  if (FAILURE_STATUSES.has(status) && !explicitlyOk) return true
  if (details.timedOut === true || Boolean(details.error)) return true
  if (status === 'completed') return false
  const exitCode = details.exitCode
  return typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0
}

/** The details the MCP materializer gives a hosted call that succeeded: the server named, no status. */
function isHostedSuccessDetails(details: Record<string, unknown> | null): boolean {
  if (!details || details.mcpServer !== MCP_SERVER_NAME || details.status !== undefined) return false
  return nonEmpty(details.mcpTool) !== undefined || nonEmpty(details.mcpOperation) !== undefined
}

function isAgentChatEntry(tool: Record<string, unknown>): boolean {
  if (typeof tool.name === 'string' && tool.name.startsWith(TOOL_PREFIX)) return true
  if (tool.sourceName === MCP_SERVER_NAME) return true
  const mcp = asRecord(tool.mcp)
  return mcp?.serverName === MCP_SERVER_NAME
}

/**
 * The tool a dispatcher call named: its `id`, `toolId` or `name` argument,
 * a catalog id (`mcp:<source>:<tool>`) or the tool's name. Null when the
 * call is not there or names nothing.
 */
function dispatchTarget(call: Record<string, unknown> | undefined): string | null {
  const record = callArguments(call)
  const selector = nonEmpty(record?.id) ?? nonEmpty(record?.toolId) ?? nonEmpty(record?.name)
  if (!selector) return null
  const trimmed = selector.trim()
  return trimmed.slice(trimmed.lastIndexOf(':') + 1)
}

/** A tool call's arguments as a record (a provider may leave them a JSON string). Null when there are none. */
function callArguments(call: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!call) return null
  let args: unknown = call.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  return asRecord(args)
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
