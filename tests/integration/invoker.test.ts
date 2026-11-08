/**
 * The invoker in gate-call mode (contract v1): wake → tray → gate → one turn
 * per reply, and after the run ends the D5 outcome — recorded from what the
 * turn actually did, read on a fresh tray, never from "turn ok". No local
 * retry ladder (the server re-wakes unanswered cards); a card or invite
 * whose turn is still running is never gated again, across invokers of the
 * same account too.
 */

import { describe, expect, it } from 'vitest'

import { AgentInvoker, turnEndOf } from '../../src/integration/invoker.js'
import type { TurnOutcome, TurnReadiness, TurnRequest, TurnStarter } from '../../src/integration/model.js'
import { RunningTurns } from '../../src/integration/running.js'
import type { MetricsRecorder } from '../../src/metrics.js'
import { Clock } from '../helpers/clock.js'
import { capturingLogger } from '../helpers/logger.js'
import { card, fakeClient, invite, tray, type FakeClientOptions } from '../helpers/fake-client.js'
import { SERVED_TEXTS, SPELLED_TEXTS, staticTexts } from '../helpers/texts.js'
import { spellTextsForOpenClaw } from '../../src/integration/texts.js'

const CONVERSATION_IN_PROMPT = /Conversation to answer: (\S+)$/

function decisions(...entries: Array<[string, string, string?]>): string {
  return JSON.stringify({
    decisions: entries.map(([conversation_id, decision, category]) => ({ conversation_id, decision, ...(category ? { category } : {}) })),
  })
}

/** A turn starter whose runs end when the test says so. */
function controlledTurns() {
  const requests: TurnRequest[] = []
  const finishers: Array<(outcome: Partial<TurnOutcome>) => void> = []
  const start: TurnStarter = async (req) => {
    requests.push(req)
    const n = requests.length
    let finish!: (outcome: TurnOutcome) => void
    const done = new Promise<TurnOutcome>((resolve) => (finish = resolve))
    finishers.push((outcome) => finish({ ran: true, runId: `run_${n}`, status: 'ok', agentchatCalls: { made: 3, failed: 0 }, ...outcome }))
    return { ran: true, runId: `run_${n}`, done }
  }
  return { start, requests, end: (i: number, outcome: Partial<TurnOutcome> = {}) => finishers[i]!(outcome) }
}

interface MakeOptions extends Omit<FakeClientOptions, 'texts'> {
  answer?: string | ((prompt: string) => Promise<string>)
  texts?: ReturnType<typeof staticTexts>
  startTurn?: TurnStarter
  readiness?: () => TurnReadiness
  gateEnabled?: boolean
  running?: RunningTurns
}

function make(opts: MakeOptions = {}) {
  const clock = new Clock()
  const fake = fakeClient({ trays: opts.trays, rejectRecords: opts.rejectRecords, afterTurn: opts.afterTurn })
  const turns = controlledTurns()
  let modelCalls = 0
  const prompts: string[] = []
  const callModel = async (prompt: string): Promise<string> => {
    modelCalls += 1
    prompts.push(prompt)
    const answer = opts.answer ?? decisions()
    return typeof answer === 'string' ? answer : answer(prompt)
  }
  const logger = capturingLogger()
  const wakeSources: string[] = []
  const metrics: MetricsRecorder = {
    incWake: ({ source }) => void wakeSources.push(source),
    incDisconnect: () => undefined,
    incError: () => undefined,
    setConnectionState: () => undefined,
  }
  const running = opts.running ?? new RunningTurns()
  const invoker = new AgentInvoker({
    accountId: 'default',
    agentId: 'main',
    client: fake.client,
    callModel,
    startTurn: opts.startTurn ?? turns.start,
    texts: opts.texts ?? staticTexts(),
    running,
    logger,
    metrics,
    ...(opts.readiness ? { readiness: opts.readiness } : {}),
    ...(opts.gateEnabled !== undefined ? { gateEnabled: opts.gateEnabled } : {}),
    quietMs: 2000,
    maxMs: 6000,
    now: () => clock.now,
    setTimeout: clock.setTimeout as never,
    clearTimeout: clock.clearTimeout as never,
  })
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await invoker.settled()
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  /** Wake, let the coalescer fire, let the cycle run. */
  const cycle = async (source: Parameters<AgentInvoker['wake']>[0] = 'message') => {
    invoker.wake(source)
    clock.advance(2000)
    await settle()
  }
  return { clock, ...fake, turns, invoker, logger, settle, cycle, running, prompts, modelCalls: () => modelCalls, wakeSources }
}

