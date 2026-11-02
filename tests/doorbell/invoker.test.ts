import { describe, expect, it } from 'vitest'

import { AgentInvoker } from '../../src/doorbell/invoker.js'
import { MainLineClient } from '../../src/doorbell/main-line.js'
import type { GateCaller } from '../../src/doorbell/gate.js'
import type { TurnRequest, TurnOutcome } from '../../src/doorbell/model.js'
import type { Logger } from '../../src/log.js'

interface Scheduled {
  id: number
  fireAt: number
  fn: () => void
}
class Clock {
  now = 0
  private next = 1
  pending: Scheduled[] = []
  setTimeout = (fn: () => void, ms: number): NodeJS.Timeout => {
    const t = { id: this.next++, fireAt: this.now + ms, fn }
    this.pending.push(t)
    return t.id as unknown as NodeJS.Timeout
  }
  clearTimeout = (h: NodeJS.Timeout): void => {
    this.pending = this.pending.filter((t) => (t.id as unknown as NodeJS.Timeout) !== h)
  }
  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      this.pending.sort((a, b) => a.fireAt - b.fireAt)
      const n = this.pending[0]
      if (!n || n.fireAt > target) break
      this.now = n.fireAt
      this.pending.shift()
      n.fn()
    }
    this.now = target
  }
}

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child: () => silent }

const card = (id: string, msg: string) => ({ conversation_id: id, type: 'direct', preview: { message_id: msg, sender: 'bob', text: 'x' } })

/** A fake server: a queue of tray answers (or errors) and a record of verdict posts. */
function fakeServer(trays: Array<unknown | Error>) {
  const posts: Array<{ conversationId: string; body: Record<string, unknown> }> = []
  let inboxCalls = 0
  const client = new MainLineClient({
    apiKey: 'ac_live_' + 'k'.repeat(24),
    apiBase: 'https://api.agentchat.me',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v1/inbox')) {
        inboxCalls += 1
        const next = trays.length > 1 ? trays.shift() : trays[0]
        if (next instanceof Error) throw next
        return new Response(JSON.stringify(next ?? { question: 'Q', conversations: [] }), { status: 200 })
      }
      const conversationId = decodeURIComponent(url.split('/conversations/')[1]!.split('/')[0]!)
      posts.push({ conversationId, body: JSON.parse(init?.body as string) })
      return new Response(JSON.stringify({}), { status: 201 })
    }) as typeof fetch,
  })
  return { client, posts, inboxCalls: () => inboxCalls }
}

