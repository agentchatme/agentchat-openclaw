/**
 * The invoker: wake → tray → the SDK gate → one turn per reply.
 *
 * The SDK's gate helper runs for real (prompt rendering, parsing, verdict
 * recording) against a fake client; the model and OpenClaw's runtime are
 * injected. What is asserted: one subagent run per conversation decided
 * reply, the reply verdict recorded only once that run is admitted, all
 * three verdicts on the wire, fail-closed as one log line and no turn, the
 * retry ladder, and invites that survive a refused turn and a restart.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { AgentInvoker } from '../../src/integration/invoker.js'
import { InviteLedger } from '../../src/integration/invites.js'
import type { TurnReadiness, TurnRequest, TurnStarter } from '../../src/integration/model.js'
import type { MetricsRecorder } from '../../src/metrics.js'
import { Clock } from '../helpers/clock.js'
import { capturingLogger } from '../helpers/logger.js'
import { card, fakeClient, tray, type FakeClientOptions } from '../helpers/fake-client.js'
import { SPELLED_TEXTS, staticTexts } from '../helpers/texts.js'

const CONVERSATION_IN_PROMPT = /Conversation to answer in this turn: (\S+)\./

function decisions(...entries: Array<[string, string, string?]>): string {
  return JSON.stringify({
    decisions: entries.map(([conversation_id, decision, category]) => ({ conversation_id, decision, ...(category ? { category } : {}) })),
  })
}

interface MakeOptions extends Omit<FakeClientOptions, 'texts'> {
  /** The gate model's answer; a function receives the rendered prompt (the cards it was shown). */
  answer?: string | ((prompt: string) => Promise<string>)
  texts?: ReturnType<typeof staticTexts>
  startTurn?: TurnStarter
  readiness?: () => TurnReadiness
  gateEnabled?: boolean
  stateDir?: string
}

