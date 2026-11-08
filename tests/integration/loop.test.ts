/**
 * The plugin's receive loop: the SDK kit's ReceiveLoop over the real SDK
 * socket (mock WebSocket underneath) with OpenClaw's parts plugged in — the
 * gate call, the turn as an OpenClaw run on a fresh session in the
 * account's lane, readiness, and the per-account hold on live runs that
 * outlives an account restart. The cycle rules themselves (the D5 table,
 * the coalescer) are the kit's and tested there; here: that OpenClaw's side
 * is wired to them correctly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InboxCard, TrayInvite } from 'agentchatme'

import { parseChannelConfig } from '../../src/config-schema.js'
import { CYCLE_TROUBLE_RUN, createIntegrationLoop, cycleTroubleLine, type IntegrationLoop } from '../../src/integration/loop.js'
import type { TurnOutcome, TurnReadiness, TurnRequest, TurnStarter } from '../../src/integration/model.js'
import { AccountTurns } from '../../src/integration/running.js'
import { createAfterTurnRecorder } from '../../src/integration/after-turn.js'
import { IntegrationSocket } from '../../src/integration/socket.js'
import { turnEndOf } from '../../src/integration/turns.js'
import { card, invite, tray } from '../helpers/fake-client.js'
import { capturingLogger } from '../helpers/logger.js'
import { MockWebSocket, MockWebSocketCtor, messageNew, sentFrames, flushAsync } from '../helpers/mock-websocket.js'
import { SERVED_TEXTS, staticTexts } from '../helpers/texts.js'

const KEY = ['ac', 'live', 'w'.repeat(24)].join('_')

/** The server as the loop sees it: the cards and invites waiting, what was recorded. */
function fakeServer() {
  const cards = new Map<string, InboxCard>()
  const invites = new Map<string, TrayInvite>()
  const posts: string[] = []
  const dismissed: string[] = []
  let reads = 0
  const client = {
    baseUrl: 'https://api.agentchat.me',
    inbox: {
      tray: async () => {
        reads += 1
        return tray([...cards.values()], { invites: [...invites.values()] })
      },
    },
    decisions: {
      record: async (conversationId: string, opts: { decision: string; category?: string; throughMessageId?: string }) => {
        posts.push(`${conversationId}:${opts.decision}:${opts.throughMessageId ?? '-'}`)
        cards.delete(conversationId)
        return { id: 'dec', conversation_id: conversationId, decision: opts.decision, category: opts.category ?? null, through_message_id: opts.throughMessageId ?? null, defer_until: null, created_at: '2026-11-08T00:00:00.000Z' }
      },
    },
    groups: {
      dismissInvite: async (inviteId: string) => {
        invites.delete(inviteId)
        dismissed.push(inviteId)
        return { dismissed: true }
      },
    },
  }
  return { client: client as never, cards, invites, posts, dismissed, reads: () => reads }
}

/** OpenClaw runs whose end the test decides. */
function openclawRuns() {
  const requests: TurnRequest[] = []
  const finishers: Array<(outcome: Partial<TurnOutcome>) => void> = []
  const start: TurnStarter = async (req) => {
    requests.push(req)
    const n = requests.length
    let finish!: (outcome: TurnOutcome) => void
    const done = new Promise<TurnOutcome>((resolve) => (finish = resolve))
    finishers.push((outcome) => finish({ ran: true, runId: `run_${n}`, status: 'ok', agentchatCalls: { made: 3, failed: 0 }, ...outcome }))
    return { ran: true, runId: `run_${n}`, sessionKey: req.sessionKey, done }
  }
  return { start, requests, end: (i: number, outcome: Partial<TurnOutcome> = {}) => finishers[i]!(outcome) }
}

/** A gate model that answers from markers in the preview: `[silent]` → dismiss, otherwise reply. */
const gateModel = (calls: string[]) => async (prompt: string) => {
  calls.push(prompt)
  const ids = [...prompt.matchAll(/"conversation_id":\s*"([^"]+)"/g)].map((m) => m[1]!)
  const decisions = [...new Set(ids)].map((id) => ({ conversation_id: id, decision: prompt.includes(`[silent:${id}]`) ? 'dismiss' : 'reply' }))
  return JSON.stringify({ decisions })
}