const posted = (t: ReturnType<typeof make>) => t.posts.map((p) => `${p.conversationId}:${p.body.decision}:${p.body.through_message_id ?? '-'}${p.body.category ? `:${p.body.category}` : ''}`)

describe('AgentInvoker — one cycle', () => {
  it('a reply verdict starts ONE turn naming the conversation; nothing is recorded while it runs', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: decisions(['conv_a', 'reply', 'open_request']) })
    await t.cycle()
    expect(t.modelCalls()).toBe(1)
    expect(t.turns.requests).toHaveLength(1)
    expect(CONVERSATION_IN_PROMPT.exec(t.turns.requests[0]!.prompt)?.[1]).toBe('conv_a')
    expect(t.turns.requests[0]!.prompt.startsWith(SPELLED_TEXTS.wake_instruction)).toBe(true)
    expect(t.turns.requests[0]!.lane).toBe('agentchat-integration:default')
    expect(t.posts).toEqual([])
    expect(t.invoker.counters().turnsInFlight).toBe(1)
  })

  it('the gate prompt is built from the served gate-call texts, spelled for OpenClaw', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: decisions(['conv_a', 'dismiss']) })
    await t.cycle()
    expect(t.prompts[0]!.startsWith(SPELLED_TEXTS.gate_call_preamble!)).toBe(true)
    expect(t.prompts[0]).toContain('agentchat__agentchat_decide')
    expect(t.prompts[0]!.trimEnd().endsWith(SPELLED_TEXTS.gate_call_answer_format!)).toBe(true)
  })

  it('dismiss and defer are recorded by the gate at once, through the card anchor; no turn', async () => {
    const t = make({
      trays: [tray([card('conv_a', 'msg_a'), card('conv_b', 'msg_b')])],
      answer: decisions(['conv_a', 'dismiss', 'acknowledgement'], ['conv_b', 'defer', 'other']),
    })
    await t.cycle()
    expect(posted(t)).toEqual(['conv_a:dismiss:msg_a:acknowledgement', 'conv_b:defer:msg_b:other'])
    expect(t.turns.requests).toHaveLength(0)
  })

  it('a gate that fails closed records nothing, starts nothing, and arms no local retry (the server re-wakes)', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: 'not json' })
    await t.cycle()
    expect(t.posts).toEqual([])
    expect(t.turns.requests).toHaveLength(0)
    expect(t.clock.pending).toHaveLength(0)
    expect(t.logger.at('warn').some((l) => l.msg === 'gate failed closed — nothing recorded, no turn started')).toBe(true)
  })

  it('texts without the gate-call fields (an older server): the gate fails closed, nothing is recorded', async () => {
    const { gate_call_preamble: _p, gate_call_answer_format: _f, ...old } = SERVED_TEXTS
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: decisions(['conv_a', 'reply']), texts: staticTexts(spellTextsForOpenClaw(old)) })
    await t.cycle()
    expect(t.modelCalls()).toBe(0)
    expect(t.posts).toEqual([])
    expect(t.turns.requests).toHaveLength(0)
  })

  it('a burst of wakes is one cycle', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: decisions(['conv_a', 'dismiss']) })
    t.invoker.wake('message')
    t.clock.advance(500)
    t.invoker.wake('message')
    t.clock.advance(500)
    t.invoker.wake('connect')
    t.clock.advance(2000)
    await t.settle()
    expect(t.trayCalls()).toBe(1)
    expect(t.invoker.counters()).toMatchObject({ cycles: 1, wakes: 3, absorbed: 2 })
  })

  it('a tray that cannot be read records nothing and arms nothing', async () => {
    const t = make({ trays: [new Error('503')] })
    await t.cycle()
    expect(t.modelCalls()).toBe(0)
    expect(t.clock.pending).toHaveLength(0)
  })

  it('no texts yet: nothing gated; tools not ready: nothing gated, the reason logged once until it changes', async () => {
    const noTexts = make({ trays: [tray([card('conv_a', 'msg_a')])], texts: staticTexts(null) })
    await noTexts.cycle()
    expect(noTexts.modelCalls()).toBe(0)

    let reason: string | null = 'mcp.servers.agentchat is not in the gateway config'
    const t = make({
      trays: [tray([card('conv_a', 'msg_a')])],
      answer: decisions(['conv_a', 'dismiss']),
      readiness: () => (reason ? { ready: false, reason } : { ready: true }),
    })
    await t.cycle()
    await t.cycle()
    expect(t.modelCalls()).toBe(0)
    expect(t.logger.at('warn').filter((l) => /tools not available/.test(l.msg ?? ''))).toHaveLength(1)
    reason = null
    await t.cycle()
    expect(t.modelCalls()).toBe(1)
    expect(t.logger.at('info').some((l) => l.msg === 'AgentChat tools available to turns again')).toBe(true)
  })

  it('a truncated tray earns one more cycle for the rest', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')], { truncated: true }), tray([])], answer: decisions(['conv_a', 'dismiss']) })
    await t.cycle()
    t.clock.advance(2000)
    await t.settle()
    expect(t.trayCalls()).toBe(2)
  })
})