function make(opts: MakeOptions) {
  const clock = new Clock()
  const { client, posts, trayCalls } = fakeClient({ trays: opts.trays, invites: opts.invites, rejectRecords: opts.rejectRecords })
  const events: string[] = []
  const recordRaw = client.decisions.record
  client.decisions.record = async (conversationId, body) => {
    events.push(`record:${conversationId}:${body.decision}`)
    return recordRaw(conversationId, body)
  }
  const texts = opts.texts ?? staticTexts()
  const stateDir = opts.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-invoker-'))
  const invites = new InviteLedger({ accountId: 'default', stateDir })
  const turns: TurnRequest[] = []
  let modelCalls = 0
  const callModel = async (prompt: string): Promise<string> => {
    modelCalls += 1
    const answer = opts.answer ?? decisions()
    return typeof answer === 'string' ? answer : answer(prompt)
  }
  const startTurn: TurnStarter =
    opts.startTurn ??
    (async (req) => {
      turns.push(req)
      events.push(`start:${CONVERSATION_IN_PROMPT.exec(req.prompt)?.[1] ?? 'none'}`)
      return { ran: true, runId: `run_${turns.length}`, done: Promise.resolve({ ran: true, runId: `run_${turns.length}`, status: 'ok' }) }
    })
  const logger = capturingLogger()
  const wakeSources: string[] = []
  const metrics: MetricsRecorder = {
    incWake: ({ source }) => void wakeSources.push(source),
    incDisconnect: () => undefined,
    incError: () => undefined,
    setConnectionState: () => undefined,
  }
  const invoker = new AgentInvoker({
    accountId: 'default',
    agentId: 'main',
    client,
    callModel,
    startTurn,
    texts,
    invites,
    logger,
    metrics,
    ...(opts.readiness ? { readiness: opts.readiness } : {}),
    gateEnabled: opts.gateEnabled,
    debounceMs: 2000,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  const settle = async () => {
    for (let i = 0; i < 20; i++) await invoker.settled()
  }
  return { clock, client, posts, trayCalls, events, texts, invites, stateDir, turns, invoker, logger, settle, wakeSources, modelCalls: () => modelCalls }
}

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('AgentInvoker — wake → tray → gate → one turn per reply', () => {
  it('a burst of wakes is one cycle; every reply is its own turn with the served instruction and its conversation id; all three verdicts are recorded, reply only once its turn completed', async () => {
    const t = make({
      trays: [tray([card('conv_a', 'msg_a'), card('conv_b', 'msg_b'), card('conv_c', 'msg_c'), card('conv_d', 'msg_d')])],
      answer: decisions(['conv_a', 'reply', 'open_request'], ['conv_b', 'dismiss', 'closing'], ['conv_c', 'defer'], ['conv_d', 'reply']),
    })
    tmpDirs.push(t.stateDir)
    for (let i = 0; i < 5; i++) t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()

    expect(t.trayCalls()).toBe(1)
    expect(t.invoker.cycles).toBe(1)
    expect(t.turns).toHaveLength(2)
    expect(t.turns.map((r) => CONVERSATION_IN_PROMPT.exec(r.prompt)?.[1])).toEqual(['conv_a', 'conv_d'])
    for (const turn of t.turns) {
      expect(turn.prompt.startsWith(SPELLED_TEXTS.wake_instruction)).toBe(true)
      expect(turn.prompt).toContain('agentchat__agentchat_get_conversation')
      expect(turn.sessionKey).toMatch(/^agent:main:subagent:agentchat-wake-/)
      expect(turn.lane).toBe('agentchat-integration:default')
    }
    // dismiss and defer are recorded by the gate at once; reply after each turn COMPLETED (the fake turn completes at once).
    expect(t.posts).toEqual([
      { conversationId: 'conv_b', body: { decision: 'dismiss', category: 'closing', through_message_id: 'msg_b' } },
      { conversationId: 'conv_c', body: { decision: 'defer', through_message_id: 'msg_c' } },
      { conversationId: 'conv_a', body: { decision: 'reply', category: 'open_request', through_message_id: 'msg_a' } },
      { conversationId: 'conv_d', body: { decision: 'reply', through_message_id: 'msg_d' } },
    ])
    expect(t.events.indexOf('start:conv_a')).toBeLessThan(t.events.indexOf('record:conv_a:reply'))
    expect(t.events.indexOf('start:conv_d')).toBeLessThan(t.events.indexOf('record:conv_d:reply'))
    expect(t.invoker.counters()).toMatchObject({ wakes: 5, absorbed: 4, turns: 2, retryRung: 0 })
    const gateLine = t.logger.at('info').find((l) => l.msg === 'gate')
    // `recorded` counts the gate's own records (dismiss, defer); the reply verdicts land as the turns complete.
    expect(gateLine?.obj).toMatchObject({ cards: 4, reply: 2, dismiss: 1, defer: 1, undecided: 0, recorded: 2, recordFailures: 0, turnsStarted: 2, turnsRefused: 0 })
    expect(t.logger.at('info').filter((l) => l.msg === 'reply verdict recorded — turn completed').map((l) => l.obj.conversationId)).toEqual(['conv_a', 'conv_d'])
  })

  it('a turn OpenClaw refuses records no reply verdict: the conversation stays unread, the ladder re-wakes, and the next cycle gates it again', async () => {
    let admit = false
    const turns: TurnRequest[] = []
    const t = make({
      trays: [tray([card('conv_a', 'msg_a')])],
      answer: decisions(['conv_a', 'reply']),
      startTurn: async (req) => {
        if (!admit) return { ran: false, error: 'runtime unavailable' }
        turns.push(req)
        return { ran: true, runId: 'run_2', done: Promise.resolve({ ran: true, runId: 'run_2', status: 'ok' }) }
      },
    })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.posts).toEqual([]) // no reply recorded for a turn that never started
    expect(t.invoker.turns).toBe(0)
    expect(t.invoker.counters().retryRung).toBe(1)
    expect(t.logger.at('warn').some((l) => /turn not started — reply not recorded/.test(l.msg ?? ''))).toBe(true)

    admit = true
    t.clock.advance(60_000 + 2000)
    await t.settle()
    expect(t.trayCalls()).toBe(2)
    expect(t.modelCalls()).toBe(2) // one extra gate call, no silent drop
    expect(turns).toHaveLength(1)
    expect(t.posts).toEqual([{ conversationId: 'conv_a', body: { decision: 'reply', through_message_id: 'msg_a' } }])
    expect(t.invoker.counters().retryRung).toBe(0)
  })

  it('gate off: one turn with the plain served instruction, nothing recorded here', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a'), card('conv_b', 'msg_b')])], gateEnabled: false })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.turns).toHaveLength(1)
    expect(t.turns[0]!.prompt).toBe(SPELLED_TEXTS.wake_instruction)
    expect(t.posts).toHaveLength(0)
    expect(t.modelCalls()).toBe(0)
  })

  it('an empty tray decides nothing and resets the ladder', async () => {
    const t = make({ trays: [tray([])] })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('connect')
    t.clock.advance(2000)
    await t.settle()
    expect(t.turns).toHaveLength(0)
    expect(t.modelCalls()).toBe(0)
    expect(t.invoker.counters().retryRung).toBe(0)
  })

  it('a wake landing during a cycle earns one more cycle (tray re-read)', async () => {
    let release!: () => void
    const answer = new Promise<string>((resolve) => {
      release = () => resolve(decisions(['conv_a', 'dismiss']))
    })
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: () => answer })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000) // the cycle is in flight, parked on the model
    t.invoker.wake('message') // mid-cycle
    t.clock.advance(2000)
    release()
    await t.settle()
    expect(t.trayCalls()).toBe(2)
  })

  it('a cycle ends when its turns are admitted, not when they finish: the next wake is serviced while a turn still runs', async () => {
    let finish!: () => void
    const done = new Promise<{ ran: true; runId: string; status: string }>((resolve) => {
      finish = () => resolve({ ran: true, runId: 'run_slow', status: 'ok' })
    })
    const t = make({
      trays: [tray([card('conv_a', 'msg_a')]), tray([card('conv_b', 'msg_b')])],
      answer: async () => decisions(['conv_a', 'reply'], ['conv_b', 'reply']),
      startTurn: async () => ({ ran: true, runId: 'run_slow', done }),
    })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.invoker.cycles).toBe(1)
    expect(t.invoker.counters().turnsInFlight).toBe(1)
    expect(t.posts).toEqual([]) // the reply verdict waits for the turn to complete; the card is still on the tray

    // The first turn has not ended; a second wake still gets its cycle (and its own turn, queued on the lane).
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.invoker.cycles).toBe(2)
    expect(t.invoker.counters().turnsInFlight).toBe(2)
    expect(t.posts).toEqual([])

    finish()
    await t.settle()
    expect(t.invoker.counters().turnsInFlight).toBe(0)
    expect(t.logger.at('info').filter((l) => /^turn complete/.test(l.msg ?? ''))).toHaveLength(2)
    // Both turns completed: both reply verdicts recorded, in completion order.
    expect(t.posts.map((p) => `${p.conversationId}:${p.body.decision}`)).toEqual(['conv_a:reply', 'conv_b:reply'])
  })

  it('a truncated tray wakes again for the rest', async () => {
    const t = make({
      trays: [tray([card('conv_a', 'msg_a')], { truncated: true }), tray([])],
      answer: decisions(['conv_a', 'dismiss']),
    })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.trayCalls()).toBe(1)
    t.clock.advance(2000)
    await t.settle()
    expect(t.trayCalls()).toBe(2)
  })
})

