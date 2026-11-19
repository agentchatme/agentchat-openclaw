/**
 * Could not process, as the operator sees it: the pauses the server's
 * answers announce, the trouble that makes the counts a warning, and the
 * status / doctor lines. The counts are the kit's; nothing here decides.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { integration } from 'agentchatme'

import {
  RECENT_TROUBLE_MS,
  couldNotProcessView,
  noteCouldNotProcess,
  pausedConversations,
  recentTrouble,
  resetCouldNotProcessForTest,
} from '../../src/integration/could-not-process.js'

const NOW = Date.parse('2026-11-20T10:00:00.000Z')

function report(conversationId: string, result: { action: 'retry' | 'hidden' | 'paused' | 'none'; paused_until?: string | null } | null): integration.ReceiveLoopEvent {
  return {
    type: 'processing_failure',
    conversationId,
    source: 'gate',
    throughMessageId: 'msg_1',
    outcome: 'failed',
    evidence: 'runtime_check',
    result: result === null ? null : { action: result.action, attempts: 1, hidden_message_ids: [], paused_until: result.paused_until ?? null },
    ...(result === null ? { error: '503 upstream' } : {}),
    next: 'stop',
  }
}

const zero = {
  reported: 0, retry: 0, hidden: 0, paused: 0, none: 0, reportErrors: 0, reruns: 0, rerunsCapped: 0,
  awaitingEvidence: 0, runtimeChecksOk: 0, runtimeChecksFailed: 0, splitsStopped: 0, lastRuntimeCheck: null,
} as const

afterEach(() => resetCouldNotProcessForTest())

describe('the pauses the server announces', () => {
  it('a paused answer is kept until it ends, soonest first; another answer for the conversation drops it; a failed report changes nothing', () => {
    noteCouldNotProcess('default', report('conv_b', { action: 'paused', paused_until: '2026-11-21T09:00:00.000Z' }))
    noteCouldNotProcess('default', report('conv_a', { action: 'paused', paused_until: '2026-11-20T23:13:48.12345+00:00' }))
    noteCouldNotProcess('default', report('conv_old', { action: 'paused', paused_until: '2026-11-20T09:59:59.000Z' }))
    noteCouldNotProcess('default', report('conv_a', null))
    expect(pausedConversations('default', NOW)).toEqual([
      { conversationId: 'conv_a', until: '2026-11-20T23:13:48.12345+00:00' },
      { conversationId: 'conv_b', until: '2026-11-21T09:00:00.000Z' },
    ])
    noteCouldNotProcess('default', report('conv_b', { action: 'retry' }))
    expect(pausedConversations('default', NOW).map((p) => p.conversationId)).toEqual(['conv_a'])
    expect(pausedConversations('other', NOW)).toEqual([])
  })
})

describe('when the counts need a look', () => {
  it('a report that failed or a stopped split within the hour, or a failing last runtime check; older trouble is history', () => {
    expect(couldNotProcessView(zero, [], {}, NOW)).toEqual({ summary: 'could not process — nothing reported', attention: false, paused: [] })
    noteCouldNotProcess('default', report('conv_a', null), NOW - RECENT_TROUBLE_MS - 1)
    noteCouldNotProcess('default', { type: 'split_stopped', cycle: 3, remaining: 2, reason: 'runtime_check_failed' }, NOW - 60_000)
    expect(recentTrouble('default')).toEqual({ reportErrorAt: NOW - RECENT_TROUBLE_MS - 1, splitStoppedAt: NOW - 60_000 })
    const counts = { ...zero, reportErrors: 1, splitsStopped: 1 }
    expect(couldNotProcessView(counts, [], { reportErrorAt: NOW - RECENT_TROUBLE_MS - 1 }, NOW).attention).toBe(false)
    expect(couldNotProcessView(counts, [], recentTrouble('default'), NOW)).toEqual({
      summary: 'could not process — report errors 1 · gate split stopped 1×',
      attention: true,
      paused: [],
    })
    const failing = { ...zero, runtimeChecksFailed: 1, lastRuntimeCheck: { at: '2026-11-20T09:59:00.000Z', ok: false, detail: null } }
    expect(couldNotProcessView(failing, [], {}, NOW)).toEqual({ summary: 'could not process — runtime checks: failed 1 · last runtime check failed', attention: true, paused: [] })
    // A kit that predates the counts (the published 1.4.0) shows nothing reported.
    expect(couldNotProcessView(undefined, [], {}, NOW).summary).toBe('could not process — nothing reported')
  })
})
