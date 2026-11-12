/**
 * The AgentChat calls a turn made, counted from its session transcript, and
 * what the kit's after-turn rule then records. On a second silent look the
 * rule dismisses — marks the conversation READ — only when the calls are
 * known and none failed; anything else defers. So a failed call must count
 * as failed on every OpenClaw release, and a row whose outcome cannot be read
 * (or a read that may have missed rows) must make the count unknown, never
 * "all succeeded".
 *
 * Rows are OpenClaw's own shapes (tests/helpers/openclaw-rows.ts).
 */

import { describe, expect, it } from 'vitest'
import { integration } from 'agentchatme'
import type { PluginRuntime } from 'openclaw/plugin-sdk/channel-core'

import { createRunWatcher } from '../../src/integration/model.js'
import { countAgentChatCalls, readAgentChatCalls, TRANSCRIPT_READ_LIMIT, type AgentChatCalls } from '../../src/integration/run.js'
import { card, invite, tray } from '../helpers/fake-client.js'
import {
  assistantCalls,
  assistantText,
  blocked,
  codeModeExec,
  codeModeWait,
  codexMirrored,
  compaction,
  DISPATCHER,
  dispatchCall,
  dispatchOk,
  dispatchServerError,
  dispatchThrew,
  LINES,
  mcpOk,
  mcpServerError,
  mcpThrew,
  notRun,
  oversized,
  ranBy,
  shellExec,
  tail,
  toolSearchCode,
  userPrompt,
  withSeq,
  type OpenClawLine,
  type Row,
} from '../helpers/openclaw-rows.js'

const call = (id: string, tool: string, args: Record<string, unknown> = {}) => ({ id, name: `agentchat__${tool}`, arguments: args })

/** A turn that read the inbox, then made one more hosted call whose row is `second`. */
function inboxThen(line: OpenClawLine, second: Row, secondCall = call('call_send', 'agentchat_send_message', { to: '@bob', text: 'hi' })): Row[] {
  return withSeq([
    userPrompt(),
    assistantCalls([call('call_inbox', 'agentchat_inbox'), secondCall]),
    mcpOk(line, 'call_inbox', 'agentchat_inbox'),
    second,
    assistantText('done'),
  ])
}

/** What the kit records for a reply turn after a second silent look, given these counts. */
function secondSilentLook(calls: AgentChatCalls | null): string {
  const gateCard = card('conv_a', 'msg_1')
  const outcome = integration.turnOutcome({
    turn: { status: 'completed', agentchatCalls: calls },
    turnStartedAt: 0,
    gateCard,
    freshTray: tray([gateCard]),
    silentBefore: 1,
  })
  return outcome.action
}

/** What the kit does with a pending invite after a second silent look. */
function secondSilentInviteLook(calls: AgentChatCalls | null): string {
  const pending = invite('inv_1')
  return integration.inviteOutcome({ turn: { status: 'completed', agentchatCalls: calls }, invite: pending, freshTray: tray([], { invites: [pending] }), silentBefore: 1 }).action
}