describe('AgentInvoker — failure policy and the ladder', () => {
  it('fail closed: the model is down → nothing recorded, no turn, exactly ONE warn line per cycle; one outage climbs one rung; recovery resets', async () => {
    let healthy = false
    const t = make({
      trays: [tray([card('conv_a', 'msg_a')])],
      answer: async () => {
        if (!healthy) throw new Error('provider down')
        return decisions(['conv_a', 'reply'])
      },
    })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.turns).toHaveLength(0)
    expect(t.posts).toHaveLength(0)
    expect(t.logger.at('warn')).toHaveLength(1)
    expect(t.logger.at('warn')[0]!.msg).toMatch(/gate failed closed — nothing recorded, no turn started/)
    expect(t.logger.at('warn')[0]!.obj).toMatchObject({ failure: expect.stringMatching(/provider down/), retry: { kind: 'armed', delayMs: 60_000, rung: 1 } })
    expect(t.invoker.counters().retryRung).toBe(1)

    // A second wake mid-outage fails again (one more line) but must NOT climb
    // the ladder: the 60 s re-wake is already on its way.
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.invoker.counters().retryRung).toBe(1)
    expect(t.logger.at('warn')).toHaveLength(2)
    expect(t.logger.at('warn')[1]!.obj).toMatchObject({ retry: { kind: 'pending' } })

    healthy = true
    t.clock.advance(60_000 + 2000)
    await t.settle()
    expect(t.turns).toHaveLength(1)
    expect(t.invoker.counters().retryRung).toBe(0)
    // The ladder's re-wake is counted as its own wake source.
    expect(t.wakeSources).toEqual(['retry'])
  })

  it('an unusable answer fails closed the same way', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: 'I would rather not say' })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.turns).toHaveLength(0)
    expect(t.posts).toHaveLength(0)
    expect(t.logger.at('warn')).toHaveLength(1)
    expect(t.logger.at('warn')[0]!.obj).toMatchObject({ failure: 'no usable verdicts in the answer' })
  })

  it('served texts missing: nothing is gated (no model call), the cards wait, the ladder re-wakes; the next cycle proceeds once the texts are there', async () => {
    const texts = staticTexts(null)
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: decisions(['conv_a', 'reply']), texts })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.modelCalls()).toBe(0)
    expect(t.turns).toHaveLength(0)
    expect(t.posts).toHaveLength(0)
    expect(texts.ensures).toBe(1)
    expect(t.logger.at('warn')[0]!.msg).toMatch(/served texts not available — not gating/)
    expect(t.invoker.counters().retryRung).toBe(1)

    texts.set(SPELLED_TEXTS)
    t.clock.advance(60_000 + 2000)
    await t.settle()
    expect(t.modelCalls()).toBe(1)
    expect(t.turns).toHaveLength(1)
  })

  it('tray read failure → re-wake on the ladder, then exhausted after the last rung', async () => {
    const t = make({ trays: [new Error('ECONNRESET')] })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.invoker.counters().retryRung).toBe(1)
    t.clock.advance(60_000 + 2000)
    await t.settle()
    expect(t.invoker.counters().retryRung).toBe(2)
    t.clock.advance(300_000 + 2000)
    await t.settle()
    expect(t.invoker.counters().retryRung).toBe(3)
    t.clock.advance(1_800_000 + 2000)
    await t.settle()
    expect(t.trayCalls()).toBe(4)
    // Ladder exhausted: nothing more is scheduled until the next wake.
    expect(t.clock.pending).toHaveLength(0)
    expect(t.logger.at('warn').at(-1)!.obj).toMatchObject({ retry: { kind: 'exhausted' } })
  })

  it('a dismiss the server refuses is a record failure: the card is left on the tray and the cycle re-wakes', async () => {
    const t = make({
      trays: [tray([card('conv_a', 'msg_a'), card('conv_b', 'msg_b')])],
      answer: decisions(['conv_a', 'reply'], ['conv_b', 'dismiss']),
      rejectRecords: new Set(['conv_b']),
    })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.turns).toHaveLength(1) // the reply still runs
    expect(t.posts.map((p) => `${p.conversationId}:${p.body.decision}`)).toEqual(['conv_a:reply'])
    expect(t.invoker.counters().retryRung).toBe(1)
    expect(t.logger.at('warn').some((l) => /cards left on the tray/.test(l.msg ?? ''))).toBe(true)
  })

  it('a reply verdict the server refuses after the turn completed is logged and the ladder re-wakes', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: decisions(['conv_a', 'reply']), rejectRecords: new Set(['conv_a']) })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.turns).toHaveLength(1)
    expect(t.logger.at('warn').some((l) => /reply verdict not recorded after the turn completed/.test(l.msg ?? ''))).toBe(true)
    expect(t.invoker.counters().retryRung).toBe(1)
  })

  it('a turn that ends in error records no reply verdict: the card stays on the tray, the ladder re-wakes, and a later completed turn records it', async () => {
    let outcome: { status: string; error?: string } = { status: 'error', error: 'model crashed' }
    const t = make({
      trays: [tray([card('conv_a', 'msg_a')])],
      answer: decisions(['conv_a', 'reply']),
      startTurn: async () => ({ ran: true, runId: 'run_x', done: Promise.resolve({ ran: true, runId: 'run_x', ...outcome }) }),
    })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.posts).toEqual([])
    expect(t.invoker.turns).toBe(1)
    expect(t.invoker.counters().retryRung).toBe(1)
    const notRecorded = t.logger.at('warn').find((l) => l.msg === 'turn did not complete — reply not recorded; the conversation stays unread and is gated again')
    expect(notRecorded?.obj).toMatchObject({ conversationId: 'conv_a', status: 'error', error: 'model crashed', retry: { kind: 'armed', rung: 1 } })

    // The ladder's wake: the card is still there, the gate decides again, this turn completes, the verdict is recorded.
    outcome = { status: 'ok' }
    t.clock.advance(60_000 + 2000)
    await t.settle()
    expect(t.trayCalls()).toBe(2)
    expect(t.modelCalls()).toBe(2)
    expect(t.posts).toEqual([{ conversationId: 'conv_a', body: { decision: 'reply', through_message_id: 'msg_a' } }])
    expect(t.invoker.counters().retryRung).toBe(0)
  })

  it('a conversation whose reply turn is still running is left out of later cycles: one turn, one record; a newer message after the turn ends gets a new turn', async () => {
    let finish!: () => void
    const firstDone = new Promise<{ ran: true; runId: string; status: string }>((resolve) => {
      finish = () => resolve({ ran: true, runId: 'run_1', status: 'ok' })
    })
    const started: string[] = []
    const t = make({
      // The same unread card while the turn runs (its verdict is not recorded yet), then a newer message once it ended.
      trays: [tray([card('conv_a', 'msg_a')]), tray([card('conv_a', 'msg_a'), card('conv_b', 'msg_b')]), tray([card('conv_a', 'msg_2')])],
      // Like a real model, answers only for the cards it was shown.
      answer: async (prompt) =>
        decisions(...([['conv_a', 'reply'], ['conv_b', 'dismiss']] as Array<[string, string]>).filter(([id]) => prompt.includes(`"conversation_id": "${id}"`) || prompt.includes(`"conversation_id":"${id}"`))),
      startTurn: async (req) => {
        const id = CONVERSATION_IN_PROMPT.exec(req.prompt)?.[1] ?? 'none'
        started.push(id)
        return started.length === 1
          ? { ran: true, runId: 'run_1', done: firstDone }
          : { ran: true, runId: `run_${started.length}`, done: Promise.resolve({ ran: true, runId: `run_${started.length}`, status: 'ok' }) }
      },
    })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(started).toEqual(['conv_a'])
    expect(t.posts).toEqual([])

    // Another conversation's message lands mid-turn: its card is gated, conv_a's is not — no second turn, no second gate question about it.
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.invoker.cycles).toBe(2)
    expect(started).toEqual(['conv_a'])
    expect(t.posts.map((p) => `${p.conversationId}:${p.body.decision}`)).toEqual(['conv_b:dismiss'])
    expect(t.logger.at('info').filter((l) => l.msg === 'gate').at(-1)?.obj).toMatchObject({ cards: 1, reply: 0, dismiss: 1, skippedInFlight: 1 })

    // The turn ends: its verdict is recorded once, and the tray is read again for what was left out — a newer message for conv_a gets a new turn.
    finish()
    await t.settle()
    expect(t.posts.map((p) => `${p.conversationId}:${p.body.decision}:${p.body.through_message_id}`)).toEqual(['conv_b:dismiss:msg_b', 'conv_a:reply:msg_a'])
    t.clock.advance(2000)
    await t.settle()
    expect(t.invoker.cycles).toBe(3)
    expect(started).toEqual(['conv_a', 'conv_a'])
    expect(t.posts.map((p) => `${p.conversationId}:${p.body.decision}:${p.body.through_message_id}`)).toEqual(['conv_b:dismiss:msg_b', 'conv_a:reply:msg_a', 'conv_a:reply:msg_2'])
    expect(t.invoker.counters().turnsInFlight).toBe(0)
  })

  it('a tray holding only in-flight cards is nothing to decide: no gate call, no turn, and no re-read until the turn ends', async () => {
    let finish!: () => void
    const done = new Promise<{ ran: true; runId: string; status: string }>((resolve) => {
      finish = () => resolve({ ran: true, runId: 'run_1', status: 'ok' })
    })
    const t = make({
      trays: [tray([card('conv_a', 'msg_a')]), tray([card('conv_a', 'msg_a')]), tray([])],
      answer: async () => decisions(['conv_a', 'reply']),
      startTurn: async () => ({ ran: true, runId: 'run_1', done }),
    })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('message')
    t.clock.advance(2000)
    await t.settle()
    expect(t.modelCalls()).toBe(1)

    t.invoker.wake('connect') // a reconnect mid-turn
    t.clock.advance(2000)
    await t.settle()
    expect(t.invoker.cycles).toBe(2)
    expect(t.modelCalls()).toBe(1)
    expect(t.invoker.turns).toBe(1)
    expect(t.logger.at('info').some((l) => l.msg === 'every card on the tray has a reply turn running — nothing new to decide')).toBe(true)
    expect(t.clock.pending).toHaveLength(0) // nothing re-armed while the turn runs

    finish()
    await t.settle()
    expect(t.posts.map((p) => `${p.conversationId}:${p.body.decision}`)).toEqual(['conv_a:reply'])
    t.clock.advance(2000)
    await t.settle()
    expect(t.invoker.cycles).toBe(3) // the re-read: the tray is empty now
    expect(t.trayCalls()).toBe(3)
  })

  it('nothing is gated while a turn cannot have the hosted tools: no model call, no turn, the cards wait, the ladder re-wakes, the reason is logged once until it changes', async () => {
    let reason: string | null = 'mcp.servers.agentchat is not in the gateway config'
    const t = make({
      trays: [tray([card('conv_a', 'msg_a')])],
      answer: decisions(['conv_a', 'reply']),
      readiness: () => (reason ? { ready: false, reason } : { ready: true }),
    })
    tmpDirs.push(t.stateDir)
    t.invoker.wake('connect')
    t.clock.advance(2000)
    await t.settle()
    expect(t.modelCalls()).toBe(0)
    expect(t.turns).toHaveLength(0)
    expect(t.posts).toEqual([])
    const unready = () => t.logger.at('warn').filter((l) => l.msg === 'AgentChat tools not available to a turn — not gating; the cards wait on the tray')
    expect(unready()).toHaveLength(1)
    expect(unready()[0]!.obj).toMatchObject({ cards: 1, reason, retry: { kind: 'armed', rung: 1, delayMs: 60_000 } })

    // The ladder's rung, same reason: a debug line, still no gate call, the next rung armed.
    t.clock.advance(60_000 + 2000)
    await t.settle()
    expect(t.trayCalls()).toBe(2)
    expect(t.modelCalls()).toBe(0)
    expect(unready()).toHaveLength(1)
    expect(t.logger.at('debug').some((l) => l.msg === 'AgentChat tools not available to a turn — not gating; the cards wait on the tray')).toBe(true)
    expect(t.invoker.counters().retryRung).toBe(2)

    // A different reason is a new line.
    reason = 'AGENTCHAT_API_KEY is not set in the gateway process'
    t.clock.advance(300_000 + 2000)
    await t.settle()
    expect(unready()).toHaveLength(2)

    // doctor --fix landed (live config): the next rung gates and runs the turn; the verdict is recorded on completion.
    reason = null
    t.clock.advance(1_800_000 + 2000)
    await t.settle()
    expect(t.modelCalls()).toBe(1)
    expect(t.turns).toHaveLength(1)
    expect(t.posts).toEqual([{ conversationId: 'conv_a', body: { decision: 'reply', through_message_id: 'msg_a' } }])
    expect(t.logger.at('info').some((l) => l.msg === 'AgentChat tools available to turns again')).toBe(true)
    expect(t.invoker.counters().retryRung).toBe(0)
  })

  it('a turn that hits the wait timeout, or whose wait failed, records nothing either', async () => {
    for (const outcome of [{ status: 'timeout' }, { status: 'unknown', error: 'wait failed' }]) {
      const t = make({
        trays: [tray([card('conv_a', 'msg_a')])],
        answer: decisions(['conv_a', 'reply']),
        startTurn: async () => ({ ran: true, runId: 'run_t', done: Promise.resolve({ ran: true, runId: 'run_t', ...outcome }) }),
      })
      tmpDirs.push(t.stateDir)
      t.invoker.wake('message')
      t.clock.advance(2000)
      await t.settle()
      expect(t.posts).toEqual([])
      expect(t.invoker.counters().retryRung).toBe(1)
      expect(t.logger.at('warn').some((l) => l.msg?.startsWith('turn did not complete — reply not recorded'))).toBe(true)
      t.invoker.stop()
    }
  })
})

