/**
 * The account's turns: one kit tracker per account for the process (shared
 * by every loop), every live run recorded until OpenClaw reports it ended, a
 * run that never ends handed off after 30 minutes (the slot freed, the
 * conversation still held), at most MAX_HUNG_TURNS of those before the
 * account stops gating, the operator's release, and the live loop woken when
 * a held run ends.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  AccountTurns,
  MAX_HUNG_TURNS,
  OPENCLAW_DEFAULT_RUN_TIMEOUT_SECONDS,
  TURN_OVERDUE_MS,
  accountTurns,
  hungTurnsReason,
  overdueTurnLine,
  overdueTurnLines,
  resetRunningTurnsForTest,
  runDeadline,
  trackerFor,
  type RunRecord,
} from '../../src/integration/running.js'

afterEach(() => resetRunningTurnsForTest())

function record(runId: string, id: string, extra: Partial<RunRecord> = {}): RunRecord {
  return { runId, kind: 'reply', id, anchor: `msg_${id}`, sessionKey: `agent:main:subagent:agentchat-wake-${runId}`, startedAt: 0, owner: 'loop#1', ...extra }
}

/** A run as the kit holds it: the tracker entry its loop began. */
function heldByKit(turns: AccountTurns, rec: RunRecord) {
  const handle = turns.tracker.begin({ kind: 'reply', conversationId: rec.id, anchor: rec.anchor })
  turns.started(rec)
  return handle
}

describe('one per account', () => {
  it('every loop for an account gets the same turns and tracker; another account its own', () => {
    expect(accountTurns('default')).toBe(accountTurns('default'))
    expect(trackerFor('default')).toBe(accountTurns('default').tracker)
    expect(accountTurns('other')).not.toBe(accountTurns('default'))
  })
})

describe('a run that never ends', () => {
  it('hand-off: the kit lets go of it (its slot frees), the conversation stays held here, the live loop is woken', () => {
    const turns = new AccountTurns()
    const released: string[] = []
    turns.tracker.onRelease((handle) => released.push(handle.key))
    let wakes = 0
    turns.setLive('loop#1', () => void (wakes += 1))
    const kitHandle = heldByKit(turns, record('run_1', 'conv_a'))
    expect(turns.handOff('run_1')).toMatchObject({ id: 'conv_a' })
    expect(released).toEqual(['conversation:conv_a'])
    expect(turns.tracker.holds(kitHandle!)).toBe(false) // the kit's own turn is released: it records nothing
    expect(turns.tracker.conversationRunning('conv_a')).toBe(true) // still held — no second reply
    expect(turns.hungCount).toBe(1)
    expect(wakes).toBe(1)
    expect(turns.handOff('run_1')).toBeNull() // once
  })

  it('when OpenClaw finally reports it ended, the hold drops and the live loop is woken to gate the card', () => {
    const turns = new AccountTurns()
    let wakes = 0
    turns.setLive('loop#1', () => void (wakes += 1))
    heldByKit(turns, record('run_1', 'conv_a'))
    turns.handOff('run_1')
    turns.ended('run_1')
    expect(turns.tracker.conversationRunning('conv_a')).toBe(false)
    expect(turns.hungCount).toBe(0)
    expect(wakes).toBe(2)
  })

  it(`at ${MAX_HUNG_TURNS} hung turns the account stops gating: readiness names them and what to do`, () => {
    const turns = new AccountTurns({ now: () => 45 * 60_000 })
    heldByKit(turns, record('run_1', 'conv_a'))
    heldByKit(turns, record('run_2', 'conv_b'))
    turns.handOff('run_1')
    expect(hungTurnsReason(turns, {}, 45 * 60_000)).toBeNull()
    turns.handOff('run_2')
    const reason = hungTurnsReason(turns, {}, 45 * 60_000)
    expect(reason).toMatch(/^2 turns are hung in OpenClaw \(conversation conv_a for 45 min, conversation conv_b for 45 min\) — no gate calls until one ends, so other cards are waiting on the tray;/)
    expect(reason).toMatch(/openclaw agentchat release <conversation_id>/)
  })

  it('the operator’s release lets go of a hung hold, or of a turn the kit still holds', () => {
    const turns = new AccountTurns()
    let wakes = 0
    turns.setLive('loop#1', () => void (wakes += 1))
    heldByKit(turns, record('run_1', 'conv_a'))
    heldByKit(turns, record('run_2', 'conv_b'))
    turns.handOff('run_1')
    expect(turns.release('conv_a')).toMatchObject({ released: true, what: 'hung', runId: 'run_1' })
    expect(turns.tracker.conversationRunning('conv_a')).toBe(false)
    expect(turns.release('conv_b')).toMatchObject({ released: true, what: 'running', key: 'conversation:conv_b', runId: 'run_2' })
    expect(turns.tracker.conversationRunning('conv_b')).toBe(false)
    expect(turns.release('conv_x')).toEqual({ released: false, reason: 'no turn holds conv_x' })
    expect(wakes).toBeGreaterThanOrEqual(3)
  })
})

