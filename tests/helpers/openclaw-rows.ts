/**
 * Session transcript rows as OpenClaw writes them for hosted AgentChat tool
 * calls, by release. Every shape here is OpenClaw's own, never a guess: each
 * builder names the source that makes it. The direct-call rows are also what
 * OpenClaw 2026.6.10 and 2026.11.3 produced when driven for real (the MCP
 * materializer, the tool adapter and an agent session, as
 * tests/integration/openclaw-transcript.test.ts does with the installed
 * release). Fields the counting never reads (model, usage, long text) are
 * left out; nothing is added.
 *
 * Two release lines matter:
 *   - `2026.6.10` — the oldest release the plugin supports, and every release
 *     before 2026.9.3 (also the 2026.6 / 2026.7 / 2026.8 maintenance lines):
 *     a failed hosted-tool call is stored with `isError: false` and
 *     `details.status: 'error'`.
 *   - `2026.11.3` — the newest (npm `latest`), and every release from 2026.9.3
 *     on: `AgentSession.afterToolCall` also sets `isError: true` from the
 *     details (openclaw/openclaw#139758, `src/agents/sessions/agent-session-base.ts`).
 *
 * `sessions.get`, the read behind `runtime.subagent.getSessionMessages`, hands
 * each message back with `__openclaw.seq`, its 1-based position among the
 * session's messages (2026.6.10 `src/gateway/session-utils.fs.ts`
 * `readRecentSessionMessagesWithStatsAsync`; 2026.11.3 and main
 * `src/gateway/session-transcript-entry-message.ts`) — `withSeq` / `tail`.
 */

export type OpenClawLine = '2026.6.10' | '2026.11.3'

export const LINES: readonly OpenClawLine[] = ['2026.6.10', '2026.11.3']

/** Whether the release sets `isError` from the result details (2026.9.3 and later). */
const MARKS_ADAPTED_FAILURES: Record<OpenClawLine, boolean> = { '2026.6.10': false, '2026.11.3': true }

/** The Tool Search dispatcher: `tool_call` up to the 2026.9 line, `dispatch_action` from 2026.10.10 (openclaw/openclaw#169552). */
export const DISPATCHER: Record<OpenClawLine, string> = { '2026.6.10': 'tool_call', '2026.11.3': 'dispatch_action' }

export type Row = Record<string, unknown>

const T = 1_794_492_855_230

/** The wake prompt the turn starts with. */
export function userPrompt(): Row {
  return { role: 'user', content: 'You have AgentChat messages.', timestamp: T }
}

/** An assistant message asking for tool calls (agent-core `toolCall` content blocks). */
export function assistantCalls(calls: ReadonlyArray<{ id: string; name: string; arguments: Record<string, unknown> }>): Row {
  return { role: 'assistant', content: calls.map((call) => ({ type: 'toolCall', ...call })), stopReason: 'toolUse', timestamp: T }
}

export function assistantText(text: string): Row {
  return { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: T }
}

/**
 * The agent loop's `toolResult` row (2026.6.10 `packages/agent-core/src/agent-loop.ts`
 * `createToolResultMessage`; 2026.11.3 and main `packages/agent-core/src/agent-stream-response.ts`
 * `emitToolResultMessage`). 2026.11.3 also tags a network-sourced result
 * (`__openclaw.resultContentSource`).
 */
function toolResult(line: OpenClawLine, id: string, toolName: string, content: unknown[], details: Row, isError: boolean): Row {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName,
    content,
    details,
    isError,
    timestamp: T,
    ...(line === '2026.11.3' ? { __openclaw: { resultContentSource: 'network' } } : {}),
  }
}

const hosted = (tool: string) => `agentchat__${tool}`

/**
 * A hosted call that succeeded. Details from the MCP materializer
 * (2026.6.10 `src/agents/agent-bundle-mcp-materialize.ts` `toAgentToolResult`;
 * 2026.11.3 and main `src/agents/mcp-content.ts` `projectMcpCallToolResult`).
 */