describe('AgentInvoker — D5: after the turn, record what happened', () => {
  async function replyTurn(opts: MakeOptions & { outcome?: Partial<TurnOutcome> }) {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: decisions(['conv_a', 'reply', 'open_request']), ...opts })
    await t.cycle()
    t.turns.end(0, opts.outcome)
    await t.settle()
    return t
  }

  it('the answer went out (the card no longer owes a reply): reply is recorded through the anchor the gate saw', async () => {
    const t = await replyTurn({ afterTurn: tray([card('conv_a', 'msg_a', { you_owe_reply: false, your_last_message_at: '2026-11-04T23:00:00.000Z' })]) })
    expect(posted(t)).toEqual(['conv_a:reply:msg_a:open_request'])
    expect(t.invoker.counters().outcomes).toEqual({ answer_sent: 1 })
    expect(t.invoker.counters().turnsInFlight).toBe(0)
  })

  it('the answer went out and the peer wrote again: still reply through the gate anchor, never past it', async () => {
    const t = await replyTurn({
      afterTurn: tray([card('conv_a', 'msg_newer', { you_owe_reply: true, your_last_message_at: '2026-11-04T23:00:00.000Z' })]),
    })
    expect(posted(t)).toEqual(['conv_a:reply:msg_a:open_request'])
  })

  it('the turn recorded its own verdict (the card left the tray, or its last decision moved): nothing more', async () => {
    const gone = await replyTurn({ afterTurn: tray([]) })
    expect(gone.posts).toEqual([])
    expect(gone.invoker.counters().outcomes).toEqual({ card_left_tray: 1 })

    const moved = await replyTurn({
      afterTurn: tray([card('conv_a', 'msg_b', { your_last_decision: { decision: 'reply', category: null, at: '2026-11-04T23:00:00.000Z' } })]),
    })
    expect(moved.posts).toEqual([])
    expect(moved.invoker.counters().outcomes).toEqual({ turn_recorded_verdict: 1 })
  })

  it('"turn ok" alone records nothing: a turn that looked, sent nothing, recorded nothing — first time nothing', async () => {
    const t = await replyTurn({ afterTurn: tray([card('conv_a', 'msg_a')]) })
    expect(t.posts).toEqual([])
    expect(t.invoker.counters().outcomes).toEqual({ silent_first: 1 })
  })

  it('the second silent turn for the same anchor records dismiss (no_action_needed)', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: decisions(['conv_a', 'reply']), afterTurn: tray([card('conv_a', 'msg_a')]) })
    await t.cycle()
    t.turns.end(0)
    await t.settle()
    expect(t.posts).toEqual([])
    await t.cycle() // the server's re-wake: the card is still there, gated again, a second turn
    expect(t.turns.requests).toHaveLength(2)
    t.turns.end(1)
    await t.settle()
    expect(posted(t)).toEqual(['conv_a:dismiss:msg_a:no_action_needed'])
    expect(t.invoker.counters().outcomes).toEqual({ silent_first: 1, silent_again: 1 })
  })

  it('a turn that made no AgentChat call, or only failed ones, could not look: nothing', async () => {
    for (const agentchatCalls of [{ made: 0, failed: 0 }, { made: 2, failed: 2 }]) {
      const t = await replyTurn({ afterTurn: tray([card('conv_a', 'msg_a')]), outcome: { agentchatCalls } })
      expect(t.posts).toEqual([])
      expect(t.invoker.counters().outcomes).toEqual({ could_not_look: 1 })
    }
  })

  it('unknown call counts are read as "it looked"', async () => {
    const t = await replyTurn({ afterTurn: tray([card('conv_a', 'msg_a')]), outcome: { agentchatCalls: null } })
    expect(t.invoker.counters().outcomes).toEqual({ silent_first: 1 })
  })

  it('a run that ended in error or on its own deadline records nothing, even after a send', async () => {
    for (const outcome of [{ status: 'error' as const, error: 'model crashed' }, { status: 'timeout' as const }]) {
      const t = await replyTurn({ afterTurn: tray([card('conv_a', 'msg_a', { you_owe_reply: false })]), outcome })
      expect(t.posts).toEqual([])
      expect(t.invoker.counters().outcomes).toEqual({ turn_failed: 1 })
    }
  })

  it('a failed read after the turn records nothing (the old code recorded reply here)', async () => {
    const t = await replyTurn({ afterTurn: new Error('502') })
    expect(t.posts).toEqual([])
    expect(t.invoker.counters().outcomes).toEqual({ card_unknown: 1 })
  })

  it('a turn OpenClaw refused records nothing and leaves the card', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: decisions(['conv_a', 'reply']), startTurn: async () => ({ ran: false, error: 'lane closed' }) })
    await t.cycle()
    expect(t.posts).toEqual([])
    expect(t.invoker.counters().turnsInFlight).toBe(0)
    expect(t.clock.pending).toHaveLength(0)
  })

  it('turnEndOf: only ok is completed', () => {
    expect(turnEndOf({ ran: true, status: 'ok', agentchatCalls: { made: 1, failed: 0 } })).toEqual({ status: 'completed', agentchatCalls: { made: 1, failed: 0 } })
    expect(turnEndOf({ ran: true, status: 'timeout' })).toEqual({ status: 'failed', agentchatCalls: null })
    expect(turnEndOf({ ran: true, status: 'ok', error: 'x' })).toMatchObject({ status: 'failed' })
  })
})

