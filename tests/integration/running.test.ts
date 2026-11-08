/**
 * The account's running turns: one kit tracker per account for the process
 * (shared by every loop for the account), and the operator line for a turn
 * that runs long — a hung run keeps its card held; OpenClaw's run deadline
 * is what ends it.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  OPENCLAW_DEFAULT_RUN_TIMEOUT_SECONDS,
  TURN_OVERDUE_MS,
  overdueTurnLine,
  overdueTurnLines,
  resetRunningTurnsForTest,
  runDeadline,
  trackerFor,
} from '../../src/integration/running.js'

afterEach(() => resetRunningTurnsForTest())

describe('one tracker per account', () => {
  it('every loop for an account gets the same tracker; another account gets its own', () => {
    expect(trackerFor('default')).toBe(trackerFor('default'))
    expect(trackerFor('other')).not.toBe(trackerFor('default'))
    const handle = trackerFor('default').begin({ kind: 'reply', conversationId: 'conv_a', anchor: 'msg_1' })
    expect(handle).not.toBeNull()
    // A second loop for the account sees the card held.
    expect(trackerFor('default').conversationRunning('conv_a')).toBe(true)
  })
})

describe('a turn that runs long', () => {
  it('OpenClaw’s run deadline: agents.defaults.timeoutSeconds, else its 48 h default; 0 = none', () => {
    expect(runDeadline({})).toEqual({ seconds: OPENCLAW_DEFAULT_RUN_TIMEOUT_SECONDS, configured: false })
    expect(OPENCLAW_DEFAULT_RUN_TIMEOUT_SECONDS).toBe(172_800)
    expect(runDeadline({ agents: { defaults: { timeoutSeconds: 600 } } })).toEqual({ seconds: 600, configured: true })
    expect(runDeadline({ agents: { defaults: { timeoutSeconds: 0 } } })).toEqual({ seconds: 0, configured: true })
  })

  it('the line names the conversation or invite, how long, that the card stays held, and what ends the run', () => {
    expect(overdueTurnLine({ kind: 'reply', id: 'conv_a', elapsedMs: 31 * 60_000 }, {})).toBe(
      "a turn for conversation conv_a has run 31 min — its card stays held (no second reply) until the run ends; OpenClaw ends it at its run deadline, agents.defaults.timeoutSeconds = 172800 (OpenClaw's default, 48 h)",
    )
    expect(overdueTurnLine({ kind: 'invite', id: 'gri_1', elapsedMs: 90 * 60_000 }, { agents: { defaults: { timeoutSeconds: 0 } } })).toMatch(
      /^a turn for invite gri_1 has run 90 min — .*agents\.defaults\.timeoutSeconds is 0 \(no deadline\), so it may never end — restart the gateway to end it$/,
    )
  })

  it('only turns past 30 minutes are reported', () => {
    const now = 10 * TURN_OVERDUE_MS
    const lines = overdueTurnLines(
      [
        { kind: 'reply', conversationId: 'conv_new', startedAt: now - 5 * 60_000 },
        { kind: 'reply', conversationId: 'conv_old', startedAt: now - TURN_OVERDUE_MS - 1 },
        { kind: 'invite', inviteId: 'gri_old', startedAt: now - 2 * TURN_OVERDUE_MS },
      ],
      {},
      now,
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^a turn for conversation conv_old has run 30 min/)
    expect(lines[1]).toMatch(/^a turn for invite gri_old has run 60 min/)
  })
})