export function mcpOk(line: OpenClawLine, id: string, tool: string, text = '{"conversations":[]}'): Row {
  return toolResult(line, id, hosted(tool), [{ type: 'text', text }], { mcpServer: 'agentchat', mcpTool: tool }, false)
}

/** The server answered the call with `isError: true`: the materializer adds `status: 'error'`. */
export function mcpServerError(line: OpenClawLine, id: string, tool: string, text = 'AWAITING_REPLY'): Row {
  return toolResult(line, id, hosted(tool), [{ type: 'text', text }], { mcpServer: 'agentchat', mcpTool: tool, status: 'error' }, MARKS_ADAPTED_FAILURES[line])
}

/**
 * The MCP call threw (transport, timeout, auth): the tool adapter returns
 * `jsonResult({ status: 'error', tool, error })` instead of throwing
 * (`src/agents/agent-tool-definition-adapter.ts` `buildToolExecutionErrorResult`).
 */
export function mcpThrew(line: OpenClawLine, id: string, tool: string, error = 'MCP error -32001: Request timed out'): Row {
  const details = { status: 'error', tool: hosted(tool), error }
  return toolResult(line, id, hosted(tool), [{ type: 'text', text: JSON.stringify(details, null, 2) }], details, MARKS_ADAPTED_FAILURES[line])
}

/**
 * A call the loop never ran (unknown tool, arguments that fail validation, an
 * abort): `createErrorToolResult`, `isError: true` on every release.
 */
export function notRun(line: OpenClawLine, id: string, toolName: string, text: string): Row {
  return toolResult(line, id, toolName, [{ type: 'text', text }], {}, true)
}

/** A before_tool_call hook vetoed the call (2026.6.10 `src/agents/agent-tools.before-tool-call.ts` `buildBlockedToolResult`). */
export function blocked(id: string, tool: string, reason = 'blocked by policy'): Row {
  return toolResult('2026.6.10', id, hosted(tool), [{ type: 'text', text: reason }], { status: 'blocked', deniedReason: 'plugin-before-tool-call', reason }, false)
}

/**
 * The catalog entry a Tool Search call names (2026.6.10 `src/agents/tool-search.ts`
 * `compactEntry`, id from `makeCatalogId`; 2026.11.3 and main
 * `src/agents/tool-search-catalog.ts` `compactToolSearchCatalogEntry`). As
 * the real runs stored it: on 2026.11.3 the MCP source is named after the
 * server and the entry carries an `input` hint.
 */
function catalogEntry(line: OpenClawLine, tool: string): Row {
  const sourceName = line === '2026.6.10' ? 'bundle-mcp' : 'agentchat'
  return {
    id: `mcp:${sourceName}:${hosted(tool)}`,
    source: 'mcp',
    sourceName,
    mcp: { serverName: 'agentchat', safeServerName: 'agentchat', toolName: tool, operation: 'tool' },
    name: hosted(tool),
    label: tool,
    description: tool,
    ...(line === '2026.11.3' ? { input: 'unknown' } : {}),
  }
}

/** The assistant's call to the dispatcher (`{ id, args }`, read by `readCallArgs` / `readToolSearchCallArgs`). */
export function dispatchCall(line: OpenClawLine, id: string, tool: string): Row {
  return assistantCalls([{ id, name: DISPATCHER[line], arguments: { id: catalogEntry(line, tool).id, args: {} } }])
}

/** A hosted call through the dispatcher that succeeded: `details` is `{ tool, result }` (2026.6.10 `src/agents/tool-search.ts`; 2026.11.3 and main the same file). */
export function dispatchOk(line: OpenClawLine, id: string, tool: string): Row {
  const result = { content: [{ type: 'text', text: '{"conversations":[]}' }], details: { mcpServer: 'agentchat', mcpTool: tool } }
  return toolResult(line, id, DISPATCHER[line], [{ type: 'text', text: '{}' }], { tool: catalogEntry(line, tool), result }, false)
}