interface Harness {
  server: ReturnType<typeof fakeServer>
  runs: ReturnType<typeof openclawRuns>
  modelCalls: string[]
  logger: ReturnType<typeof capturingLogger>
  socket: IntegrationSocket
  integration: IntegrationLoop
  ws: MockWebSocket
  turns: AccountTurns
}

const live: Harness[] = []

async function start(opts: { paceMs?: number; turns?: AccountTurns; server?: ReturnType<typeof fakeServer>; readiness?: () => TurnReadiness; gateEnabled?: boolean; texts?: ReturnType<typeof staticTexts> } = {}): Promise<Harness> {
  const config = parseChannelConfig({ apiKey: KEY, apiBase: 'https://api.agentchat.me', agentHandle: 'alice' })
  const server = opts.server ?? fakeServer()
  const runs = openclawRuns()
  const modelCalls: string[] = []
  const logger = capturingLogger()
  const socket = new IntegrationSocket({ config, logger, webSocket: MockWebSocketCtor })
  const turns = opts.turns ?? new AccountTurns()
  const integration = createIntegrationLoop({
    accountId: 'default',
    agentId: 'main',
    client: server.client,
    texts: opts.texts ?? staticTexts(),
    socket: socket.realtime,
    handle: 'alice',
    callModel: gateModel(modelCalls),
    startRun: runs.start,
    turns,
    logger,
    ...(opts.readiness ? { readiness: opts.readiness } : {}),
    ...(opts.gateEnabled !== undefined ? { gateEnabled: opts.gateEnabled } : {}),
    quietMs: 0,
    maxMs: 0,
    ...(opts.paceMs !== undefined ? { paceMs: opts.paceMs } : {}),
  })
  socket.bind()
  await integration.loop.start()
  const ws = MockWebSocket.latest()
  ws.simulateReady(['ack', 'heartbeat', 'rewake'])
  await flushAsync(20)
  const h = { server, runs, modelCalls, logger, socket, integration, ws, turns }
  live.push(h)
  return h
}

async function message(h: Harness, conversationId: string, seq: number, text = 'hello', sender = '@bob'): Promise<void> {
  h.server.cards.set(conversationId, card(conversationId, `msg_${conversationId}_${seq}`, { preview: { message_id: `msg_${conversationId}_${seq}`, sender, text, at: '2026-11-08T00:00:00.000Z' } }))
  h.ws.simulateMessage(messageNew(conversationId, seq, { sender, id: `msg_${conversationId}_${seq}` }))
  await flushAsync(30)
}

beforeEach(() => MockWebSocket.reset())
afterEach(async () => {
  for (const h of live.splice(0)) {
    await h.integration.stop()
    h.socket.stopped()
  }
})

describe('the loop on the SDK socket', () => {
  it('a peer message is one cycle: acked on receipt before the gate is asked; the gate dismisses at once; our own echo wakes nothing', async () => {
    const h = await start()
    const readsAfterConnect = h.server.reads()
    await message(h, 'conv_a', 1, '[silent:conv_a] thanks')
    expect(sentFrames(h.ws, 'ack').map((f) => f.message_id)).toEqual(['msg_conv_a_1'])
    expect(h.modelCalls).toHaveLength(1)
    expect(h.server.posts).toEqual(['conv_a:dismiss:msg_conv_a_1'])
    expect(h.runs.requests).toHaveLength(0)

    h.ws.simulateMessage(messageNew('conv_a', 2, { sender: '@Alice', id: 'msg_echo' }))
    await flushAsync(30)
    expect(h.server.reads()).toBe(readsAfterConnect + 1)
  })

  it('the gate prompt opens with the served gate-call preamble, spelled for OpenClaw', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    expect(h.modelCalls[0]!.startsWith(SERVED_TEXTS.gate_call_preamble!)).toBe(true)
    expect(h.modelCalls[0]).toContain('agentchat__agentchat_decide')
  })
})

