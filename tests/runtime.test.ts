/**
 * Tests for AgentchatChannelRuntime — the socket as a knock.
 *
 * Strategy: the MockWebSocket pattern from `ws-client.test.ts`. We assert:
 *   - every successful HELLO is a connect knock
 *   - `message.new` from a peer is a message knock; our own echo is not
 *   - the body of a message is never needed (frames with no content knock too)
 *   - `group.invite.received` is handed to `onGroupInvite`; malformed ones dropped
 *   - typing / presence / read / unknown frames are not knocks
 *   - no frame is ever sent after HELLO (no ack)
 *   - handler errors never escape
 *   - `getHealth()` reports ack negotiation and counters
 *   - `stop()` closes and resolves
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { AgentchatChannelRuntime, type ChannelRuntimeHandlers } from '../src/runtime.js'
import { parseChannelConfig, type AgentchatChannelConfig } from '../src/config-schema.js'
import type { Logger } from '../src/log.js'

const VALID_KEY = 'ac_live_' + 'x'.repeat(20)

function makeConfig(overrides: Record<string, unknown> = {}): AgentchatChannelConfig {
  return parseChannelConfig({ apiKey: VALID_KEY, apiBase: 'https://api.agentchat.me', agentHandle: 'alice', ...overrides })
}

function silentLogger(): Logger {
  const noop = () => undefined
  return { trace: noop, debug: noop, info: noop, warn: noop, error: noop, child: () => silentLogger() }
}

const mockInstances: MockWebSocket[] = []

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = MockWebSocket.CONNECTING
  sent: string[] = []
  closedWith: { code: number; reason: string } | null = null
  constructor(public url: string, _opts?: unknown) {
    super()
    mockInstances.push(this)
  }
  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error('send on closed socket')
    this.sent.push(data)
  }
  ping(): void {}
  close(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.closedWith = { code, reason }
    this.emit('close', code, Buffer.from(reason))
  }
  doOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.emit('open')
  }
  doMessage(payload: unknown): void {
    this.emit('message', Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), false)
  }
}

function makeRuntime(handlers: ChannelRuntimeHandlers = {}, config = makeConfig(), extra: { logger?: Logger; now?: () => number } = {}) {
  const runtime = new AgentchatChannelRuntime({
    config,
    handlers,
    logger: extra.logger ?? silentLogger(),
    webSocketCtor: MockWebSocket as unknown as ConstructorParameters<typeof AgentchatChannelRuntime>[0]['webSocketCtor'],
    ...(extra.now ? { now: extra.now } : {}),
  })
  return runtime
}

function capturingLogger(): Logger & { lines: Array<{ level: string; msg: string | undefined; obj: object }> } {
  const lines: Array<{ level: string; msg: string | undefined; obj: object }> = []
  const log = (level: string) => (obj: object, msg?: string) => {
    lines.push({ level, msg, obj })
  }
  const logger = { lines, trace: log('trace'), debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'), child: () => logger }
  return logger as Logger & { lines: typeof lines }
}

function bringUpReady(runtime: AgentchatChannelRuntime, caps: string[] | null = ['ack']): MockWebSocket {
  runtime.start()
  const sock = mockInstances[mockInstances.length - 1]!
  sock.doOpen()
  sock.doMessage(caps ? { type: 'hello.ok', capabilities: caps } : { type: 'hello.ok', payload: {} })
  return sock
}

beforeEach(() => {
  mockInstances.length = 0
})

describe('AgentchatChannelRuntime — knocks', () => {
  it('a successful HELLO is a connect knock and reports ack negotiation', () => {
    const knocks: string[] = []
    const auth: number[] = []
    const runtime = makeRuntime({ onKnock: (s) => knocks.push(s), onAuthenticated: (at) => auth.push(at) })
    bringUpReady(runtime)
    expect(auth).toHaveLength(1)
    expect(knocks).toEqual(['connect'])
    expect(runtime.getHealth().authenticated).toBe(true)
    expect(runtime.getHealth().ackNegotiated).toBe(true)
  })

  it('a peer message.new is a message knock — the body is never required', () => {
    const knocks: string[] = []
    const runtime = makeRuntime({ onKnock: (s) => knocks.push(s) })
    const sock = bringUpReady(runtime)
    sock.doMessage({ type: 'message.new', payload: { id: 'msg_1', conversation_id: 'conv_1', sender: 'bob' } })
    sock.doMessage({ type: 'message.new', payload: { id: 'msg_2', conversation_id: 'grp_1', sender: '@carol', content: { text: 'secret' } } })
    expect(knocks).toEqual(['connect', 'message', 'message'])
    expect(runtime.getHealth().counters).toEqual({ frames: 2, selfFiltered: 0, knocks: 3, invites: 0 })
  })

  it('our own echo is not a knock', () => {
    const knocks: string[] = []
    const runtime = makeRuntime({ onKnock: (s) => knocks.push(s) })
    const sock = bringUpReady(runtime)
    sock.doMessage({ type: 'message.new', payload: { id: 'msg_1', conversation_id: 'conv_1', sender: 'alice' } })
    sock.doMessage({ type: 'message.new', payload: { id: 'msg_2', conversation_id: 'conv_1', sender: '@Alice' } })
    expect(knocks).toEqual(['connect'])
    expect(runtime.getHealth().counters.selfFiltered).toBe(2)
  })

  it('never sends a frame after HELLO — no ack, whatever arrives', () => {
    const runtime = makeRuntime({})
    const sock = bringUpReady(runtime)
    for (let i = 0; i < 10; i++) sock.doMessage({ type: 'message.new', payload: { id: `msg_${i}`, conversation_id: 'conv_1', sender: 'bob' } })
    expect(sock.sent).toHaveLength(1)
    expect(JSON.parse(sock.sent[0]!).type).toBe('hello')
  })

  it('group.invite.received is the second knock kind; malformed invites are dropped', () => {
    const invites: unknown[] = []
    const knocks: string[] = []
    const runtime = makeRuntime({ onGroupInvite: (i) => invites.push(i), onKnock: (s) => knocks.push(s) })
    const sock = bringUpReady(runtime)
    sock.doMessage({ type: 'group.invite.received', payload: { id: 'inv_1', group_id: 'grp_1', group_name: 'Ops', inviter_handle: '@bob', group_member_count: 3, created_at: 'x' } })
    sock.doMessage({ type: 'group.invite.received', payload: { group_name: 'no ids' } })
    expect(invites).toEqual([{ kind: 'group-invite', inviteId: 'inv_1', groupId: 'grp_1', groupName: 'Ops', inviterHandle: 'bob' }])
    expect(knocks).toEqual(['connect'])
    expect(runtime.getHealth().counters.invites).toBe(1)
  })

  it('typing, read receipts, presence, rate-limit and unknown frames are not knocks', () => {
    const knocks: string[] = []
    const runtime = makeRuntime({ onKnock: (s) => knocks.push(s) })
    const sock = bringUpReady(runtime)
    sock.doMessage({ type: 'typing.start', payload: { conversation_id: 'conv_1', sender: 'bob' } })
    sock.doMessage({ type: 'message.read', payload: { conversation_id: 'conv_1', through_seq: 3, reader: 'bob' } })
    sock.doMessage({ type: 'presence.update', payload: { handle: 'bob', status: 'online' } })
    sock.doMessage({ type: 'rate_limit.warning', payload: {} })
    sock.doMessage({ type: 'something.new', payload: {} })
    expect(knocks).toEqual(['connect'])
  })

  it('warns but still knocks against a legacy server that did not negotiate ack', () => {
    const knocks: string[] = []
    const runtime = makeRuntime({ onKnock: (s) => knocks.push(s) })
    bringUpReady(runtime, null)
    expect(runtime.getHealth().ackNegotiated).toBe(false)
    expect(knocks).toEqual(['connect'])
  })

  it('a throwing handler never takes the socket down', () => {
    let calls = 0
    const runtime = makeRuntime({
      onKnock: () => {
        calls += 1
        throw new Error('handler boom')
      },
    })
    const sock = bringUpReady(runtime)
    expect(() => sock.doMessage({ type: 'message.new', payload: { id: 'm', conversation_id: 'c', sender: 'bob' } })).not.toThrow()
    expect(calls).toBe(2)
    expect(runtime.getHealth().state.kind).toBe('READY')
  })

  it('frames within 5 s of a (re)connect are the backlog re-push: knocks at debug, not info', () => {
    let now = 1_000_000
    const logger = capturingLogger()
    const knocks: string[] = []
    const runtime = makeRuntime({ onKnock: (s) => knocks.push(s) }, makeConfig(), { logger, now: () => now })
    const sock = bringUpReady(runtime)
    for (let i = 0; i < 3; i++) sock.doMessage({ type: 'message.new', payload: { id: `old_${i}`, conversation_id: 'conv_1', sender: 'bob' } })
    now += 6_000
    sock.doMessage({ type: 'message.new', payload: { id: 'fresh', conversation_id: 'conv_1', sender: 'bob' } })
    const knockLines = logger.lines.filter((l) => l.msg === 'knock — message.new')
    expect(knockLines.map((l) => l.level)).toEqual(['debug', 'debug', 'debug', 'info'])
    expect(knocks).toEqual(['connect', 'message', 'message', 'message', 'message'])
  })

  it('a reconnect knocks again', () => {
    const knocks: string[] = []
    const runtime = makeRuntime({ onKnock: (s) => knocks.push(s) }, makeConfig({ reconnect: { initialBackoffMs: 100, maxBackoffMs: 1000, jitterRatio: 0 } }))
    const sock = bringUpReady(runtime)
    sock.close(1006, 'gone')
    expect(runtime.getHealth().authenticated).toBe(false)
    expect(knocks).toEqual(['connect'])
  })
})

describe('AgentchatChannelRuntime — lifecycle', () => {
  it('start() is idempotent', () => {
    const runtime = makeRuntime()
    runtime.start()
    runtime.start()
    expect(mockInstances).toHaveLength(1)
  })

  it('stop() closes the socket and resolves; repeated calls return the same promise', async () => {
    const transitions: string[] = []
    const runtime = makeRuntime({ onStateChanged: (s) => transitions.push(s.kind) })
    bringUpReady(runtime)
    const p1 = runtime.stop()
    const p2 = runtime.stop()
    expect(p1).toBe(p2)
    await p1
    expect(runtime.getHealth().state.kind).toBe('CLOSED')
    expect(transitions).toContain('CLOSED')
  })

  it('onError fires on a malformed frame and a throwing onError is swallowed', () => {
    const errs: string[] = []
    const runtime = makeRuntime({
      onError: (e) => {
        errs.push(e.class_)
        throw new Error('boom')
      },
    })
    const sock = bringUpReady(runtime)
    expect(() => sock.doMessage('not-json-at-all')).not.toThrow()
    expect(errs).toContain('validation')
  })
})