/**
 * A hosted call through the dispatcher that the server failed. 2026.11.3 also
 * marks the dispatcher's own details (`status: resolveToolResultFailureKind(...)`).
 */
export function dispatchServerError(line: OpenClawLine, id: string, tool: string): Row {
  const result = { content: [{ type: 'text', text: 'AWAITING_REPLY' }], details: { mcpServer: 'agentchat', mcpTool: tool, status: 'error' } }
  const marked = MARKS_ADAPTED_FAILURES[line]
  return toolResult(line, id, DISPATCHER[line], [{ type: 'text', text: '{}' }], { tool: catalogEntry(line, tool), result, ...(marked ? { status: 'failed' } : {}) }, marked)
}

/** The hosted call through the dispatcher threw: the dispatcher threw too, and the adapter's error result names only the dispatcher. */
export function dispatchThrew(line: OpenClawLine, id: string, error = 'MCP error -32001: Request timed out'): Row {
  const details = { status: 'error', tool: DISPATCHER[line], error }
  return toolResult(line, id, DISPATCHER[line], [{ type: 'text', text: JSON.stringify(details, null, 2) }], details, MARKS_ADAPTED_FAILURES[line])
}

/**
 * A tool row mirrored from the Codex app-server harness (2026.6.10
 * `extensions/codex/src/app-server/transcript-mirror.ts` `createToolResultMessage`):
 * `isError` from the item status and no `details`, so a hosted call's result
 * cannot be read from it.
 */
export function codexMirrored(id: string, toolName: string, isError: boolean, text = 'ok'): Row {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName,
    isError,
    content: [{ type: 'toolResult', id, name: toolName, toolName, toolCallId: id, toolUseId: id, tool_use_id: id, content: text, text }],
    timestamp: T,
  }
}

/** Code Mode's catalog telemetry (`getTelemetry`, `src/agents/tool-search.ts`), as a Code Mode result carries it. */
function codeModeTelemetry(line: OpenClawLine): Row {
  return {
    catalogSize: 2,
    sources: { openclaw: 0, mcp: 2, client: 0 },
    searchCount: 0,
    describeCount: 0,
    callCount: 1,
    ...(line === '2026.6.10' ? { visibleTools: ['exec', 'wait'] } : {}),
  }
}

/**
 * Tool Search's code mode (2026.6.10 `src/agents/tool-search.ts`): the
 * script's calls go through the `openclaw.tools` bridge, and the row is
 * `jsonResult({ ok, value, logs, telemetry })`.
 */
export function toolSearchCode(id: string): Row[] {
  const details = { ok: true, value: null, logs: [], telemetry: codeModeTelemetry('2026.6.10') }
  return [
    assistantCalls([{ id, name: 'tool_search_code', arguments: { code: "return await openclaw.tools.call('agentchat__agentchat_send_message', { to: '@bob', text: 'hi' })" } }]),
    toolResult('2026.6.10', id, 'tool_search_code', [{ type: 'text', text: JSON.stringify(details, null, 2) }], details, false),
  ]
}

/**
 * Code Mode's `exec` (2026.6.10 `src/agents/code-mode.ts` `createCodeModeTools`,
 * `jsonResult(await runExec(...))`; 2026.11.3 and main the same file, the
 * script required as `code`, result through `formatToolSearchControlResult`):
 * `details` is the script's result, with `telemetry`. MCP tools are reached
 * from inside the script (2026.6.10: "MCP tools are available only through
 * the `MCP` namespace").
 */
export function codeModeExec(line: OpenClawLine, id: string): Row[] {
  // The script itself is the agent's; what it calls leaves no row.
  const code = 'return null'
  const details = { status: 'completed', value: null, ...(line === '2026.6.10' ? { output: [] } : {}), telemetry: codeModeTelemetry(line) }
  return [
    assistantCalls([{ id, name: 'exec', arguments: line === '2026.6.10' ? { code } : { title: 'Send the reply', code } }]),
    toolResult(line, id, 'exec', [{ type: 'text', text: JSON.stringify(details, null, 2) }], details, false),
  ]
}

