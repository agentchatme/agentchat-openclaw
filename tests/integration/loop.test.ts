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
import { createIntegrationLoop, type IntegrationLoop } from '../../src/integration/loop.js'
import type { TurnOutcome, TurnReadiness, TurnRequest, TurnStarter } from '../../src/integration/model.js'
import { RunningTurns } from '../../src/integration/running.js'
import { IntegrationSocket } from '../../src/integration/socket.js'
import { turnEndOf } from '../../src/integration/turns.js'
import { card, invite, tray } from '../helpers/fake-client.js'
import { capturingLogger } from '../helpers/logger.js'
import { MockWebSocket, MockWebSocketCtor, messageNew, sentFrames, settle } from '../helpers/mock-websocket.js'
import { SPELLED_TEXTS, staticTexts } from '../helpers/texts.js'

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
    return { ran: true, runId: `run_${n}`, done }
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
}

const live: Harness[] = []

async function start(opts: { running?: RunningTurns; server?: ReturnType<typeof fakeServer>; readiness?: () => TurnReadiness; gateEnabled?: boolean; texts?: ReturnType<typeof staticTexts> } = {}): Promise<Harness> {
  const config = parseChannelConfig({ apiKey: KEY, apiBase: 'https://api.agentchat.me', agentHandle: 'alice' })
  const server = opts.server ?? fakeServer()
  const runs = openclawRuns()
  const modelCalls: string[] = []
  const logger = capturingLogger()
  const socket = new IntegrationSocket({ config, logger, webSocket: MockWebSocketCtor })
  const integration = createIntegrationLoop({
    accountId: 'default',
    agentId: 'main',
    client: server.client,
    texts: opts.texts ?? staticTexts(),
    socket: socket.realtime,
    handle: 'alice',
    callModel: gateModel(modelCalls),
    startRun: runs.start,
    running: opts.running ?? new RunningTurns(),
    logger,
    ...(opts.readiness ? { readiness: opts.readiness } : {}),
    ...(opts.gateEnabled !== undefined ? { gateEnabled: opts.gateEnabled } : {}),
    quietMs: 0,
    maxMs: 0,
  })
  socket.bind()
  await integration.loop.start()
  const ws = MockWebSocket.latest()
  ws.simulateReady(['ack', 'heartbeat', 'rewake'])
  await settle(20)
  const h = { server, runs, modelCalls, logger, socket, integration, ws }
  live.push(h)
  return h
}

async function message(h: Harness, conversationId: string, seq: number, text = 'hello', sender = '@bob'): Promise<void> {
  h.server.cards.set(conversationId, card(conversationId, `msg_${conversationId}_${seq}`, { preview: { message_id: `msg_${conversationId}_${seq}`, sender, text, at: '2026-11-08T00:00:00.000Z' } }))
  h.ws.simulateMessage(messageNew(conversationId, seq, { sender, id: `msg_${conversationId}_${seq}` }))
  await settle(30)
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
    await settle(30)
    expect(h.server.reads()).toBe(readsAfterConnect + 1)
  })

  it('the gate prompt opens with the served gate-call preamble, spelled for OpenClaw', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    expect(h.modelCalls[0]!.startsWith(SPELLED_TEXTS.gate_call_preamble!)).toBe(true)
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
    expect(req.prompt.startsWith(SPELLED_TEXTS.wake_instruction)).toBe(true)
    expect(req.prompt).toContain('conv_a')
    expect(h.server.posts).toEqual([])
    expect(h.logger.at('info').some((l) => l.msg === 'turn start')).toBe(true)
  })

  it('after the confirmed end the kit records reply through the gate anchor — only because the answer went out', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    h.server.cards.set('conv_a', card('conv_a', 'msg_conv_a_1', { you_owe_reply: false, your_last_message_at: '2026-11-08T00:01:00.000Z' }))
    h.runs.end(0)
    await settle(30)
    expect(h.server.posts).toEqual(['conv_a:reply:msg_conv_a_1'])
    expect(h.logger.at('info').some((l) => /reply recorded after the turn \(answer_sent\)/.test(l.msg ?? ''))).toBe(true)
  })

  it('a run that ended "ok" without sending records nothing the first time (the old blind spot)', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    h.runs.end(0)
    await settle(30)
    expect(h.server.posts).toEqual([])
    expect(h.logger.at('info').some((l) => /nothing recorded after the turn \(silent_first\)/.test(l.msg ?? ''))).toBe(true)
  })

  it('a live run holds its card: wakes in between start no second run; a run that ended in error records nothing', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    await message(h, 'conv_a', 2)
    h.ws.simulateMessage({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: ['conv_a'], step: 1, at: '2026-11-08T00:00:00.000Z' } })
    await settle(30)
    expect(h.runs.requests).toHaveLength(1)
    h.runs.end(0, { status: 'error', error: 'model crashed' })
    await settle(30)
    expect(h.server.posts).toEqual([])
  })

  it('the plugin runtime gone before the end: the card stays reserved', async () => {
    const h = await start()
    await message(h, 'conv_a', 1)
    h.runs.end(0, { status: 'gone' })
    await settle(30)
    await message(h, 'conv_a', 2)
    expect(h.runs.requests).toHaveLength(1)
    expect(h.server.posts).toEqual([])
  })
})