describe('a reply turn is one OpenClaw run', () => {
  it('a fresh session in the account lane, the kit prompt (served wake instruction + the conversation id, spelled for OpenClaw); nothing recorded while it runs', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    expect(h.runs.requests).toHaveLength(1)
    const req = h.runs.requests[0]!
    expect(req.sessionKey).toMatch(/^agent:main:subagent:agentchat-wake-\d{8}T\d{6}Z-[0-9a-f]{6}$/)
    expect(req.lane).toBe('agentchat-integration:default')
    expect(req.prompt.startsWith(SERVED_TEXTS.wake_instruction)).toBe(true)
    expect(req.prompt).toContain('conv_a')
    expect(h.server.posts).toEqual([])
    expect(h.logger.at('info').some((l) => l.msg === 'turn start')).toBe(true)
  })

  it('after the confirmed end the kit records reply through the gate anchor — only because the answer went out', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    h.server.cards.set('conv_a', card('conv_a', 'msg_conv_a_1', { you_owe_reply: false, your_last_message_at: '2026-11-08T00:01:00.000Z' }))
    h.runs.end(0)
    await flushAsync(30)
    expect(h.server.posts).toEqual(['conv_a:reply:msg_conv_a_1'])
    expect(h.logger.at('info').some((l) => /reply recorded after the turn \(answer_sent\)/.test(l.msg ?? ''))).toBe(true)
  })

  it('a run that ended "ok" without sending records nothing the first time (the old blind spot)', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    h.runs.end(0)
    await flushAsync(30)
    expect(h.server.posts).toEqual([])
    expect(h.logger.at('info').some((l) => /nothing recorded after the turn \(silent_first\)/.test(l.msg ?? ''))).toBe(true)
  })

  it('a live run holds its card: wakes in between start no second run; a run that ended in error records nothing', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    await message(h, 'conv_a', 2)
    h.ws.simulateMessage({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: ['conv_a'], step: 1, at: '2026-11-08T00:00:00.000Z' } })
    await flushAsync(30)
    expect(h.runs.requests).toHaveLength(1)
    h.runs.end(0, { status: 'error', error: 'model crashed' })
    await flushAsync(30)
    expect(h.server.posts).toEqual([])
  })

  it('the plugin runtime gone before the end: the card stays reserved', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    h.runs.end(0, { status: 'gone' })
    await flushAsync(30)
    await message(h, 'conv_a', 2)
    expect(h.runs.requests).toHaveLength(1)
    expect(h.server.posts).toEqual([])
  })
})

describe('an account restart while a run lives (OpenClaw restarts the channel task on a config change)', () => {
  it('the new loop shares the account’s turns: the card stays out of its gate; the old loop still records what the run did', async () => {
    const turns = new AccountTurns()
    const server = fakeServer()
    const first = await start({ turns, server })
    await message(first, 'conv_a', 1)
    expect(first.runs.requests).toHaveLength(1)
    live.splice(live.indexOf(first), 1)
    await first.integration.stop()
    first.socket.stopped()

    const second = await start({ turns, server })
    await message(second, 'conv_a', 2)
    expect(second.modelCalls).toHaveLength(0)
    expect(second.runs.requests).toHaveLength(0)

    server.cards.set('conv_a', card('conv_a', 'msg_conv_a_2', { you_owe_reply: false, your_last_message_at: '2026-11-08T00:01:00.000Z' }))
    first.runs.end(0)
    await flushAsync(30)
    expect(server.posts).toEqual(['conv_a:reply:msg_conv_a_1'])
    expect(turns.tracker.size).toBe(0)
  })

  it('when the held run ends, the live loop is woken: a message that arrived during the run is gated at once (no new socket frame)', async () => {
    const turns = new AccountTurns()
    const server = fakeServer()
    const first = await start({ turns, server })
    await message(first, 'conv_a', 1)
    live.splice(live.indexOf(first), 1)
    await first.integration.stop()
    first.socket.stopped()

    const second = await start({ turns, server })
    await message(second, 'conv_a', 2) // arrives during the run: held
    expect(second.runs.requests).toHaveLength(0)
    const gateCallsBefore = second.modelCalls.length

    first.runs.end(0) // looked, sent nothing: the card (now msg 2) stays
    await new Promise((resolve) => setTimeout(resolve, 400))
    await flushAsync(30)
    expect(second.modelCalls.length).toBeGreaterThan(gateCallsBefore)
    expect(second.runs.requests).toHaveLength(1)
    expect(second.runs.requests[0]!.prompt).toContain('conv_a')
  })
})

