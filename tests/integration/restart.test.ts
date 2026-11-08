/**
 * The restart defense. A gateway restart ends every run with the process,
 * and OpenClaw (main) may continue a plugin's turn session afterwards (the
 * restart resume asks the agent's main session to "send a fresh instruction
 * to the same retained child session"). So the turns in flight are written
 * to `<state>/agentchat/<account>/turns.json`; the next start holds their
 * conversations before the first gate, applies the after-turn rule to what
 * the ended run did, and keeps the hold while a run OpenClaw started in that
 * turn's session (seen at its first model call) is going.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { integration } from 'agentchatme'

import { registerRunObserver } from '../../src/binding/run-observer.js'
import { AccountTurns, RESTART_HOLD_MS, accountTurns, resetRunningTurnsForTest, restartHoldLines, type RunRecord } from '../../src/integration/running.js'
import { KEEP_ENDED_MS, TurnStore, storedCard, type StoredTurn } from '../../src/integration/turn-store.js'
import { card } from '../helpers/fake-client.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-openclaw-restart-'))
})

afterEach(() => {
  vi.useRealTimers()
  resetRunningTurnsForTest()
  fs.rmSync(dir, { recursive: true, force: true })
})

function reply(runId: string, id: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    kind: 'reply',
    id,
    anchor: `msg_${id}`,
    sessionKey: `agent:main:subagent:agentchat-wake-${runId}`,
    startedAt: 1_000,
    owner: 'loop#1',
    card: card(id, `msg_${id}`, { preview: { message_id: `msg_${id}`, sender: '@bob', text: 'a private message body', at: '2026-11-08T00:00:00.000Z' } }),
    category: null,
    ...extra,
  }
}

function stored(runId: string, id: string): StoredTurn {
  return {
    runId,
    kind: 'reply',
    id,
    anchor: `msg_${id}`,
    sessionKey: `agent:main:subagent:agentchat-wake-${runId}`,
    startedAt: 1_000,
    category: null,
    card: { conversation_id: id, last_message_id: `msg_${id}`, your_last_message_at: null, you_owe_reply: true, your_last_decision: null },
  }
}

describe('the store', () => {
  it('round-trips the turns in flight; a damaged or foreign file reads as empty; an empty write removes the file', () => {
    const store = new TurnStore('default', dir)
    expect(store.file).toBe(path.join(dir, 'agentchat', 'default', 'turns.json'))
    expect(store.load()).toEqual([])
    expect(store.write([stored('run_1', 'conv_a')])).toBe(true)
    expect(store.load()).toEqual([stored('run_1', 'conv_a')])
    fs.writeFileSync(store.file, '{ not json')
    expect(store.load()).toEqual([])
    fs.writeFileSync(store.file, JSON.stringify({ version: 2, turns: [stored('run_1', 'conv_a')] }))
    expect(store.load()).toEqual([])
    expect(store.write([])).toBe(true)
    expect(fs.existsSync(store.file)).toBe(false)
  })

  it('keeps the card fields the after-turn rule compares, never message text', () => {
    const kept = storedCard(reply('run_1', 'conv_a').card!, 'msg_conv_a')
    expect(Object.keys(kept).sort()).toEqual(['conversation_id', 'last_message_id', 'you_owe_reply', 'your_last_decision', 'your_last_message_at'])
    expect(JSON.stringify(kept)).not.toContain('private message body')
  })
})

describe('what is written while turns run', () => {
  it('a started turn is written; an ended one stays KEEP_ENDED_MS (a restart ends the run before the process), then goes', async () => {
    vi.useFakeTimers()
    const store = new TurnStore('default', dir)
    const turns = new AccountTurns()
    turns.configure({ store })
    turns.tracker.begin({ kind: 'reply', conversationId: 'conv_a', anchor: 'msg_conv_a' })
    turns.started(reply('run_1', 'conv_a'))
    expect(store.load().map((t) => t.runId)).toEqual(['run_1'])
    expect(JSON.stringify(store.load())).not.toContain('private message body')
    await turns.ended('run_1', { status: 'completed', agentchatCalls: null })
    expect(store.load().map((t) => t.runId)).toEqual(['run_1'])
    vi.advanceTimersByTime(KEEP_ENDED_MS)
    expect(store.load()).toEqual([])
  })

  it('a turn let go of, and a gate-off run, are not written', () => {
    const store = new TurnStore('default', dir)
    const turns = new AccountTurns({ now: () => 40 * 60_000 })
    turns.configure({ store })
    turns.tracker.begin({ kind: 'reply', conversationId: 'conv_a', anchor: 'msg_conv_a' })
    turns.started(reply('run_1', 'conv_a'))
    turns.started({ runId: 'run_2', kind: 'run', id: 'run_2', anchor: null, sessionKey: 's', startedAt: 0, owner: 'loop#1' })
    expect(store.load().map((t) => t.runId)).toEqual(['run_1'])
    turns.release('conv_a')
    expect(store.load()).toEqual([])
  })
})

describe('the next start adopts what the last process left', () => {
  function adopting(store: TurnStore, wiring: Partial<Parameters<AccountTurns['configure']>[0]> = {}) {
    const recorded: Array<{ runId: string; end: integration.TurnEnd }> = []
    const turns = new AccountTurns()
    let wakes = 0
    turns.setLive('loop#1', () => void (wakes += 1))
    turns.configure({
      store,
      recorder: async (rec, end) => void recorded.push({ runId: rec.runId, end }),
      readCalls: async () => ({ made: 2, failed: 0 }),
      ...wiring,
    })
    return { turns, recorded, wakes: () => wakes }
  }

  it('held before the first gate; the ended run gets the after-turn rule (failed: an answer it sent records reply); after RESTART_HOLD_MS with nothing continuing it, gated again', async () => {
    vi.useFakeTimers()
    const store = new TurnStore('default', dir)
    store.write([stored('run_old', 'conv_a')])
    const { turns, recorded, wakes } = adopting(store)
    expect(turns.adopt().map((r) => r.id)).toEqual(['conv_a'])
    expect(turns.tracker.conversationRunning('conv_a')).toBe(true)
    expect(restartHoldLines(turns, Date.now())).toEqual([
      'conversation conv_a is held for 3 more min: its turn was running when the gateway restarted, and OpenClaw may continue that turn\'s session',
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(recorded).toEqual([{ runId: 'run_old', end: { status: 'failed', agentchatCalls: { made: 2, failed: 0 }, detail: 'the gateway restarted during the turn' } }])
    expect(store.load().map((t) => t.runId)).toEqual(['run_old']) // still in flight for a restart during the hold
    await vi.advanceTimersByTimeAsync(RESTART_HOLD_MS)
    expect(turns.tracker.conversationRunning('conv_a')).toBe(false)
    expect(wakes()).toBe(1)
    expect(store.load()).toEqual([])
  })

  it('a run OpenClaw starts in that turn’s session keeps the hold past RESTART_HOLD_MS until it ends, then gets the after-turn rule', async () => {
    vi.useFakeTimers()
    const store = new TurnStore('default', dir)
    store.write([stored('run_old', 'conv_a')])
    let finish!: (end: integration.TurnEnd | null) => void
    const watched: Array<{ runId: string; sessionKey: string }> = []
    const { turns, recorded, wakes } = adopting(store, {
      watch: (rec) => {
        watched.push({ runId: rec.runId, sessionKey: rec.sessionKey })
        return new Promise((resolve) => (finish = resolve))
      },
    })
    turns.adopt()
    await vi.advanceTimersByTimeAsync(0)
    turns.observeRun('run_resumed', 'agent:main:subagent:agentchat-wake-run_old')
    turns.observeRun('run_resumed', 'agent:main:subagent:agentchat-wake-run_old') // every model call reports it: watched once
    expect(watched).toEqual([{ runId: 'run_resumed', sessionKey: 'agent:main:subagent:agentchat-wake-run_old' }])
    expect(restartHoldLines(turns)[0]).toMatch(/OpenClaw continued its turn's session after the gateway restart \(run run_resumed\)/)
    await vi.advanceTimersByTimeAsync(RESTART_HOLD_MS * 2)
    expect(turns.tracker.conversationRunning('conv_a')).toBe(true)
    finish({ status: 'completed', agentchatCalls: { made: 4, failed: 0 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(recorded.map((r) => r.runId)).toEqual(['run_old', 'run_resumed'])
    expect(recorded[1]!.end).toEqual({ status: 'completed', agentchatCalls: { made: 4, failed: 0 } })
    expect(turns.tracker.conversationRunning('conv_a')).toBe(false)
    expect(wakes()).toBe(1)
  })

  it('runs in other sessions, and runs this process started, are not taken for a continued turn', async () => {
    const store = new TurnStore('default', dir)
    store.write([stored('run_old', 'conv_a')])
    const watched: string[] = []
    const { turns } = adopting(store, { watch: async (rec) => (watched.push(rec.runId), null) })
    turns.adopt()
    turns.tracker.begin({ kind: 'reply', conversationId: 'conv_b', anchor: 'msg_conv_b' })
    turns.started(reply('run_mine', 'conv_b', { sessionKey: 'agent:main:subagent:agentchat-wake-run_old' }))
    turns.observeRun('run_mine', 'agent:main:subagent:agentchat-wake-run_old')
    turns.observeRun('run_other', 'agent:main:main')
    turns.observeRun('run_other', undefined)
    expect(watched).toEqual([])
  })

  it('an account restart in the same process adopts nothing: those runs are still watched here', () => {
    const store = new TurnStore('default', dir)
    const turns = new AccountTurns()
    turns.configure({ store })
    turns.tracker.begin({ kind: 'reply', conversationId: 'conv_a', anchor: 'msg_conv_a' })
    turns.started(reply('run_1', 'conv_a'))
    expect(turns.adopt()).toEqual([])
    expect(turns.restartHolds()).toEqual([])
  })

  it('the release command lets go of a restart hold', () => {
    const store = new TurnStore('default', dir)
    store.write([stored('run_old', 'conv_a')])
    const { turns } = adopting(store)
    turns.adopt()
    expect(turns.release('conv_a')).toEqual({ released: true, what: 'restart', key: 'conversation:conv_a', runId: null })
    expect(turns.tracker.conversationRunning('conv_a')).toBe(false)
    expect(store.load()).toEqual([])
  })
})

describe('the model_call_started hook', () => {
  it('is registered and feeds every account’s adopted turns (the event’s session key, else the context’s)', () => {
    const store = new TurnStore('default', dir)
    store.write([stored('run_old', 'conv_a')])
    const turns = accountTurns('default')
    const watched: string[] = []
    turns.configure({ store, watch: async (rec) => (watched.push(rec.runId), null) })
    turns.adopt()
    const hooks: Array<{ name: string; handler: (event: unknown, ctx: unknown) => void }> = []
    registerRunObserver({ on: ((name: string, handler: never) => hooks.push({ name, handler })) as never })
    expect(hooks.map((h) => h.name)).toEqual(['model_call_started'])
    hooks[0]!.handler({ runId: 'run_resumed', callId: 'c1', provider: 'p', model: 'm' }, { sessionKey: 'agent:main:subagent:agentchat-wake-run_old' })
    expect(watched).toEqual(['run_resumed'])
  })
})