describe('an account restart while a run lives (OpenClaw restarts the channel task on a config change)', () => {
  it('the new loop starts no second run for the card; when the old run ends, it reads the tray again', async () => {
    const running = new RunningTurns()
    const server = fakeServer()
    const first = await start({ running, server })
    await message(first, 'conv_a', 1)
    expect(first.runs.requests).toHaveLength(1)
    live.splice(live.indexOf(first), 1)
    await first.integration.stop()
    first.socket.stopped()

    const second = await start({ running, server })
    await settle(30)
    expect(second.runs.requests).toHaveLength(0)
    expect(second.logger.at('info').some((l) => /still live for it — no second turn/.test(l.msg ?? ''))).toBe(true)

    const readsBefore = server.reads()
    first.runs.end(0)
    await settle(30)
    expect(server.reads()).toBeGreaterThan(readsBefore)
    expect(second.runs.requests).toHaveLength(1) // now it may be gated again
  })
})

describe('invites from the tray', () => {
  it('one run per invite on a fresh session with the served invite prompt; dismissed after two silent turns', async () => {
    const h = await start()
    h.server.invites.set('inv_1', invite('inv_1'))
    h.ws.simulateMessage({ type: 'group.invite.received', payload: { id: 'inv_1', group_id: 'grp_inv_1' } })
    await settle(30)
    expect(h.modelCalls).toHaveLength(0)
    expect(h.runs.requests).toHaveLength(1)
    const first = h.runs.requests[0]!
    expect(first.sessionKey).toMatch(/^agent:main:subagent:agentchat-invite-inv_1-\d{8}T\d{6}Z-[0-9a-f]{6}$/)
    expect(first.prompt.startsWith(SPELLED_TEXTS.invite_prompt)).toBe(true)
    expect(first.prompt).toContain('inv_1')
    h.runs.end(0)
    await settle(30)
    expect(h.server.dismissed).toEqual([])

    h.ws.simulateMessage({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: [], step: 1, at: '2026-11-08T00:00:00.000Z' } })
    await settle(30)
    expect(h.runs.requests).toHaveLength(2)
    expect(h.runs.requests[1]!.sessionKey).not.toBe(first.sessionKey)
    h.runs.end(1)
    await settle(30)
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
    expect(h.logger.at('warn').filter((l) => /tools not available/.test(l.msg ?? ''))).toHaveLength(1)
    reason = null
    await message(h, 'conv_a', 3)
    expect(h.modelCalls).toHaveLength(1)
    expect(h.logger.at('info').some((l) => l.msg === 'AgentChat tools available to turns again')).toBe(true)
  })

  it('gate off: single-run mode — one run with the served wake instruction, nothing recorded on its behalf', async () => {
    const h = await start({ gateEnabled: false })
    await message(h, 'conv_a', 1)
    expect(h.modelCalls).toHaveLength(0)
    expect(h.runs.requests).toHaveLength(1)
    expect(h.runs.requests[0]!.prompt).toBe(SPELLED_TEXTS.wake_instruction)
    h.runs.end(0)
    await settle(30)
    expect(h.server.posts).toEqual([])
  })

  it('no gate-call texts (an older server): the gate fails closed, nothing recorded, no run', async () => {
    const { gate_call_preamble: _p, gate_call_answer_format: _f, ...old } = SPELLED_TEXTS
    const h = await start({ texts: staticTexts(old) })
    await message(h, 'conv_a', 1)
    expect(h.modelCalls).toHaveLength(0)
    expect(h.runs.requests).toHaveLength(0)
    expect(h.logger.at('warn').some((l) => /gate failed closed/.test(l.msg ?? ''))).toBe(true)
  })
})

describe('turnEndOf', () => {
  it('only ok without an error is completed; the call counts travel', () => {
    expect(turnEndOf({ ran: true, status: 'ok', agentchatCalls: { made: 1, failed: 0 } })).toEqual({ status: 'completed', agentchatCalls: { made: 1, failed: 0 } })
    expect(turnEndOf({ ran: true, status: 'timeout' })).toEqual({ status: 'failed', agentchatCalls: null, detail: 'run ended: timeout' })
    expect(turnEndOf({ ran: true, status: 'ok', error: 'x' })).toMatchObject({ status: 'failed', detail: 'x' })
  })
})
