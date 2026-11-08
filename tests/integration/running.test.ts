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
  accountsWithTurns,
  findAccountTurns,
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
    const turns = new AccountTurns({ now: () => 45 * 60_000 })
    let wakes = 0
    turns.setLive('loop#1', () => void (wakes += 1))
    heldByKit(turns, record('run_1', 'conv_a'))
    heldByKit(turns, record('run_2', 'conv_b'))
    turns.handOff('run_1')
    expect(turns.release('conv_a')).toMatchObject({ released: true, what: 'hung', runId: 'run_1' })
    expect(turns.tracker.conversationRunning('conv_a')).toBe(false)
    const laneBefore = turns.laneGeneration
    expect(turns.release('conv_b')).toMatchObject({ released: true, what: 'running', key: 'conversation:conv_b', runId: 'run_2' })
    expect(turns.laneGeneration).toBe(laneBefore + 1) // the released run may still occupy its lane
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

describe('a release that comes in through a gateway RPC', () => {
  it('runs in the live loop’s async context, not the caller’s (OpenClaw retires the request scope when the RPC returns)', async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks')
    const scope = new AsyncLocalStorage<string>()
    const turns = new AccountTurns()
    const seenOnWake: Array<string | undefined> = []
    // The loop is created in the account's own context…
    scope.run('account-task', () => {
      const inLoopContext = AsyncLocalStorage.snapshot()
      turns.setLive('loop#1', () => inLoopContext(() => seenOnWake.push(scope.getStore())), (fn) => inLoopContext(fn))
    })
    turns.tracker.begin({ kind: 'reply', conversationId: 'conv_a', anchor: 'msg_1' })
    const seenOnRelease: Array<string | undefined> = []
    turns.tracker.onRelease(() => seenOnRelease.push(scope.getStore()))
    // …the operator's release arrives inside a gateway request's context.
    scope.run('gateway-rpc', () => turns.release('conv_a', { force: true }))
    expect(seenOnRelease).toEqual(['account-task'])
    expect(seenOnWake).toEqual(['account-task'])
  })
})