describe('a run that never ends does not freeze the account', () => {
  it('handed off after 30 minutes: the slot frees and another conversation gets its turn, while the hung one stays held', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    expect(h.runs.requests).toHaveLength(1)
    await message(h, 'conv_b', 1) // waits: one turn slot
    expect(h.runs.requests).toHaveLength(1)

    const runId = h.turns.runningRuns()[0]!.runId
    expect(h.turns.handOff(runId)).not.toBeNull() // what the run watch does past 30 minutes
    await flushAsync(30)
    expect(h.runs.requests).toHaveLength(2)
    expect(h.runs.requests[1]!.prompt).toContain('conv_b')
    // …on the next OpenClaw lane: the hung run would block its own.
    expect(h.runs.requests[0]!.lane).toBe('agentchat-integration:default')
    expect(h.runs.requests[1]!.lane).toBe('agentchat-integration:default:1')

    await message(h, 'conv_a', 2) // still held: no second turn for it
    expect(h.runs.requests.filter((r) => r.prompt.includes('conv_a'))).toHaveLength(1)

    h.runs.end(0) // OpenClaw finally ends it: nothing recorded for it, the card is gated again
    await flushAsync(30)
    expect(h.server.posts.filter((p) => p.startsWith('conv_a'))).toEqual([])
    expect(h.turns.hungCount).toBe(0)
  })
})

describe('a handed-off turn that ends (item: no lost after-turn recording)', () => {
  it('an answer sent at minute 35 records reply, and the card is not gated again', async () => {
    const turns = new AccountTurns()
    const h = await start({ turns })
    turns.configure({ recorder: createAfterTurnRecorder({ client: h.server.client, logger: h.logger }) })
    await message(h, 'conv_a', 1)
    const runId = h.turns.runningRuns()[0]!.runId
    expect(h.turns.handOff(runId)).not.toBeNull()
    await flushAsync(30)
    // The run sends its answer at minute 35, then ends.
    h.server.cards.set('conv_a', card('conv_a', 'msg_conv_a_1', { you_owe_reply: false, your_last_message_at: '2026-11-08T00:35:00.000Z' }))
    h.runs.end(0)
    await flushAsync(50)
    expect(h.server.posts).toEqual(['conv_a:reply:msg_conv_a_1'])
    expect(h.runs.requests).toHaveLength(1) // no second turn for it
    expect(h.turns.hungCount).toBe(0)
  })

  it('a release sticks through the loop: the old run’s later reports leave the new turn for the conversation alone', async () => {
    let clock = 0
    const turns = new AccountTurns({ now: () => clock })
    const h = await start({ turns })
    await message(h, 'conv_a', 1)
    const oldRun = h.turns.runningRuns()[0]!.runId
    clock = 31 * 60_000
    h.turns.handOff(oldRun)
    expect(h.turns.release('conv_a')).toMatchObject({ released: true, what: 'hung' })
    await message(h, 'conv_a', 2) // gated again: a new turn
    expect(h.runs.requests).toHaveLength(2)
    clock = 41 * 60_000
    expect(h.turns.handOff(oldRun)).toBeNull() // what the next "still running" report does
    expect(h.turns.tracker.conversationRunning('conv_a')).toBe(true) // the new turn still holds it
    await message(h, 'conv_a', 3)
    expect(h.runs.requests).toHaveLength(2)
    h.server.cards.set('conv_a', card('conv_a', 'msg_conv_a_3', { you_owe_reply: false, your_last_message_at: '2026-11-08T00:42:00.000Z' }))
    h.runs.end(1)
    await flushAsync(30)
    expect(h.server.posts).toEqual(['conv_a:reply:msg_conv_a_2']) // the new turn's own outcome, recorded by the kit
  })
})