function make(opts: {
  trays: Array<unknown | Error>
  gate?: GateCaller
  turn?: (req: TurnRequest) => Promise<TurnOutcome>
  gateEnabled?: boolean
  failOpen?: boolean
}) {
  const clock = new Clock()
  const server = fakeServer(opts.trays)
  const turns: TurnRequest[] = []
  const invoker = new AgentInvoker({
    accountId: 'default',
    agentId: 'main',
    mainLine: server.client,
    gateCaller: opts.gate ?? (async () => '{"decisions":[]}'),
    turnRunner:
      opts.turn ??
      (async (req) => {
        turns.push(req)
        return { ran: true, runId: 'run_1', status: 'ok' }
      }),
    logger: silent,
    gateEnabled: opts.gateEnabled,
    gateFailOpen: opts.failOpen,
    debounceMs: 2000,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  const settle = async () => {
    for (let i = 0; i < 20; i++) await invoker.settled()
  }
  return { clock, server, invoker, turns, settle }
}

describe('AgentInvoker — knock → tray → gate → one turn', () => {
  it('a burst of knocks is one cycle; reply ids go to the turn prompt; dismiss/defer are posted with through_message_id', async () => {
    const { clock, server, invoker, turns, settle } = make({
      trays: [{ you: 'alice', question: 'Q', conversations: [card('conv_a', 'msg_a'), card('conv_b', 'msg_b'), card('conv_c', 'msg_c')] }],
      gate: async () =>
        '{"decisions":[{"conversation_id":"conv_a","decision":"reply"},{"conversation_id":"conv_b","decision":"dismiss"},{"conversation_id":"conv_c","decision":"defer","defer_seconds":600}]}',
    })
    for (let i = 0; i < 5; i++) invoker.knock('message')
    clock.advance(2000)
    await settle()
    expect(server.inboxCalls()).toBe(1)
    expect(invoker.cycles).toBe(1)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.prompt).toMatch(/decided to answer: conv_a\./)
    expect(turns[0]!.sessionKey).toMatch(/^agent:main:subagent:agentchat-knock-/)
    expect(turns[0]!.lane).toBe('agentchat-doorbell:default')
    expect(server.posts).toEqual([
      { conversationId: 'conv_b', body: { decision: 'dismiss', through_message_id: 'msg_b' } },
      { conversationId: 'conv_c', body: { decision: 'defer', through_message_id: 'msg_c', defer_seconds: 600 } },
    ])
    expect(invoker.counters().knocks).toBe(5)
    expect(invoker.counters().absorbed).toBe(4)
  })

  it('every card dismissed → no turn', async () => {
    const { clock, invoker, turns, settle } = make({
      trays: [{ question: 'Q', conversations: [card('conv_a', 'msg_a')] }],
      gate: async () => '{"decisions":[{"conversation_id":"conv_a","decision":"no_reply"}]}',
    })
    invoker.knock('connect')
    clock.advance(2000)
    await settle()
    expect(turns).toHaveLength(0)
    expect(invoker.turns).toBe(0)
  })

  it('an empty tray decides nothing and resets the ladder', async () => {
    const { clock, invoker, turns, settle } = make({ trays: [{ question: 'Q', conversations: [] }] })
    invoker.knock('connect')
    clock.advance(2000)
    await settle()
    expect(turns).toHaveLength(0)
    expect(invoker.counters().retryRung).toBe(0)
  })

  it('a knock landing during a cycle earns one more cycle (tray re-read)', async () => {
    let release!: () => void
    const gateAnswer = new Promise<string>((resolve) => {
      release = () => resolve('{"decisions":[{"conversation_id":"conv_a","decision":"dismiss"}]}')
    })
    const gate: GateCaller = () => gateAnswer
    const { clock, server, invoker, settle } = make({ trays: [{ question: 'Q', conversations: [card('conv_a', 'msg_a')] }], gate })
    invoker.knock('message')
    clock.advance(2000) // the cycle is in flight, parked on the gate
    invoker.knock('message') // mid-cycle
    clock.advance(2000)
    release()
    await settle()
    expect(server.inboxCalls()).toBe(2)
  })

  it('gate disabled → the turn starts with every card id and nothing is posted', async () => {
    const { clock, server, invoker, turns, settle } = make({
      trays: [{ question: 'Q', conversations: [card('conv_a', 'msg_a'), card('conv_b', 'msg_b')] }],
      gateEnabled: false,
    })
    invoker.knock('message')
    clock.advance(2000)
    await settle()
    expect(turns).toHaveLength(1)
    expect(turns[0]!.prompt).toMatch(/conv_a, conv_b/)
    expect(server.posts).toHaveLength(0)
  })

  it('truncated tray → knocks again for the rest', async () => {
    const { clock, server, invoker, settle } = make({
      trays: [
        { question: 'Q', conversations: [card('conv_a', 'msg_a')], truncated: true },
        { question: 'Q', conversations: [], truncated: false },
      ],
      gate: async () => '{"decisions":[{"conversation_id":"conv_a","decision":"dismiss"}]}',
    })
    invoker.knock('message')
    clock.advance(2000)
    await settle()
    expect(server.inboxCalls()).toBe(1)
    clock.advance(2000)
    await settle()
    expect(server.inboxCalls()).toBe(2)
  })
})

describe('AgentInvoker — failure policy and the ladder', () => {
  it('fail-closed: model down → nothing posted, no turn, re-knock at 60 s; one outage climbs one rung', async () => {
    const { clock, server, invoker, turns, settle } = make({
      trays: [{ question: 'Q', conversations: [card('conv_a', 'msg_a')] }],
      gate: async () => {
        throw new Error('provider down')
      },
    })
    invoker.knock('message')
    clock.advance(2000)
    await settle()
    expect(turns).toHaveLength(0)
    expect(server.posts).toHaveLength(0)
    expect(invoker.counters().retryRung).toBe(1)

    // A second knock mid-outage fails again but must NOT climb the ladder:
    // the 60 s re-knock is already on its way.
    invoker.knock('message')
    clock.advance(2000)
    await settle()
    expect(invoker.counters().retryRung).toBe(1)

    clock.advance(60_000 + 2000)
    await settle()
    expect(server.inboxCalls()).toBe(3)
    expect(invoker.counters().retryRung).toBe(2) // rung 2 (300 s) armed after the retry also failed
  })

  it('fail-closed recovers: once the model answers, the ladder resets', async () => {
    let healthy = false
    const { clock, invoker, turns, settle } = make({
      trays: [{ question: 'Q', conversations: [card('conv_a', 'msg_a')] }],
      gate: async () => {
        if (!healthy) throw new Error('down')
        return '{"decisions":[{"conversation_id":"conv_a","decision":"reply"}]}'
      },
    })
    invoker.knock('message')
    clock.advance(2000)
    await settle()
    healthy = true
    clock.advance(60_000 + 2000)
    await settle()
    expect(turns).toHaveLength(1)
    expect(invoker.counters().retryRung).toBe(0)
  })

  it('fail-open: model down → the turn still starts with every card', async () => {
    const { clock, invoker, turns, settle } = make({
      trays: [{ question: 'Q', conversations: [card('conv_a', 'msg_a')] }],
      gate: async () => 'garbage',
      failOpen: true,
    })
    invoker.knock('message')
    clock.advance(2000)
    await settle()
    expect(turns).toHaveLength(1)
    expect(turns[0]!.prompt).toMatch(/conv_a/)
  })

  it('tray read failure → re-knock on the ladder, then exhausted after the last rung', async () => {
    const { clock, server, invoker, settle } = make({ trays: [new Error('ECONNRESET')] })
    invoker.knock('message')
    clock.advance(2000)
    await settle()
    expect(invoker.counters().retryRung).toBe(1)
    clock.advance(60_000 + 2000)
    await settle()
    expect(invoker.counters().retryRung).toBe(2)
    clock.advance(300_000 + 2000)
    await settle()
    expect(invoker.counters().retryRung).toBe(3)
    clock.advance(1_800_000 + 2000)
    await settle()
    expect(server.inboxCalls()).toBe(4)
    // Ladder exhausted: nothing more is scheduled until the next knock.
    expect(clock.pending).toHaveLength(0)
  })

  it('a turn that could not start is counted as not run but does not crash the worker', async () => {
    const { clock, invoker, settle } = make({
      trays: [{ question: 'Q', conversations: [card('conv_a', 'msg_a')] }],
      gate: async () => '{"decisions":[{"conversation_id":"conv_a","decision":"reply"}]}',
      turn: async () => ({ ran: false, error: 'runtime unavailable' }),
    })
    invoker.knock('message')
    clock.advance(2000)
    await settle()
    expect(invoker.turns).toBe(0)
    expect(invoker.cycles).toBe(1)
  })
})

describe('AgentInvoker — group invites', () => {
  it('an invite is one turn with the fixed prompt, deduplicated by id, not gated', async () => {
    const { invoker, turns, settle, server } = make({ trays: [{ question: 'Q', conversations: [] }] })
    const invite = { kind: 'group-invite' as const, inviteId: 'inv_1', groupId: 'grp_1', groupName: 'Ops', inviterHandle: 'bob' }
    expect(invoker.groupInvite(invite, 'live')).toBe(true)
    expect(invoker.groupInvite(invite, 'catch-up')).toBe(false)
    await settle()
    expect(turns).toHaveLength(1)
    expect(turns[0]!.prompt).toMatch(/group invitation is pending/)
    expect(turns[0]!.sessionKey).toBe('agent:main:subagent:agentchat-invite-inv_1')
    expect(invoker.inviteTurns).toBe(1)
    expect(server.inboxCalls()).toBe(0)
  })

  it('stop() drops later knocks and invites', async () => {
    const { clock, invoker, turns, settle } = make({ trays: [{ question: 'Q', conversations: [card('conv_a', 'msg_a')] }] })
    invoker.stop()
    invoker.knock('message')
    expect(invoker.groupInvite({ kind: 'group-invite', inviteId: 'i', groupId: 'g', groupName: '', inviterHandle: '' }, 'live')).toBe(false)
    clock.advance(10_000)
    await settle()
    expect(turns).toHaveLength(0)
    expect(invoker.cycles).toBe(0)
  })
})