/** Code Mode's `wait`, resuming a script that returned `status: 'waiting'` (`createCodeModeTools`). */
export function codeModeWait(line: OpenClawLine, id: string): Row[] {
  const details = { status: 'completed', value: null, telemetry: codeModeTelemetry(line) }
  return [
    assistantCalls([{ id, name: 'wait', arguments: { runId: 'cm_run_1' } }]),
    toolResult(line, id, 'wait', [{ type: 'text', text: JSON.stringify(details, null, 2) }], details, false),
  ]
}

/** The shell's `exec` (schema `src/agents/bash-tools.schemas.ts`, result `src/agents/bash-tools.exec-runtime.ts`). */
export function shellExec(line: OpenClawLine, id: string, command = 'date -u'): Row[] {
  const details = { status: 'completed', exitCode: 0, durationMs: 12, aggregated: '2026-11-12T06:00:00Z', cwd: '/tmp' }
  return [
    assistantCalls([{ id, name: 'exec', arguments: line === '2026.6.10' ? { command } : { title: 'Check the time', command } }]),
    toolResult(line, id, 'exec', [{ type: 'text', text: details.aggregated }], details, false),
  ]
}

/**
 * The rows as a run writes them from the 2026.8 line on: assistant and tool
 * rows carry the run that wrote them (`attachSessionTranscriptRunId`,
 * `src/sessions/transcript-events.ts`); user rows do not.
 */
export function ranBy(runId: string, rows: readonly Row[]): Row[] {
  return rows.map((row) => {
    if (row.role !== 'assistant' && row.role !== 'toolResult') return row
    const meta = row.__openclaw && typeof row.__openclaw === 'object' ? (row.__openclaw as Row) : {}
    return { ...row, __openclaw: { ...meta, runId } }
  })
}

/**
 * Details over 8 KiB, as the persistence guard stores them: the original
 * keys and the top-level `status` / `error` it keeps
 * (`src/agents/session-tool-result-guard.payload.ts`
 * `sanitizeToolResultDetailsForPersistence`; the same on 2026.6.10 and 2026.11.3).
 */
function truncated(keys: string[], kept: Row = {}): Row {
  return { persistedDetailsTruncated: true, originalDetailsBytesAtLeast: 8193, originalDetailKeys: keys, ...kept }
}

/** A Tool Search call whose result was over 8 KiB, stored with truncated details (the real 2026.6.10 and 2026.11.3 runs). */
export function dispatchOkLarge(line: OpenClawLine, id: string): Row {
  return toolResult(line, id, DISPATCHER[line], [{ type: 'text', text: '{}' }], truncated(['tool', 'result']), false)
}

/** …and one the server failed: 2026.11.3 keeps the dispatcher's `status: 'failed'`; 2026.6.10 had only the nested status, which is lost. */
export function dispatchServerErrorLarge(line: OpenClawLine, id: string): Row {
  const marked = MARKS_ADAPTED_FAILURES[line]
  return toolResult(line, id, DISPATCHER[line], [{ type: 'text', text: '{}' }], truncated(['tool', 'result', ...(marked ? ['status'] : [])], marked ? { status: 'failed' } : {}), marked)
}

/** A direct call whose `structuredContent` took its details over 8 KiB. */
export function mcpOkLarge(line: OpenClawLine, id: string, tool: string): Row {
  return toolResult(line, id, hosted(tool), [{ type: 'text', text: '{}' }], truncated(['mcpServer', 'mcpTool', 'structuredContent']), false)
}

/** …and one the server failed: the materializer's `status: 'error'` is kept. */
export function mcpServerErrorLarge(line: OpenClawLine, id: string, tool: string): Row {
  return toolResult(line, id, hosted(tool), [{ type: 'text', text: 'AWAITING_REPLY' }], truncated(['mcpServer', 'mcpTool', 'structuredContent', 'status'], { status: 'error' }), MARKS_ADAPTED_FAILURES[line])
}