describe.each(LINES)('OpenClaw %s — a failed hosted call counts as failed', (line) => {
  it('the server failed the call (MCP isError): not dismissed', () => {
    const counted = countAgentChatCalls(inboxThen(line, mcpServerError(line, 'call_send', 'agentchat_send_message')))
    expect(counted).toEqual({ made: 2, failed: 1 })
    expect(secondSilentLook(counted)).toBe('record_defer')
    expect(secondSilentInviteLook(counted)).toBe('none')
  })

  it('the call threw (transport, timeout): not dismissed', () => {
    const counted = countAgentChatCalls(inboxThen(line, mcpThrew(line, 'call_send', 'agentchat_send_message')))
    expect(counted).toEqual({ made: 2, failed: 1 })
    expect(secondSilentLook(counted)).toBe('record_defer')
    expect(secondSilentInviteLook(counted)).toBe('none')
  })

  it('every call failed: the turn could not look (nothing recorded)', () => {
    const rows = withSeq([
      userPrompt(),
      assistantCalls([call('call_inbox', 'agentchat_inbox')]),
      mcpThrew(line, 'call_inbox', 'agentchat_inbox', 'MCP error -32603: 401 Unauthorized'),
      assistantText('I cannot reach AgentChat.'),
    ])
    const counted = countAgentChatCalls(rows)
    expect(counted).toEqual({ made: 1, failed: 1 })
    expect(secondSilentLook(counted)).toBe('none')
    expect(secondSilentInviteLook(counted)).toBe('none')
  })

  it('a call the loop never ran (unknown tool) is a failed call', () => {
    expect(countAgentChatCalls(inboxThen(line, notRun(line, 'call_send', 'agentchat__agentchat_send_message', 'Tool agentchat__agentchat_send_message not found')))).toEqual({ made: 2, failed: 1 })
  })

  it('through Tool Search, the server failed the call: not dismissed', () => {
    const rows = withSeq([
      userPrompt(),
      assistantCalls([call('call_inbox', 'agentchat_inbox')]),
      mcpOk(line, 'call_inbox', 'agentchat_inbox'),
      dispatchCall(line, 'call_dispatch', 'agentchat_send_message'),
      dispatchServerError(line, 'call_dispatch', 'agentchat_send_message'),
      assistantText('done'),
    ])
    const counted = countAgentChatCalls(rows)
    expect(counted).toEqual({ made: 2, failed: 1 })
    expect(secondSilentLook(counted)).toBe('record_defer')
  })

  it('through Tool Search, the call threw: the target is read from the call itself, and it failed', () => {
    const rows = withSeq([
      userPrompt(),
      assistantCalls([call('call_inbox', 'agentchat_inbox')]),
      mcpOk(line, 'call_inbox', 'agentchat_inbox'),
      dispatchCall(line, 'call_dispatch', 'agentchat_send_message'),
      dispatchThrew(line, 'call_dispatch'),
      assistantText('done'),
    ])
    const counted = countAgentChatCalls(rows)
    expect(counted).toEqual({ made: 2, failed: 1 })
    expect(secondSilentLook(counted)).toBe('record_defer')
  })
})

describe.each(LINES)('OpenClaw %s — a clean turn counts exactly', (line) => {
  it('direct calls that all succeeded: counted, and the second silent look dismisses', () => {
    const rows = inboxThen(line, mcpOk(line, 'call_conv', 'agentchat_get_conversation', '{"messages":[]}'), call('call_conv', 'agentchat_get_conversation', { conversation_id: 'conv_a' }))
    const counted = countAgentChatCalls(rows)
    expect(counted).toEqual({ made: 2, failed: 0 })
    expect(secondSilentLook(counted)).toBe('record_dismiss')
    expect(secondSilentInviteLook(counted)).toBe('dismiss_invite')
  })

  it('a call through Tool Search that succeeded is counted', () => {
    const rows = withSeq([userPrompt(), dispatchCall(line, 'call_dispatch', 'agentchat_inbox'), dispatchOk(line, 'call_dispatch', 'agentchat_inbox'), assistantText('nothing to do')])
    expect(countAgentChatCalls(rows)).toEqual({ made: 1, failed: 0 })
  })

  it('other tools are not AgentChat calls, failed or not', () => {
    const rows = withSeq([
      userPrompt(),
      assistantCalls([call('call_inbox', 'agentchat_inbox'), { id: 'call_web', name: 'web_search', arguments: { query: 'x' } }]),
      mcpOk(line, 'call_inbox', 'agentchat_inbox'),
      notRun(line, 'call_web', 'web_search', 'Tool web_search not found'),
      // A Tool Search call to another MCP server's tool that threw.
      assistantCalls([{ id: 'call_other', name: DISPATCHER[line], arguments: { id: 'mcp:bundle-mcp:browser__open', args: {} } }]),
      dispatchThrew(line, 'call_other'),
      assistantText('done'),
    ])
    expect(countAgentChatCalls(rows)).toEqual({ made: 1, failed: 0 })
  })

  it('a turn that called nothing is zero calls (it could not look)', () => {
    const counted = countAgentChatCalls(withSeq([userPrompt(), assistantText('nothing to do')]))
    expect(counted).toEqual({ made: 0, failed: 0 })
    expect(secondSilentLook(counted)).toBe('none')
  })
})

describe('OpenClaw 2026.6.10 — a call a hook blocked counts as failed', () => {
  it('details.status blocked with isError false', () => {
    expect(countAgentChatCalls(inboxThen('2026.6.10', blocked('call_send', 'agentchat_send_message')))).toEqual({ made: 2, failed: 1 })
  })
})