describe('D5 rules of the kit, as recorded through this plugin', () => {
  it('a reply turn that failed after its answer went out still records reply', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    h.server.cards.set('conv_a', card('conv_a', 'msg_conv_a_1', { you_owe_reply: false, your_last_message_at: '2026-11-08T00:01:00.000Z' }))
    h.runs.end(0, { status: 'error', error: 'the run crashed after the send' })
    await flushAsync(30)
    expect(h.server.posts).toEqual(['conv_a:reply:msg_conv_a_1'])
  })

  it('a second silent look with unknown call counts (transcript refused) is a defer, never a dismiss', async () => {
    const h = await start({ paceMs: 0 })
    await message(h, 'conv_a', 1)
    h.runs.end(0, { agentchatCalls: null })
    await flushAsync(30)
    expect(h.server.posts).toEqual([])
    h.ws.simulateMessage({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: ['conv_a'], step: 1, at: '2026-11-08T00:00:00.000Z' } })
    await flushAsync(30)
    expect(h.runs.requests).toHaveLength(2)
    h.runs.end(1, { agentchatCalls: null })
    await flushAsync(30)
    expect(h.server.posts).toEqual(['conv_a:defer:msg_conv_a_1'])
  })

  it('the same with known, fully successful calls is a dismiss', async () => {
    const h = await start({ paceMs: 0 })
    await message(h, 'conv_a', 1)
    h.runs.end(0)
    await flushAsync(30)
    h.ws.simulateMessage({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: ['conv_a'], step: 1, at: '2026-11-08T00:00:00.000Z' } })
    await flushAsync(30)
    h.runs.end(1)
    await flushAsync(30)
    expect(h.server.posts).toEqual(['conv_a:dismiss:msg_conv_a_1'])
  })
})

describe('invites from the tray', () => {
  it('one run per invite on a fresh session with the served invite prompt; dismissed after two silent turns', async () => {
    const h = await start()
    h.server.invites.set('inv_1', invite('inv_1'))
    h.ws.simulateMessage({ type: 'group.invite.received', payload: { id: 'inv_1', group_id: 'grp_inv_1' } })
    await flushAsync(30)
    expect(h.modelCalls).toHaveLength(0)
    expect(h.runs.requests).toHaveLength(1)
    const first = h.runs.requests[0]!
    expect(first.sessionKey).toMatch(/^agent:main:subagent:agentchat-invite-inv_1-\d{8}T\d{6}Z-[0-9a-f]{6}$/)
    expect(first.prompt.startsWith(SERVED_TEXTS.invite_prompt)).toBe(true)
    expect(first.prompt).toContain('inv_1')
    h.runs.end(0)
    await flushAsync(30)
    expect(h.server.dismissed).toEqual([])

    h.ws.simulateMessage({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: [], step: 1, at: '2026-11-08T00:00:00.000Z' } })
    await flushAsync(30)
    expect(h.runs.requests).toHaveLength(2)
    expect(h.runs.requests[1]!.sessionKey).not.toBe(first.sessionKey)
    h.runs.end(1)
    await flushAsync(30)
    expect(h.server.dismissed).toEqual(['inv_1'])
  })
})