/**
 * A call a dispatcher or a Code Mode script made, as 2026.11.3 records it
 * and `sessions.get` returns it (the real runs; schema
 * `src/sessions/nested-tool-activity.ts`, written by
 * `attempt-tool-search-executor.ts`). `isError` is OpenClaw's reading of the
 * result; a result over 32 KiB is replaced by a notice without details.
 */
export function nestedCall(parentToolCallId: string, tool: string, outcome: 'ok' | 'server_error' | 'omitted', runId = 'run_1'): Row {
  const toolName = tool.includes('__') || tool.startsWith('sessions_') ? tool : hosted(tool)
  const result =
    outcome === 'omitted'
      ? { content: [{ type: 'text', text: '[Nested tool output omitted: exceeds display limit]' }] }
      : outcome === 'server_error'
        ? { content: [{ type: 'text', text: 'AWAITING_REPLY' }], details: { mcpServer: 'agentchat', mcpTool: tool, status: 'error' } }
        : { content: [{ type: 'text', text: '{"conversations":[]}' }], details: { mcpServer: 'agentchat', mcpTool: tool } }
  const toolCallId = `tool_call:${parentToolCallId}:${toolName}:1`
  return {
    role: 'custom',
    customType: 'openclaw.nested-tool.v1',
    display: true,
    excludeFromContext: true,
    content: '',
    details: {
      runId,
      scopeId: 'scope_1',
      afterEntryId: 'entry_1',
      startOrder: 0,
      parentToolCallId,
      toolCallId,
      toolName,
      input: {},
      result,
      isError: outcome === 'server_error',
      startedAt: T,
      timestamp: T,
    },
    timestamp: T,
    idempotencyKey: `scope_1:${toolCallId}`,
  }
}

/** A Code Mode `exec` row whose details were over 8 KiB (the real 2026.11.3 run): only its keys and status are kept. */
export function codeModeExecLarge(id: string): Row[] {
  return [
    assistantCalls([{ id, name: 'exec', arguments: { title: 'Read the inbox', code: 'const [inbox] = await catalog.search("agentchat_inbox"); return await inbox({});' } }]),
    toolResult('2026.11.3', id, 'exec', [{ type: 'text', text: '{}' }], truncated(['status', 'replaySafe', 'telemetry', 'output', 'value'], { status: 'completed' }), false),
  ]
}

/** Code Mode's telemetry as 2026.11.3 stores it on an `exec` row (the real runs). */
const CODE_MODE_TELEMETRY_11 = { catalogSize: 44, sources: { openclaw: 42, mcp: 2, client: 0 }, counterScope: 'c4bbc2e584b1af56c2d9f27f', searchCount: 1, describeCount: 0, callCount: 1, visibleTools: ['exec', 'wait'] }

/**
 * A Code Mode script that threw after a call (the real 2026.11.3 run: the
 * inbox read, then a ReferenceError before the send): `isError: true`,
 * `status: 'failed'`.
 */
export function codeModeExecFailed(id: string): Row[] {
  const code = 'const [inbox] = await catalog.search("agentchat_inbox"); await inbox({}); await sendMessage({ to: "@bob", text: "hi" }); return null;'
  const details = {
    status: 'failed',
    code: 'internal_error',
    failurePhase: 'guest',
    bridgeDispatchStarted: true,
    replaySafe: false,
    telemetry: CODE_MODE_TELEMETRY_11,
    output: [],
    error: 'ReferenceError: sendMessage is not defined\n    at openclaw-code-mode:user.js:1:75',
  }
  return [assistantCalls([{ id, name: 'exec', arguments: { title: 'Answer', code } }]), toolResult('2026.11.3', id, 'exec', [{ type: 'text', text: '{}' }], details, true)]
}

/**
 * A Code Mode script left waiting on a call slower than the cell budget (the
 * real 2026.11.3 run): `status: 'waiting'` with the call still pending — it
 * has no nested row, and gets none once the run has ended.
 */