describe('AgentInvoker — a running turn keeps its conversation', () => {
  it('while the run lives its card is left out of every cycle: no second gate question, no second turn', async () => {
    const t = make({
      trays: [tray([card('conv_a', 'msg_a')]), tray([card('conv_a', 'msg_a2'), card('conv_b', 'msg_b')])],
      answer: async (prompt) => decisions(...([['conv_a', 'reply'], ['conv_b', 'dismiss']] as Array<[string, string]>).filter(([id]) => prompt.includes(`"conversation_id":"${id}"`) || prompt.includes(`"conversation_id": "${id}"`))),
      afterTurn: tray([card('conv_a', 'msg_a2', { you_owe_reply: false, your_last_message_at: '2026-11-04T23:00:00.000Z' })]),
    })
    await t.cycle()
    expect(t.turns.requests).toHaveLength(1)
    // A newer message for conv_a and a new conversation land mid-turn.
    await t.cycle()
    expect(t.turns.requests).toHaveLength(1)
    expect(posted(t)).toEqual(['conv_b:dismiss:msg_b'])
    expect(t.prompts[1]).not.toContain('conv_a')
    // The run ends: D5 records through the anchor the gate saw (msg_a), and the tray is read again for conv_a.
    t.turns.end(0)
    await t.settle()
    expect(posted(t)).toEqual(['conv_b:dismiss:msg_b', 'conv_a:reply:msg_a'])
    t.clock.advance(2000)
    await t.settle()
    expect(t.trayCalls()).toBe(3)
  })

  it('a tray holding only running cards is nothing to decide: no gate call, nothing armed', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: decisions(['conv_a', 'reply']) })
    await t.cycle()
    await t.cycle('connect')
    expect(t.modelCalls()).toBe(1)
    expect(t.logger.at('info').some((l) => l.msg === 'every card on the tray has a turn running — nothing new to decide')).toBe(true)
    expect(t.clock.pending).toHaveLength(0)
  })

  it('a run whose end was never confirmed (the plugin runtime is gone) keeps its card reserved', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], answer: decisions(['conv_a', 'reply']) })
    await t.cycle()
    t.turns.end(0, { status: 'gone' })
    await t.settle()
    await t.cycle()
    expect(t.turns.requests).toHaveLength(1)
    expect(t.posts).toEqual([])
    expect(t.invoker.counters().turnsInFlight).toBe(1)
  })

  it('the reservation outlives the invoker: an account restarted mid-turn does not start a second turn; the old run’s outcome is still recorded', async () => {
    const running = new RunningTurns()
    const first = make({
      trays: [tray([card('conv_a', 'msg_a')])],
      answer: decisions(['conv_a', 'reply']),
      running,
      afterTurn: tray([card('conv_a', 'msg_a', { you_owe_reply: false })]),
    })
    await first.cycle()
    first.invoker.stop() // OpenClaw restarts the account (config change)

    const second = make({ trays: [tray([card('conv_a', 'msg_a')]), tray([])], answer: decisions(['conv_a', 'reply']), running })
    await second.cycle('connect')
    expect(second.modelCalls()).toBe(0)
    expect(second.turns.requests).toHaveLength(0)

    first.turns.end(0)
    await first.settle()
    expect(posted(first)).toEqual(['conv_a:reply:msg_a'])
    // The new invoker hears the end and reads the tray again.
    second.clock.advance(2000)
    await second.settle()
    expect(second.trayCalls()).toBe(2)
  })
})

