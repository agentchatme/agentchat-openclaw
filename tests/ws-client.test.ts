/**
 * Unit tests for the AgentChat WS client.
 *
 * Strategy: we mock the `ws` package's `WebSocket` with a hand-rolled
 * `MockWebSocket` that exposes `open()/message()/close()/pong()` control
 * methods the test drives. We also substitute the timer functions so
 * reconnect backoff and heartbeat behavior is deterministic and fast.
 *
 * What we cover:
 *   - Happy path: open → HELLO → hello.ok → READY, inbound frame delivery
 *   - Auth failure: a server-sent rejection → AUTH_FAIL + terminal-auth
 *     error, then a slow retry that clears on the next hello.ok
 *   - Our own closes (hello-ack timeout, ping timeout) are never auth
 *   - Reconnect: close → exponential backoff → second attempt, forever
 *   - Heartbeat: ping at interval, pong clears timer, miss → PING_TIMEOUT
 *   - Graceful drain: stop(deadline) moves to DRAINING, then CLOSED, and
 *     stop() is the only thing that ends the client
 *   - Malformed inbound → validation error, connection stays up
 *   - Ack capability: HELLO advertises `ack`; the client never acknowledges
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { AgentchatWsClient } from '../src/ws-client.js'
import { parseChannelConfig, type AgentchatChannelConfig } from '../src/config-schema.js'
import type { Logger } from '../src/log.js'
import { createNoopMetrics } from '../src/metrics.js'
import { PACKAGE_VERSION } from '../src/version.js'

const VALID_KEY = 'ac_live_' + 'x'.repeat(20)

function makeConfig(overrides: Record<string, unknown> = {}): AgentchatChannelConfig {
  return parseChannelConfig({
    apiKey: VALID_KEY,
    apiBase: 'https://api.agentchat.me',
    ...overrides,
  })
}

function silentLogger(): Logger {
  const noop = () => undefined
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => silentLogger(),
  }
}

// ─── Mock WebSocket ────────────────────────────────────────────────────
//
// Implements the subset of `ws.WebSocket` our client actually uses:
// constructor(url, opts), readyState, on('open'|'message'|'pong'|'close'|'error'),
// send(str), ping(), close(code, reason).

const mockInstances: MockWebSocket[] = []

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = MockWebSocket.CONNECTING
  sent: string[] = []
  pinged = 0
  closedWith: { code: number; reason: string } | null = null
  url: string
  constructor(url: string, _opts?: unknown) {
    super()
    this.url = url
    mockInstances.push(this)
  }
  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      // simulate write-after-close
      throw new Error('send on closed socket')
    }
    this.sent.push(data)
  }
  ping(): void {
    this.pinged += 1
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.closedWith = { code, reason }
    // 'close' fires asynchronously like the real thing, but we call it
    // synchronously in tests so assertions can run without awaiting.
    this.emit('close', code, Buffer.from(reason))
  }
  // Test helpers
  doOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.emit('open')
  }
  doMessage(payload: unknown, isBinary = false): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
    this.emit('message', Buffer.from(data), isBinary)
  }
  doPong(): void {
    this.emit('pong')
  }
  doError(err: Error): void {
    this.emit('error', err)
  }
}

// ─── Fake timers ───────────────────────────────────────────────────────

interface ScheduledTimeout {
  id: number
  fireAt: number
  fn: () => void
  kind: 'timeout' | 'interval'
  intervalMs?: number
}

class TimerHarness {
  now = 0
  private next = 1
  private pending: ScheduledTimeout[] = []
  setTimeout = (fn: () => void, ms: number): NodeJS.Timeout => {
    const t: ScheduledTimeout = {
      id: this.next++,
      fireAt: this.now + ms,
      fn,
      kind: 'timeout',
    }
    this.pending.push(t)
    return t.id as unknown as NodeJS.Timeout
  }
  clearTimeout = (h: NodeJS.Timeout): void => {
    this.pending = this.pending.filter((t) => (t.id as unknown as NodeJS.Timeout) !== h)
  }
  setInterval = (fn: () => void, ms: number): NodeJS.Timeout => {
    const t: ScheduledTimeout = {
      id: this.next++,
      fireAt: this.now + ms,
      fn,
      kind: 'interval',
      intervalMs: ms,
    }
    this.pending.push(t)
    return t.id as unknown as NodeJS.Timeout
  }
  clearInterval = (h: NodeJS.Timeout): void => {
    this.clearTimeout(h)
  }
  advance(ms: number): void {
    const target = this.now + ms
    // Process events in fire-time order until we reach target.
    while (true) {
      this.pending.sort((a, b) => a.fireAt - b.fireAt)
      const next = this.pending[0]
      if (!next || next.fireAt > target) break
      this.now = next.fireAt
      this.pending.shift()
      next.fn()
      if (next.kind === 'interval' && next.intervalMs) {
        this.pending.push({ ...next, fireAt: this.now + next.intervalMs })
      }
    }
    this.now = target
  }
}

beforeEach(() => {
  mockInstances.length = 0
})

afterEach(() => {
  mockInstances.length = 0
})

function makeClient(cfg?: Partial<Record<string, unknown>>) {
  const timers = new TimerHarness()
  const client = new AgentchatWsClient({
    config: makeConfig(cfg),
    logger: silentLogger(),
    metrics: createNoopMetrics(),
    now: () => timers.now,
    webSocketCtor: MockWebSocket as unknown as typeof import('ws').WebSocket,
    random: () => 0.5,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  })
  return { client, timers }
}

function makeClientWithLogs(cfg?: Partial<Record<string, unknown>>) {
  const logs: Array<{ level: string; msg: string | undefined }> = []
  const log = (level: string) => (_obj: object, msg?: string) => {
    logs.push({ level, msg })
  }
  const logger: Logger = { trace: log('trace'), debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'), child: () => logger }
  const timers = new TimerHarness()
  const client = new AgentchatWsClient({
    config: makeConfig(cfg),
    logger,
    metrics: createNoopMetrics(),
    now: () => timers.now,
    webSocketCtor: MockWebSocket as unknown as typeof import('ws').WebSocket,
    random: () => 0.5,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  })
  return { client, timers, logs }
}

describe('AgentchatWsClient — happy path', () => {
  it('transitions DISCONNECTED → CONNECTING → AUTHENTICATING → READY and emits authenticated', () => {
    const { client } = makeClient()
    const states: string[] = []
    const auths: number[] = []
    client.on('stateChanged', (next) => states.push(next.kind))
    client.on('authenticated', (at) => auths.push(at))

    expect(client.getState().kind).toBe('DISCONNECTED')
    client.start()
    expect(client.getState().kind).toBe('CONNECTING')
    expect(mockInstances.length).toBe(1)

    const sock = mockInstances[0]!
    sock.doOpen()
    expect(client.getState().kind).toBe('AUTHENTICATING')
    // HELLO was sent on open
    expect(sock.sent).toHaveLength(1)
    expect(JSON.parse(sock.sent[0]!)).toEqual({
      type: 'hello',
      capabilities: ['ack'],
      api_key: VALID_KEY,
      client: 'openclaw',
      client_version: PACKAGE_VERSION,
    })

    sock.doMessage({ type: 'hello.ok', payload: {} })
    expect(client.getState().kind).toBe('READY')
    expect(states).toEqual(['CONNECTING', 'AUTHENTICATING', 'READY'])
    expect(auths).toHaveLength(1)
  })

  it('delivers inbound frames to subscribers after HELLO_OK', () => {
    const { client } = makeClient()
    const frames: unknown[] = []
    client.on('inboundFrame', (f) => frames.push(f))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })

    sock.doMessage({
      type: 'message.new',
      payload: { id: 'msg_1', seq: 1, content: { text: 'hi' } },
    })

    expect(frames).toHaveLength(1)
    const frame = frames[0] as { type: string; payload: Record<string, unknown> }
    expect(frame.type).toBe('message.new')
    expect(frame.payload.id).toBe('msg_1')
  })

  it('does not deliver pre-hello frames to subscribers', () => {
    const { client } = makeClient()
    const frames: unknown[] = []
    client.on('inboundFrame', (f) => frames.push(f))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    // A server-sent event that arrives before hello.ok should be dropped.
    sock.doMessage({ type: 'message.new', payload: { id: 'surprise' } })
    expect(frames).toHaveLength(0)
  })

  it('HELLO advertises the ack capability and nothing else is ever sent', () => {
    const { client } = makeClient()
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    const hello = JSON.parse(sock.sent[0]!) as { type: string; capabilities?: unknown }
    expect(hello.type).toBe('hello')
    expect(hello.capabilities).toEqual(['ack'])
    sock.doMessage({ type: 'hello.ok', capabilities: ['ack'] })
    expect(client.ackNegotiated).toBe(true)
    // Three envelopes land; the doorbell must not acknowledge a single one.
    for (const id of ['msg_1', 'msg_2', 'msg_3']) {
      sock.doMessage({ type: 'message.new', payload: { id, conversation_id: 'conv_x', sender: 'peer' } })
    }
    expect(sock.sent).toHaveLength(1) // HELLO only
    expect(sock.sent.some((s) => JSON.parse(s).type === 'ack')).toBe(false)
  })

  it('a hello.ok without capabilities means a legacy server: ackNegotiated is false', () => {
    const { client } = makeClient()
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })
    expect(client.getState().kind).toBe('READY')
    expect(client.ackNegotiated).toBe(false)
  })

  it('ackNegotiated resets when the socket closes', () => {
    const { client } = makeClient()
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', capabilities: ['ack'] })
    expect(client.ackNegotiated).toBe(true)
    sock.close(1006, 'gone')
    expect(client.ackNegotiated).toBe(false)
  })

  it('the socket\'s own close after drainCompleted() is a no-op: one closed event, no invalid transition', () => {
    const { client, logs } = makeClientWithLogs()
    const closed: number[] = []
    client.on('closed', () => closed.push(1))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', capabilities: ['ack'] })
    client.stop()
    client.drainCompleted() // → CLOSED, emits closed, closes the socket (MockWebSocket.close emits 'close' synchronously)
    expect(client.getState().kind).toBe('CLOSED')
    expect(closed).toHaveLength(1)
    expect(logs.some((l) => l.msg === 'transition.invalid')).toBe(false)
    expect(logs.some((l) => l.msg === 'socket closed after CLOSED — no-op')).toBe(true)
  })

  it('exposes no API that could emit a client frame after HELLO', () => {
    const { client } = makeClient()
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
    // The only public surface is lifecycle + events. A `send` method would be
    // the one way an ack could ever leave this client.
    expect(proto).not.toContain('send')
    expect(proto).not.toContain('ack')
  })
})

// With random=0.5 the ±jitterRatio (default 0.2) factor is exactly 1.0, so
// the auth retry lands at its base interval of 12.5 minutes.
const AUTH_RETRY_MS = 750_000

describe('AgentchatWsClient — auth failure', () => {
  it('moves to AUTH_FAIL on hello.error, emits terminal-auth, and retries later', () => {
    const { client, timers } = makeClient()
    const errors: { class_: string; message: string }[] = []
    client.on('error', (e) => errors.push({ class_: e.class_, message: e.message }))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({
      type: 'hello.error',
      payload: { message: 'invalid api key' },
    })
    expect(client.getState().kind).toBe('AUTH_FAIL')
    expect(errors.some((e) => e.class_ === 'terminal-auth')).toBe(true)
    // We hang up on a rejection frame with a normal close, not a policy code.
    expect(sock.closedWith?.code).toBe(1000)
    // The slow retry is scheduled even on this path.
    timers.advance(AUTH_RETRY_MS - 1)
    expect(mockInstances).toHaveLength(1)
    timers.advance(1)
    expect(mockInstances).toHaveLength(2)
    expect(client.getState().kind).toBe('CONNECTING')
  })

  it('a server close 1008 during the handshake moves to AUTH_FAIL, retries every 10–15 min, and a later hello.ok clears it', () => {
    const { client, timers } = makeClient()
    const states: string[] = []
    const errors: string[] = []
    const auths: number[] = []
    const closed: number[] = []
    client.on('stateChanged', (s) => states.push(s.kind))
    client.on('error', (e) => errors.push(e.class_))
    client.on('authenticated', (at) => auths.push(at))
    client.on('closed', () => closed.push(1))

    client.start()
    mockInstances[0]!.doOpen()
    mockInstances[0]!.close(1008, 'Invalid token')
    expect(client.getState().kind).toBe('AUTH_FAIL')
    expect(errors).toContain('terminal-auth')
    // AUTH_FAIL is not CLOSED: the client is waiting, not gone.
    expect(closed).toHaveLength(0)

    // Not the fast backoff (1 s) — the slow cadence.
    timers.advance(60_000)
    expect(mockInstances).toHaveLength(1)
    timers.advance(AUTH_RETRY_MS - 60_000)
    expect(mockInstances).toHaveLength(2)
    expect(client.getState().kind).toBe('CONNECTING')

    // Still rejected → back to AUTH_FAIL, another slow retry.
    mockInstances[1]!.doOpen()
    mockInstances[1]!.close(1008, 'Invalid token')
    expect(client.getState().kind).toBe('AUTH_FAIL')
    timers.advance(AUTH_RETRY_MS)
    expect(mockInstances).toHaveLength(3)

    // The account was reinstated: this HELLO succeeds and the client is READY.
    mockInstances[2]!.doOpen()
    mockInstances[2]!.doMessage({ type: 'hello.ok', capabilities: ['ack'] })
    expect(client.getState().kind).toBe('READY')
    expect(auths).toHaveLength(1)
    expect(client.ackNegotiated).toBe(true)

    // Recovery reset the attempt counter: a network drop now uses the fast
    // backoff again (initialBackoffMs 1000, jitter factor 1.0).
    mockInstances[2]!.close(1006, 'gone')
    expect(client.getState().kind).toBe('DISCONNECTED')
    timers.advance(1000)
    expect(mockInstances).toHaveLength(4)
    expect(states).not.toContain('CLOSED')
  })

  it('logs the rejection once at error level, then at debug while it persists', () => {
    const { client, timers, logs } = makeClientWithLogs()
    client.start()
    for (let i = 0; i < 3; i++) {
      const sock = mockInstances[mockInstances.length - 1]!
      sock.doOpen()
      sock.close(1008, 'Invalid token')
      expect(client.getState().kind).toBe('AUTH_FAIL')
      timers.advance(AUTH_RETRY_MS)
    }
    const rejected = logs.filter((l) => l.msg?.startsWith('auth rejected'))
    expect(rejected.map((l) => l.level)).toEqual(['error', 'debug', 'debug'])
  })

  it('an eviction after hello.ok (key rotated, account suspended) takes the normal reconnect; the next HELLO decides', () => {
    const { client, timers } = makeClient()
    client.start()
    mockInstances[0]!.doOpen()
    mockInstances[0]!.doMessage({ type: 'hello.ok', capabilities: ['ack'] })
    expect(client.getState().kind).toBe('READY')

    mockInstances[0]!.close(1008, 'API key rotated')
    expect(client.getState().kind).toBe('DISCONNECTED')
    timers.advance(1000)
    expect(mockInstances).toHaveLength(2)

    // The old key is really gone: the handshake is rejected → slow retry.
    mockInstances[1]!.doOpen()
    mockInstances[1]!.close(1008, 'Invalid token')
    expect(client.getState().kind).toBe('AUTH_FAIL')
    timers.advance(AUTH_RETRY_MS - 1)
    expect(mockInstances).toHaveLength(2)
    timers.advance(1)
    expect(mockInstances).toHaveLength(3)
  })

  it('reconfigured() in AUTH_FAIL retries at once and cancels the slow timer', () => {
    const { client, timers } = makeClient()
    client.start()
    mockInstances[0]!.doOpen()
    mockInstances[0]!.close(1008, 'Invalid token')
    expect(client.getState().kind).toBe('AUTH_FAIL')
    client.reconfigured()
    expect(client.getState().kind).toBe('CONNECTING')
    expect(mockInstances).toHaveLength(2)
    // The slow timer was cancelled: nothing else opens while this attempt is pending.
    timers.advance(AUTH_RETRY_MS * 2)
    expect(mockInstances).toHaveLength(2)
  })

  it('start() in AUTH_FAIL is a no-op: the retry already pending is the plan', () => {
    const { client, timers } = makeClient()
    client.start()
    mockInstances[0]!.doOpen()
    mockInstances[0]!.close(1008, 'Invalid token')
    expect(() => client.start()).not.toThrow()
    expect(client.getState().kind).toBe('AUTH_FAIL')
    expect(mockInstances).toHaveLength(1)
    timers.advance(AUTH_RETRY_MS)
    expect(mockInstances).toHaveLength(2)
  })
})

describe('AgentchatWsClient — our own closes are never auth', () => {
  it('hello-ack timeout schedules a reconnect with backoff, never AUTH_FAIL', () => {
    const { client, timers } = makeClient({
      reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0 },
    })
    const states: string[] = []
    const errors: string[] = []
    const closed: number[] = []
    client.on('stateChanged', (s) => states.push(s.kind))
    client.on('error', (e) => errors.push(e.class_))
    client.on('closed', () => closed.push(1))

    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    expect(client.getState().kind).toBe('AUTHENTICATING')

    // No hello.ok within 4 s: we hang up ourselves.
    timers.advance(4000)
    expect(sock.closedWith?.reason).toBe('hello ack timeout')
    expect(sock.closedWith?.code).not.toBe(1008)
    expect(client.getState().kind).toBe('DISCONNECTED')
    expect(states).not.toContain('AUTH_FAIL')
    expect(errors).toContain('retry-transient')
    expect(errors).not.toContain('terminal-auth')
    expect(closed).toHaveLength(0)

    // The normal backoff: a second attempt 1 s later, which succeeds.
    timers.advance(1000)
    expect(mockInstances).toHaveLength(2)
    mockInstances[1]!.doOpen()
    mockInstances[1]!.doMessage({ type: 'hello.ok', capabilities: ['ack'] })
    expect(client.getState().kind).toBe('READY')
  })

  it('repeated hello-ack timeouts keep backing off and reconnecting', () => {
    const { client, timers } = makeClient({
      reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0 },
    })
    client.start()
    for (let i = 0; i < 5; i++) {
      const sock = mockInstances[mockInstances.length - 1]!
      sock.doOpen()
      timers.advance(4000) // hello-ack timeout → our close
      expect(client.getState().kind).toBe('DISCONNECTED')
      timers.advance(1000 * 2 ** i) // 1 s, 2 s, 4 s, 8 s, 16 s
      expect(mockInstances).toHaveLength(i + 2)
    }
    expect(client.getState().kind).toBe('CONNECTING')
  })

  it('a close we initiated with an auth code is still ours (defence in depth)', () => {
    // No production path sends 1008 from the client any more; this pins the
    // rule that the classification is by origin, not by code.
    const { client, timers } = makeClient()
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    // Reach into the private helper: it is the one place that marks a close as ours.
    ;(client as unknown as { closeSocket: (code: number, reason: string) => void }).closeSocket(1008, 'ours')
    expect(client.getState().kind).toBe('DISCONNECTED')
    timers.advance(1000)
    expect(mockInstances).toHaveLength(2)
  })
})

describe('AgentchatWsClient — reconnect', () => {
  it('schedules reconnect on unexpected close and connects again', () => {
    const { client, timers } = makeClient()
    client.start()
    const sock1 = mockInstances[0]!
    sock1.doOpen()
    sock1.doMessage({ type: 'hello.ok', payload: {} })
    expect(client.getState().kind).toBe('READY')

    // Simulate server-initiated close
    sock1.close(1006, 'abnormal')
    expect(client.getState().kind).toBe('DISCONNECTED')

    // initialBackoffMs default 1000, with random=0.5 and jitterRatio 0.2 →
    // 1 * (1 - 0.2 + 0.5 * 0.4) = 1.0 of initial = 1000ms
    timers.advance(1000)
    expect(mockInstances.length).toBe(2)
    expect(client.getState().kind).toBe('CONNECTING')
  })

  it('applies exponential backoff: attempt 2 waits ~2000ms', () => {
    const { client, timers } = makeClient({
      reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0 },
    })
    client.start()
    mockInstances[0]!.close(1006, 'abnormal')
    // First backoff (attempt 1): 1000 * 2^0 = 1000
    timers.advance(1000)
    expect(mockInstances.length).toBe(2)
    mockInstances[1]!.close(1006, 'abnormal')
    // Second backoff (attempt 2): 1000 * 2^1 = 2000
    timers.advance(1999)
    expect(mockInstances.length).toBe(2) // not yet
    timers.advance(1)
    expect(mockInstances.length).toBe(3)
  })

  it('caps backoff at maxBackoffMs', () => {
    const { client, timers } = makeClient({
      reconnect: { initialBackoffMs: 1000, maxBackoffMs: 5000, jitterRatio: 0 },
    })
    client.start()
    // Drop through enough attempts to saturate — attempt 10 without cap
    // would be 512000ms; cap pins it at 5000.
    for (let i = 0; i < 10; i++) {
      mockInstances[mockInstances.length - 1]!.close(1006, 'abnormal')
      timers.advance(5000)
    }
    expect(mockInstances.length).toBeGreaterThan(5)
  })
})

describe('AgentchatWsClient — heartbeat', () => {
  it('sends ping at interval and clears pong timer on pong', () => {
    const { client, timers } = makeClient({ ping: { intervalMs: 5000, timeoutMs: 2000 } })
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })
    expect(sock.pinged).toBe(0)
    timers.advance(5000)
    expect(sock.pinged).toBe(1)
    sock.doPong()
    // pong cleared the timer — no timeout fires
    timers.advance(5000)
    expect(sock.pinged).toBe(2)
    expect(client.getState().kind).toBe('READY')
  })

  it('force-closes on ping timeout and reconnects', () => {
    const { client, timers } = makeClient({ ping: { intervalMs: 5000, timeoutMs: 2000 } })
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })
    timers.advance(5000)
    expect(sock.pinged).toBe(1)
    // No pong — after timeoutMs we transition DEGRADED + close.
    timers.advance(2000)
    // Close code 1011 (our signal for ping timeout), then reconnect is scheduled.
    expect(client.getState().kind).toBe('DISCONNECTED')
    expect(sock.closedWith?.code).toBe(1011)
  })
})

describe('AgentchatWsClient — drain', () => {
  it('stop() in READY moves to DRAINING, then CLOSED on drainCompleted', () => {
    const { client } = makeClient()
    const events: string[] = []
    client.on('stateChanged', (s) => events.push(s.kind))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })

    client.stop(Date.now() + 10_000)
    expect(client.getState().kind).toBe('DRAINING')
    client.drainCompleted()
    expect(client.getState().kind).toBe('CLOSED')
    expect(events).toContain('DRAINING')
    expect(events).toContain('CLOSED')
  })

  it('stop() in DISCONNECTED moves directly to CLOSED', () => {
    const { client } = makeClient()
    client.stop()
    expect(client.getState().kind).toBe('CLOSED')
  })

  it('drain deadline forces close', () => {
    const { client, timers } = makeClient()
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })

    client.stop(timers.now + 1000)
    expect(client.getState().kind).toBe('DRAINING')
    timers.advance(1000)
    expect(client.getState().kind).toBe('CLOSED')
    expect(sock.closedWith?.code).toBe(1000)
  })
})

describe('AgentchatWsClient — malformed inbound', () => {
  it('emits validation error on non-JSON frame but stays connected', () => {
    const { client } = makeClient()
    const errors: string[] = []
    client.on('error', (e) => errors.push(e.class_))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })
    sock.doMessage('not-json-at-all')
    expect(errors).toContain('validation')
    expect(client.getState().kind).toBe('READY')
  })

  it('drops frame missing type field', () => {
    const { client } = makeClient()
    const frames: unknown[] = []
    const errors: string[] = []
    client.on('inboundFrame', (f) => frames.push(f))
    client.on('error', (e) => errors.push(e.class_))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })
    sock.doMessage({ payload: { foo: 'bar' } })
    expect(frames).toHaveLength(0)
    expect(errors).toContain('validation')
  })
})

describe('AgentchatWsClient — a long outage never ends the client', () => {
  const LONG_OUTAGE_CAP_MS = 5 * 60_000

  it('keeps reconnecting past 60 failed attempts with the cap widened to 5 minutes, logging one error line', () => {
    const { client, timers, logs } = makeClientWithLogs({
      reconnect: { initialBackoffMs: 100, maxBackoffMs: 1000, jitterRatio: 0 },
    })
    const states: string[] = []
    client.on('stateChanged', (s) => states.push(s.kind))
    client.start()

    // Attempts 1..60 fail before hello.ok. Backoff saturates at 1 s.
    for (let i = 0; i < 60; i++) {
      mockInstances[mockInstances.length - 1]!.close(1006, 'flap')
      timers.advance(1000)
    }
    // Attempt 61 is scheduled with the long-outage cap, so 1 s was not enough.
    expect(mockInstances).toHaveLength(60)
    expect(client.getState().kind).toBe('DISCONNECTED')
    timers.advance(LONG_OUTAGE_CAP_MS - 1000 - 1)
    expect(mockInstances).toHaveLength(60)
    timers.advance(1)
    expect(mockInstances).toHaveLength(61)
    expect(client.getState().kind).toBe('CONNECTING')

    // And it goes on: attempts 62..70, each 5 minutes apart.
    for (let i = 0; i < 9; i++) {
      mockInstances[mockInstances.length - 1]!.close(1006, 'flap')
      timers.advance(LONG_OUTAGE_CAP_MS)
    }
    expect(mockInstances).toHaveLength(70)
    expect(client.getState().kind).toBe('CONNECTING')
    expect(states).not.toContain('AUTH_FAIL')
    expect(states).not.toContain('CLOSED')

    const stillReconnecting = logs.filter((l) => l.msg?.startsWith('still reconnecting after'))
    expect(stillReconnecting).toHaveLength(1)
    expect(stillReconnecting[0]!.level).toBe('error')

    // The server is back: one hello.ok and everything is reset.
    mockInstances[69]!.doOpen()
    mockInstances[69]!.doMessage({ type: 'hello.ok', capabilities: ['ack'] })
    expect(client.getState().kind).toBe('READY')
    mockInstances[69]!.close(1006, 'flap')
    timers.advance(100) // initialBackoffMs again, not 5 minutes
    expect(mockInstances).toHaveLength(71)
  })

  it('a configured maxBackoffMs above 5 minutes is respected as the long-outage cap', () => {
    const { client, timers } = makeClient({
      reconnect: { initialBackoffMs: 10_000, maxBackoffMs: 300_000, jitterRatio: 0 },
    })
    client.start()
    for (let i = 0; i < 61; i++) {
      mockInstances[mockInstances.length - 1]!.close(1006, 'flap')
      timers.advance(300_000)
    }
    expect(mockInstances).toHaveLength(62)
  })
})

describe('AgentchatWsClient — only stop() ends the client', () => {
  it('stop() in AUTH_FAIL moves to CLOSED, emits closed once, and no socket opens afterwards', () => {
    const { client, timers } = makeClient()
    const closed: number[] = []
    client.on('closed', () => closed.push(1))
    client.start()
    mockInstances[0]!.doOpen()
    mockInstances[0]!.close(1008, 'Invalid token')
    expect(client.getState().kind).toBe('AUTH_FAIL')

    client.stop()
    expect(client.getState().kind).toBe('CLOSED')
    expect(closed).toHaveLength(1)
    timers.advance(AUTH_RETRY_MS * 3)
    expect(mockInstances).toHaveLength(1)
    expect(() => client.start()).toThrow(/closed/)
  })

  it('stop() while a backoff is pending cancels it: no socket opens after closed', () => {
    const { client, timers } = makeClient({
      reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0 },
    })
    const closed: number[] = []
    client.on('closed', () => closed.push(1))
    client.start()
    mockInstances[0]!.close(1006, 'gone')
    expect(client.getState().kind).toBe('DISCONNECTED')

    client.stop()
    expect(client.getState().kind).toBe('CLOSED')
    expect(closed).toHaveLength(1)
    timers.advance(60_000)
    expect(mockInstances).toHaveLength(1)
  })

  it('start() while a backoff is pending does not open a second socket', () => {
    const { client, timers } = makeClient({
      reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0 },
    })
    client.start()
    mockInstances[0]!.close(1006, 'gone')
    client.start()
    expect(mockInstances).toHaveLength(1)
    timers.advance(1000)
    expect(mockInstances).toHaveLength(2)
  })
})