describe('AgentInvoker — group invites', () => {
  const invite = { inviteId: 'inv_1', groupId: 'grp_1', groupName: 'Ops', inviterHandle: 'bob' }

  it('an invite is one turn with the served invite prompt, deduplicated by id, not gated, and remembered in the ledger', async () => {
    const t = make({ trays: [tray([])] })
    tmpDirs.push(t.stateDir)
    expect(t.invoker.groupInvite(invite, 'live')).toBe(true)
    expect(t.invoker.groupInvite(invite, 'catch-up')).toBe(false)
    await t.settle()
    expect(t.turns).toHaveLength(1)
    expect(t.turns[0]!.prompt).toBe(SPELLED_TEXTS.invite_prompt)
    expect(t.turns[0]!.sessionKey).toBe('agent:main:subagent:agentchat-invite-inv_1')
    expect(t.invoker.inviteTurns).toBe(1)
    expect(t.trayCalls()).toBe(0)
    expect(t.modelCalls()).toBe(0)
    expect(t.invites.isOffered('inv_1')).toBe(true)
    // Seen again later (another connect) → nothing.
    expect(t.invoker.groupInvite(invite, 'catch-up')).toBe(false)
  })

  it('an invite whose turn OpenClaw refused stays pending, is not marked offered, and is retried on the next wake', async () => {
    let admit = false
    const turns: TurnRequest[] = []
    const t = make({
      trays: [tray([])],
      startTurn: async (req) => {
        if (!admit) return { ran: false, error: 'runtime unavailable' }
        turns.push(req)
        return { ran: true, runId: 'run_i', done: Promise.resolve({ ran: true, runId: 'run_i', status: 'ok' }) }
      },
    })
    tmpDirs.push(t.stateDir)
    expect(t.invoker.groupInvite(invite, 'live')).toBe(true)
    await t.settle()
    expect(turns).toHaveLength(0)
    expect(t.invites.isOffered('inv_1')).toBe(false)
    expect(t.invoker.counters().pendingInvites).toBe(1)
    expect(t.invoker.counters().retryRung).toBe(1)
    expect(t.logger.at('warn').some((l) => /group-invite turn not started — the invite stays pending/.test(l.msg ?? ''))).toBe(true)
    // Still pending: queuing it again is a no-op.
    expect(t.invoker.groupInvite(invite, 'catch-up')).toBe(false)

    admit = true
    t.invoker.wake('message') // any wake retries pending invites first
    t.clock.advance(2000)
    await t.settle()
    expect(turns).toHaveLength(1)
    expect(t.invites.isOffered('inv_1')).toBe(true)
    expect(t.invoker.counters().pendingInvites).toBe(0)
  })

  it('a restart does not offer an invite again: the ledger is read back from disk', async () => {
    const first = make({ trays: [tray([])] })
    tmpDirs.push(first.stateDir)
    first.invoker.groupInvite(invite, 'live')
    await first.settle()
    expect(first.invites.isOffered('inv_1')).toBe(true)

    const second = make({ trays: [tray([])], stateDir: first.stateDir })
    expect(second.invoker.groupInvite(invite, 'catch-up')).toBe(false)
    await second.settle()
    expect(second.turns).toHaveLength(0)
  })

  it('without the served texts an invite waits (not offered), and runs once they arrive', async () => {
    const texts = staticTexts(null)
    const t = make({ trays: [tray([])], texts })
    tmpDirs.push(t.stateDir)
    t.invoker.groupInvite(invite, 'live')
    await t.settle()
    expect(t.turns).toHaveLength(0)
    expect(t.invites.isOffered('inv_1')).toBe(false)
    texts.set(SPELLED_TEXTS)
    t.clock.advance(60_000 + 2000) // the ladder's re-wake
    await t.settle()
    expect(t.turns).toHaveLength(1)
    expect(t.invites.isOffered('inv_1')).toBe(true)
  })

  it('stop() drops later wakes and invites', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])] })
    tmpDirs.push(t.stateDir)
    t.invoker.stop()
    t.invoker.wake('message')
    expect(t.invoker.groupInvite(invite, 'live')).toBe(false)
    t.clock.advance(10_000)
    await t.settle()
    expect(t.turns).toHaveLength(0)
    expect(t.invoker.cycles).toBe(0)
  })
})