describe('a held run ends after an account restart', () => {
  it('the live (newer) loop is woken once the old loop has freed the card', async () => {
    const turns = new AccountTurns()
    const handle = heldByKit(turns, record('run_1', 'conv_a', { owner: 'loop#1' }))
    let wakes = 0
    turns.setLive('loop#2', () => void (wakes += 1))
    turns.ended('run_1')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(wakes).toBe(0) // the old loop is still recording: the card is still held
    turns.tracker.end(handle!)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(wakes).toBe(1)
  })

  it('a run of the live loop itself wakes nothing extra (the kit handles its own)', async () => {
    const turns = new AccountTurns()
    heldByKit(turns, record('run_1', 'conv_a', { owner: 'loop#1' }))
    let wakes = 0
    turns.setLive('loop#1', () => void (wakes += 1))
    turns.ended('run_1')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(wakes).toBe(0)
  })
})

describe('the long-turn line', () => {
  it('OpenClaw’s run deadline: agents.defaults.timeoutSeconds, else its 48 h default; 0 = none', () => {
    expect(runDeadline({})).toEqual({ seconds: OPENCLAW_DEFAULT_RUN_TIMEOUT_SECONDS, configured: false })
    expect(OPENCLAW_DEFAULT_RUN_TIMEOUT_SECONDS).toBe(172_800)
    expect(runDeadline({ agents: { defaults: { timeoutSeconds: 600 } } })).toEqual({ seconds: 600, configured: true })
    expect(runDeadline({ agents: { defaults: { timeoutSeconds: 0 } } })).toEqual({ seconds: 0, configured: true })
  })

  it('names the conversation or invite, how long, that it stays held, what ends the run', () => {
    expect(overdueTurnLine({ kind: 'reply', id: 'conv_a', elapsedMs: 31 * 60_000 }, {})).toBe(
      "a turn for conversation conv_a has run 31 min — that conversation stays held (no second reply) until the run ends; OpenClaw ends it at its run deadline, agents.defaults.timeoutSeconds = 172800 (OpenClaw's default, 48 h); other conversations are not held up by it",
    )
    expect(overdueTurnLine({ kind: 'invite', id: 'gri_1', elapsedMs: 90 * 60_000 }, { agents: { defaults: { timeoutSeconds: 0 } } })).toMatch(
      /^a turn for invite gri_1 has run 90 min — .*agents\.defaults\.timeoutSeconds is 0 \(no deadline\), so it may never end;/,
    )
  })

  it('only runs past 30 minutes are reported', () => {
    const now = 10 * TURN_OVERDUE_MS
    const lines = overdueTurnLines(
      [record('a', 'conv_new', { startedAt: now - 5 * 60_000 }), record('b', 'conv_old', { startedAt: now - TURN_OVERDUE_MS - 1 }), record('c', 'gri_old', { kind: 'invite', anchor: null, startedAt: now - 2 * TURN_OVERDUE_MS })],
      {},
      now,
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^a turn for conversation conv_old has run 30 min/)
    expect(lines[1]).toMatch(/^a turn for invite gri_old has run 60 min/)
  })
})