describe('unknown, never ok', () => {
  it('a hosted call whose row carries no readable outcome makes the count unknown', () => {
    // A Codex-harness mirror row: `isError` from the item status, no details.
    const counted = countAgentChatCalls(inboxThen('2026.6.10', codexMirrored('call_send', 'agentchat__agentchat_send_message', false)))
    expect(counted).toBeNull()
    expect(secondSilentLook(counted)).toBe('record_defer')
    expect(secondSilentInviteLook(counted)).toBe('none')
  })

  it('a Tool Search call that threw, with no call naming its target, is unknown', () => {
    const rows = withSeq([userPrompt(), assistantCalls([call('call_inbox', 'agentchat_inbox')]), mcpOk('2026.6.10', 'call_inbox', 'agentchat_inbox'), dispatchThrew('2026.6.10', 'call_lost')])
    expect(countAgentChatCalls(rows)).toBeNull()
  })

  it('the transcript says nothing usable', () => {
    expect(countAgentChatCalls([])).toBeNull()
    expect(countAgentChatCalls([{ kind: 'header' }, 'x', null])).toBeNull()
  })
})

describe('the read must cover the whole turn', () => {
  /** A long turn: an early send that failed, then `n` inbox reads that succeeded. */
  function longTurn(n: number): Row[] {
    const rows: Row[] = [
      userPrompt(),
      assistantCalls([call('call_send', 'agentchat_send_message', { to: '@bob', text: 'hi' })]),
      mcpServerError('2026.6.10', 'call_send', 'agentchat_send_message'),
    ]
    for (let i = 0; i < n; i += 1) rows.push(assistantCalls([call(`call_inbox_${i}`, 'agentchat_inbox')]), mcpOk('2026.6.10', `call_inbox_${i}`, 'agentchat_inbox'))
    rows.push(assistantText('done'))
    return rows
  }

  it(`a turn longer than the ${TRANSCRIPT_READ_LIMIT}-row read is unknown — its early failure is outside the window`, () => {
    const rows = longTurn(TRANSCRIPT_READ_LIMIT)
    expect(rows.length).toBeGreaterThan(TRANSCRIPT_READ_LIMIT)
    const window = tail(rows, TRANSCRIPT_READ_LIMIT)
    const counted = countAgentChatCalls(window)
    expect(counted).toBeNull()
    expect(secondSilentLook(counted)).toBe('record_defer')
  })

  it('the same turn read whole counts its early failure', () => {
    expect(countAgentChatCalls(withSeq(longTurn(TRANSCRIPT_READ_LIMIT)))).toEqual({ made: TRANSCRIPT_READ_LIMIT + 1, failed: 1 })
  })

  it('a read without positions cannot show it starts at the turn: unknown', () => {
    const rows = withSeq([userPrompt(), assistantCalls([call('call_inbox', 'agentchat_inbox')]), mcpOk('2026.6.10', 'call_inbox', 'agentchat_inbox')])
    expect(countAgentChatCalls(rows.map(({ __openclaw: _meta, ...row }) => row))).toBeNull()
  })

  it('a compaction marker or an oversized placeholder in the read stands for rows that are not there: unknown', () => {
    const base = [userPrompt(), assistantCalls([call('call_inbox', 'agentchat_inbox')]), mcpOk('2026.6.10', 'call_inbox', 'agentchat_inbox')]
    expect(countAgentChatCalls(withSeq([...base, compaction(), assistantText('done')]))).toBeNull()
    expect(countAgentChatCalls(withSeq([...base, assistantCalls([call('call_conv', 'agentchat_get_conversation')]), oversized(), assistantText('done')]))).toBeNull()
  })

  it('readAgentChatCalls asks for the window and reports the long turn as unknown', async () => {
    const rows = longTurn(TRANSCRIPT_READ_LIMIT)
    const asked: unknown[] = []
    const runtime = {
      subagent: {
        getSessionMessages: async (params: { sessionKey: string; limit?: number }) => {
          asked.push(params)
          return { messages: tail(rows, params.limit ?? TRANSCRIPT_READ_LIMIT) }
        },
      },
    } as unknown as PluginRuntime
    expect(await readAgentChatCalls(runtime, 'agent:main:subagent:agentchat-wake-x', 'run_1')).toBeNull()
    expect(asked).toEqual([{ sessionKey: 'agent:main:subagent:agentchat-wake-x', limit: TRANSCRIPT_READ_LIMIT }])
  })
})