describe('a release sticks (the old run never touches the next turn)', () => {
  it('released after the hand-off: later "still running" reports hand nothing off again, and the next turn for the conversation stays held', () => {
    let clock = 35 * 60_000
    const turns = new AccountTurns({ now: () => clock })
    heldByKit(turns, record('run_1', 'conv_a'))
    expect(turns.handOff('run_1')).not.toBeNull()
    expect(turns.release('conv_a')).toMatchObject({ released: true, what: 'hung', runId: 'run_1' })
    expect(turns.stateOf('run_1')).toBe('released')
    // The conversation gets a new turn…
    const next = heldByKit(turns, record('run_2', 'conv_a', { startedAt: clock }))
    const lane = turns.laneGeneration
    // …and the old run keeps reporting "still running" every 5 minutes.
    for (let i = 0; i < 6; i += 1) {
      clock += 5 * 60_000
      expect(turns.handOff('run_1')).toBeNull()
    }
    expect(turns.tracker.holds(next!)).toBe(true)
    expect(turns.laneGeneration).toBe(lane)
    expect(turns.hungCount).toBe(0)
    expect(turns.runningRuns().map((r) => r.runId)).toEqual(['run_2']) // the released run holds nothing: not reported
  })

  it('released while the kit held it (--force): reaching 30 minutes later hands nothing off', () => {
    let clock = 10 * 60_000
    const turns = new AccountTurns({ now: () => clock })
    heldByKit(turns, record('run_1', 'conv_a'))
    expect(turns.release('conv_a', { force: true })).toMatchObject({ released: true, what: 'running', runId: 'run_1' })
    const next = heldByKit(turns, record('run_2', 'conv_a', { startedAt: clock }))
    clock = 31 * 60_000
    expect(turns.handOff('run_1')).toBeNull()
    expect(turns.tracker.holds(next!)).toBe(true)
  })

  it('a run that was let go of records nothing when it ends', async () => {
    const recorded: string[] = []
    const turns = new AccountTurns({ now: () => 45 * 60_000 })
    turns.configure({ recorder: async (rec) => void recorded.push(rec.runId) })
    heldByKit(turns, record('run_1', 'conv_a'))
    turns.handOff('run_1')
    turns.release('conv_a')
    await turns.ended('run_1', { status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    expect(recorded).toEqual([])
  })
})

describe('the release command refuses a young turn without --force', () => {
  it('under 30 minutes: refused, saying a second reply is possible; with force: released', () => {
    const turns = new AccountTurns({ now: () => 12 * 60_000 })
    heldByKit(turns, record('run_1', 'conv_a'))
    const refused = turns.release('conv_a')
    expect(refused.released).toBe(false)
    expect(refused).toMatchObject({ reason: expect.stringMatching(/^the turn for conversation conv_a has run 12 min — under 30 min it is most likely still working, .*two replies.*--force$/) })
    expect(turns.tracker.conversationRunning('conv_a')).toBe(true)
    expect(turns.release('conv_a', { force: true })).toMatchObject({ released: true, what: 'running' })
  })

  it('a kit hold with no run behind it yet follows the same rule', () => {
    const turns = new AccountTurns({ now: () => 0 })
    turns.tracker.begin({ kind: 'reply', conversationId: 'conv_a', anchor: 'msg_1' })
    expect(turns.release('conv_a').released).toBe(false)
    expect(turns.release('conv_a', { force: true })).toMatchObject({ released: true, what: 'running', runId: null })
  })
})

describe('a handed-off turn gets the after-turn rule when it ends', () => {
  it('the recorder runs with the record (the gate card) and the end, while the conversation is still held; then the hold drops and the loop wakes', async () => {
    const turns = new AccountTurns({ now: () => 35 * 60_000 })
    const seen: Array<{ runId: string; status: string; held: boolean; card: string | undefined }> = []
    turns.configure({
      recorder: async (rec, end) => void seen.push({ runId: rec.runId, status: end.status, held: turns.tracker.conversationRunning(rec.id), card: rec.card?.conversation_id }),
    })
    let wakes = 0
    turns.setLive('loop#1', () => void (wakes += 1))
    const gateCard = { conversation_id: 'conv_a' } as never
    heldByKit(turns, record('run_1', 'conv_a', { card: gateCard }))
    turns.handOff('run_1')
    await turns.ended('run_1', { status: 'completed', agentchatCalls: { made: 3, failed: 0 } })
    expect(seen).toEqual([{ runId: 'run_1', status: 'completed', held: true, card: 'conv_a' }])
    expect(turns.tracker.conversationRunning('conv_a')).toBe(false)
    expect(wakes).toBe(2) // the hand-off, then the end
  })

  it('a turn the kit still holds is the kit’s to record: the recorder is not called', async () => {
    const recorded: string[] = []
    const turns = new AccountTurns()
    turns.configure({ recorder: async (rec) => void recorded.push(rec.runId) })
    heldByKit(turns, record('run_1', 'conv_a'))
    await turns.ended('run_1', { status: 'completed', agentchatCalls: null })
    expect(recorded).toEqual([])
  })
})

describe('gate off: the one run a cycle waits on', () => {
  it('handed off after 30 minutes: the cycle is let go of (the run goes on), it counts as hung, its end drops it', async () => {
    const turns = new AccountTurns({ now: () => 31 * 60_000 })
    let letGo = 0
    let wakes = 0
    turns.setLive('loop#1', () => void (wakes += 1))
    turns.started({ runId: 'run_1', kind: 'run', id: 'run_1', anchor: null, sessionKey: 's', startedAt: 0, owner: 'loop#1' }, { letGo: () => void (letGo += 1) })
    expect(turns.handOff('run_1')).toMatchObject({ kind: 'run' })
    expect(letGo).toBe(1)
    expect(turns.hungCount).toBe(1)
    expect(turns.laneGeneration).toBe(1)
    expect(turns.handOff('run_1')).toBeNull()
    expect(overdueTurnLine({ kind: 'run', id: 'run_1', elapsedMs: 31 * 60_000 }, {})).toMatch(/^the gate-off run run_1 has run 31 min — the loop went on without it/)
    await turns.ended('run_1')
    expect(turns.hungCount).toBe(0)
    expect(wakes).toBe(2)
  })

  it('the release command lets go of it by run id (refused under 30 minutes without --force)', () => {
    const turns = new AccountTurns({ now: () => 5 * 60_000 })
    let letGo = 0
    turns.started({ runId: 'run_1', kind: 'run', id: 'run_1', anchor: null, sessionKey: 's', startedAt: 0, owner: 'loop#1' }, { letGo: () => void (letGo += 1) })
    expect(turns.release('run_1').released).toBe(false)
    expect(turns.release('run_1', { force: true })).toMatchObject({ released: true, what: 'running', key: 'run:run_1', runId: 'run_1' })
    expect(letGo).toBe(1)
  })
})

describe('lookups never create account state', () => {
  it('findAccountTurns is undefined for an account with no turns; accountTurns creates', () => {
    expect(findAccountTurns('nobody')).toBeUndefined()
    accountTurns('somebody')
    expect(findAccountTurns('somebody')).toBe(accountTurns('somebody'))
    expect(accountsWithTurns()).toEqual(['somebody'])
  })
})