describe('AgentInvoker — invites on the tray (D4)', () => {
  it('each pending invite gets ONE turn with the served invite prompt, not gated; a running invite is not offered again', async () => {
    const t = make({ trays: [tray([], { invites: [invite('inv_1')] })] })
    await t.cycle('invite')
    expect(t.modelCalls()).toBe(0)
    expect(t.turns.requests).toHaveLength(1)
    expect(t.turns.requests[0]!.prompt).toBe(SPELLED_TEXTS.invite_prompt)
    expect(t.turns.requests[0]!.sessionKey).toBe('agent:main:subagent:agentchat-invite-inv_1')
    await t.cycle('connect')
    expect(t.turns.requests).toHaveLength(1)
  })

  it('answered in the turn (gone from the tray): nothing; left pending by two turns that looked: dismissed', async () => {
    const answered = make({ trays: [tray([], { invites: [invite('inv_1')] })], afterTurn: tray([]) })
    await answered.cycle('invite')
    answered.turns.end(0)
    await answered.settle()
    expect(answered.dismissedInvites).toEqual([])
    expect(answered.invoker.counters().outcomes).toEqual({ invite_invite_answered: 1 })

    const t = make({ trays: [tray([], { invites: [invite('inv_1')] })] })
    await t.cycle('invite')
    t.turns.end(0)
    await t.settle()
    expect(t.dismissedInvites).toEqual([])
    await t.cycle('unanswered')
    t.turns.end(1)
    await t.settle()
    expect(t.dismissedInvites).toEqual(['inv_1'])
  })

  it('cards and invites in one tray: the cards are gated, the invite gets its own turn', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')], { invites: [invite('inv_1')] })], answer: decisions(['conv_a', 'reply']) })
    await t.cycle()
    expect(t.modelCalls()).toBe(1)
    expect(t.turns.requests.map((r) => r.sessionKey.includes('invite') ? 'invite' : 'reply')).toEqual(['reply', 'invite'])
  })
})

describe('AgentInvoker — gate off', () => {
  it('one turn with the served wake instruction, nothing recorded on its behalf, one at a time', async () => {
    const t = make({ trays: [tray([card('conv_a', 'msg_a')])], gateEnabled: false })
    await t.cycle()
    expect(t.modelCalls()).toBe(0)
    expect(t.turns.requests).toHaveLength(1)
    expect(t.turns.requests[0]!.prompt).toBe(SPELLED_TEXTS.wake_instruction)
    await t.cycle()
    expect(t.turns.requests).toHaveLength(1)
    t.turns.end(0)
    await t.settle()
    expect(t.posts).toEqual([])
  })
})