describe('OpenClaw-side switches', () => {
  it('tools not ready: no gate call, the reason logged once until it changes', async () => {
    let reason: string | null = 'mcp.servers.agentchat is not in the gateway config'
    const h = await start({ readiness: () => (reason ? { ready: false, reason } : { ready: true }) })
    await message(h, 'conv_a', 1)
    await message(h, 'conv_a', 2)
    expect(h.modelCalls).toHaveLength(0)
    expect(h.logger.at('warn').filter((l) => /not gating — no turn can start now/.test(l.msg ?? '') && /mcp\.servers\.agentchat/.test(String(l.obj.reason)))).toHaveLength(1)
    reason = null
    await message(h, 'conv_a', 3)
    expect(h.modelCalls).toHaveLength(1)
    expect(h.logger.at('info').some((l) => l.msg === 'turns can start again — gating resumes')).toBe(true)
  })

  it('gate off: single-run mode — one run with the served wake instruction, nothing recorded on its behalf', async () => {
    const h = await start({ gateEnabled: false })
    await message(h, 'conv_a', 1)
    expect(h.modelCalls).toHaveLength(0)
    expect(h.runs.requests).toHaveLength(1)
    expect(h.runs.requests[0]!.prompt).toBe(SERVED_TEXTS.wake_instruction)
    h.runs.end(0)
    await flushAsync(30)
    expect(h.server.posts).toEqual([])
  })

  it('gate off: a run still going after 30 minutes is handed off — the cycle ends, the next run goes to a fresh lane', async () => {
    const h = await start({ gateEnabled: false })
    await message(h, 'conv_a', 1)
    expect(h.runs.requests).toHaveLength(1)
    await message(h, 'conv_b', 1) // the cycle still waits on the first run
    expect(h.runs.requests).toHaveLength(1)
    const runId = h.turns.runningRuns()[0]!.runId
    expect(h.turns.handOff(runId)).toMatchObject({ kind: 'run' })
    await flushAsync(30)
    await message(h, 'conv_b', 2)
    expect(h.runs.requests).toHaveLength(2)
    expect(h.runs.requests[1]!.lane).toBe('agentchat-integration:default:1')
    h.server.cards.clear() // the runs answered everything
    h.runs.end(0)
    h.runs.end(1)
    await flushAsync(30)
    expect(h.turns.hungCount).toBe(0)
    for (let i = 2; i < h.runs.requests.length; i += 1) h.runs.end(i)
  })

  it('no gate-call texts (an older server): the gate uses the SDK’s 1.2 wording (lead decision) and works', async () => {
    const { gate_call_preamble: _p, gate_call_answer_format: _f, ...old } = SERVED_TEXTS
    const h = await start({ texts: staticTexts(old) })
    await message(h, 'conv_a', 1)
    expect(h.modelCalls).toHaveLength(1)
    expect(h.modelCalls[0]).toContain('agentchat__agentchat_decide')
    expect(h.runs.requests).toHaveLength(1)
  })
})

describe('turnEndOf', () => {
  it('only ok without an error is completed; the call counts travel', () => {
    expect(turnEndOf({ ran: true, status: 'ok', agentchatCalls: { made: 1, failed: 0 } })).toEqual({ status: 'completed', agentchatCalls: { made: 1, failed: 0 } })
    expect(turnEndOf({ ran: true, status: 'timeout' })).toEqual({ status: 'failed', agentchatCalls: null, detail: 'run ended: timeout' })
    expect(turnEndOf({ ran: true, status: 'ok', error: 'x' })).toMatchObject({ status: 'failed', detail: 'x' })
  })
})

describe('cycleTroubleLine — repeated cycles that decided nothing', () => {
  const ok = { outcome: 'decided', failure: null }
  const failed = { outcome: 'fail_closed', failure: 'the gate call timed out' }
  it('nothing until the last cycles ended in trouble CYCLE_TROUBLE_RUN times in a row', () => {
    expect(CYCLE_TROUBLE_RUN).toBe(3)
    expect(cycleTroubleLine([])).toBeNull()
    expect(cycleTroubleLine([failed, failed])).toBeNull()
    expect(cycleTroubleLine([failed, failed, failed, ok])).toBeNull()
  })

  it('names the run, what each outcome means, and the latest failure', () => {
    const line = cycleTroubleLine([ok, failed, { outcome: 'tools_unavailable', failure: 'mcp.servers.agentchat is not in the gateway config' }, { outcome: 'abandoned', failure: 'the cycle ran past 600000 ms' }])
    expect(line).toMatch(/^the last 3 cycles decided nothing \(fail_closed, tools_unavailable, abandoned\): the gate call failed/)
    expect(line).toMatch(/latest: the cycle ran past 600000 ms; the cards wait on the tray and AgentChat re-wakes them$/)
  })

  it('the loop keeps the summaries the line reads (status().recentCycles)', async () => {
    const h = await start({ texts: staticTexts(null) })
    await message(h, 'conv_a', 1)
    await message(h, 'conv_a', 2)
    await message(h, 'conv_a', 3)
    const recent = h.integration.loop.status().recentCycles
    expect(recent.slice(-3).map((c) => c.outcome)).toEqual(['texts_missing', 'texts_missing', 'texts_missing'])
    expect(cycleTroubleLine(recent)).toMatch(/^the last \d+ cycles decided nothing \(texts_missing\)/)
  })
})