export function codeModeExecWaiting(id: string): Row[] {
  const code = 'const [inbox] = await catalog.search("agentchat_inbox"); await inbox({}); const [send] = await catalog.search("agentchat_send_message"); return await send({});'
  const details = {
    status: 'waiting',
    runId: 'cm_9efde101-9ead-434b-aed4-44a1be6301dc',
    reason: 'pending_tools',
    pendingToolCalls: [{ id: 'bridge:namespace:2', method: 'namespace' }],
    replaySafe: false,
    telemetry: { ...CODE_MODE_TELEMETRY_11, searchCount: 2, callCount: 2 },
    output: [],
  }
  return [assistantCalls([{ id, name: 'exec', arguments: { title: 'Answer', code } }]), toolResult('2026.11.3', id, 'exec', [{ type: 'text', text: '{}' }], details, false)]
}

/** A child session started by `sessions_spawn` (`src/agents/tools/sessions-spawn-tool.ts`: `task`; result `status: 'accepted'`). */
export function sessionsSpawn(line: OpenClawLine, id: string): Row[] {
  return [
    assistantCalls([{ id, name: 'sessions_spawn', arguments: { task: 'Answer the AgentChat conversation.' } }]),
    toolResult(line, id, 'sessions_spawn', [{ type: 'text', text: '{}' }], { status: 'accepted', childSessionKey: 'agent:main:subagent:child', runId: 'run_child', mode: 'run' }, false),
  ]
}

/**
 * A run started in another session by `sessions_send` (`src/agents/tools/sessions-send-tool.ts`:
 * `sessionKey` / `message`; accepted result 2026.6.10 `{ runId, status: 'accepted', sessionKey, delivery: { status, mode } }`
 * (`openclaw-tools-B0V1p3La.js:10807`), 2026.11.3 `{ runId, status: 'accepted', sessionKey, targetDisposition, delivery: { status } }`
 * (`sessions-spawn-tool-BEmFKy60.mjs:1022`)).
 */
export function sessionsSend(line: OpenClawLine, id: string): Row[] {
  const details = {
    runId: 'run_other',
    status: 'accepted',
    sessionKey: 'agent:main:main',
    ...(line === '2026.11.3' ? { targetDisposition: 'queued', delivery: { status: 'pending' } } : { delivery: { status: 'pending', mode: 'announce' } }),
  }
  return [
    assistantCalls([{ id, name: 'sessions_send', arguments: { sessionKey: 'agent:main:main', message: 'Answer @bob on AgentChat.' } }]),
    toolResult(line, id, 'sessions_send', [{ type: 'text', text: JSON.stringify(details, null, 2) }], details, false),
  ]
}

/** A compaction marker in the read (`src/gateway/session-utils.fs.ts` 2026.6.10; `session-transcript-entry-message.ts` 2026.11.3). */
export function compaction(): Row {
  return { role: 'system', content: [{ type: 'text', text: 'Compaction' }], timestamp: T, __openclaw: { kind: 'compaction', id: 'cmp_1' } }
}

/** A message too large to parse, replaced in the read by a placeholder that keeps only the role (`buildOversizedTranscriptRecord`). */
export function oversized(): Row {
  return { role: 'toolResult', content: [{ type: 'text', text: '[chat.history omitted: message too large]' }], __openclaw: { truncated: true, reason: 'oversized' } }
}

/** The rows as `sessions.get` returns a whole session: `__openclaw.seq` 1..n. */
export function withSeq(rows: readonly Row[]): Row[] {
  return rows.map((row, index) => seqAt(row, index + 1))
}

/** The last `limit` rows, as `sessions.get` returns a session longer than its limit (`seq` keeps counting from the session's start). */
export function tail(rows: readonly Row[], limit: number): Row[] {
  const start = Math.max(0, rows.length - limit)
  return rows.slice(start).map((row, index) => seqAt(row, start + index + 1))
}

function seqAt(row: Row, seq: number): Row {
  const meta = row.__openclaw && typeof row.__openclaw === 'object' ? (row.__openclaw as Row) : {}
  return { ...row, __openclaw: { ...meta, seq } }
}