describe.each(LINES)('OpenClaw %s — a turn that used Code Mode is unknown (its calls leave no rows)', (line) => {
  const withInbox = (...more: Row[]) =>
    withSeq([userPrompt(), assistantCalls([call('call_inbox', 'agentchat_inbox')]), mcpOk(line, 'call_inbox', 'agentchat_inbox'), ...more, assistantText('done')])

  it('a Code Mode exec: unknown, never ok — not dismissed', () => {
    const counted = countAgentChatCalls(withInbox(...codeModeExec(line, 'call_exec')))
    expect(counted).toBeNull()
    expect(secondSilentLook(counted)).toBe('record_defer')
    expect(secondSilentInviteLook(counted)).toBe('none')
  })

  it('a Code Mode wait: unknown', () => {
    expect(countAgentChatCalls(withInbox(...codeModeWait(line, 'call_wait')))).toBeNull()
  })

  it('a Code Mode exec whose result row is missing: unknown (the call alone says Code Mode)', () => {
    expect(countAgentChatCalls(withInbox(codeModeExec(line, 'call_exec')[0] as Row))).toBeNull()
  })

  it('an exec that is not recognisably the shell’s counts as Code Mode: unknown', () => {
    // The shell's exec, as asked, but the row is the adapter's error result — either exec throws this.
    const [ask] = shellExec(line, 'call_exec')
    const threw = { ...notRun(line, 'call_exec', 'exec', '{}'), details: { status: 'error', tool: 'exec', error: 'spawn failed' } }
    expect(countAgentChatCalls(withInbox(ask as Row, threw))).toBeNull()
  })

  it('the shell’s exec is not Code Mode: the count stays exact', () => {
    const counted = countAgentChatCalls(withInbox(...shellExec(line, 'call_exec')))
    expect(counted).toEqual({ made: 1, failed: 0 })
    expect(secondSilentLook(counted)).toBe('record_dismiss')
  })
})

describe('OpenClaw 2026.6.10 — Tool Search code mode', () => {
  it('a tool_search_code row: unknown', () => {
    const rows = withSeq([userPrompt(), assistantCalls([call('call_inbox', 'agentchat_inbox')]), mcpOk('2026.6.10', 'call_inbox', 'agentchat_inbox'), ...toolSearchCode('call_code'), assistantText('done')])
    const counted = countAgentChatCalls(rows)
    expect(counted).toBeNull()
    expect(secondSilentLook(counted)).toBe('record_defer')
  })
})

describe('a session that holds more than one run (a turn OpenClaw resumed after a restart)', () => {
  /** The original run: its send failed, then the gateway restarted. */
  const original = (line: OpenClawLine) => [
    userPrompt(),
    assistantCalls([call('call_send', 'agentchat_send_message', { to: '@bob', text: 'hi' })]),
    mcpServerError(line, 'call_send', 'agentchat_send_message'),
  ]
  /** The resumed run, in the same session: it read the inbox, then stopped. */
  const resumed = (line: OpenClawLine) => [userPrompt(), assistantCalls([call('call_inbox', 'agentchat_inbox')]), mcpOk(line, 'call_inbox', 'agentchat_inbox'), assistantText('done')]

  it('rows tagged with another run (2026.8 line on): counting one run would be partial — unknown', () => {
    const rows = withSeq([...ranBy('run_original', original('2026.11.3')), ...ranBy('run_resumed', resumed('2026.11.3'))])
    expect(countAgentChatCalls(rows, 'run_resumed')).toBeNull()
    expect(countAgentChatCalls(rows, 'run_original')).toBeNull()
    expect(secondSilentLook(countAgentChatCalls(rows, 'run_resumed'))).toBe('record_defer')
  })

  it('one run in its own session counts exactly, tagged or not', () => {
    expect(countAgentChatCalls(withSeq(ranBy('run_resumed', resumed('2026.11.3'))), 'run_resumed')).toEqual({ made: 1, failed: 0 })
    expect(countAgentChatCalls(withSeq(resumed('2026.6.10')), 'run_resumed')).toEqual({ made: 1, failed: 0 })
  })

  it('rows OpenClaw does not tag (before the 2026.8 line) are the whole session: both runs are counted, nothing skipped', () => {
    const rows = withSeq([...original('2026.6.10'), ...resumed('2026.6.10')])
    expect(countAgentChatCalls(rows, 'run_resumed')).toEqual({ made: 2, failed: 1 })
  })

  it('the watcher of a resumed run reports unknown, not the resumed run alone', async () => {
    const rows = withSeq([...ranBy('run_original', original('2026.11.3')), ...ranBy('run_resumed', resumed('2026.11.3'))])
    const runtime = {
      subagent: {
        waitForRun: async () => ({ status: 'ok' }),
        getSessionMessages: async () => ({ messages: rows }),
      },
    } as unknown as PluginRuntime
    const watch = createRunWatcher({ runtime: () => runtime })
    const outcome = await watch({ runId: 'run_resumed', sessionKey: 'agent:main:subagent:agentchat-wake-x' })
    expect(outcome).toMatchObject({ ran: true, runId: 'run_resumed', status: 'ok', agentchatCalls: null })
  })
})
