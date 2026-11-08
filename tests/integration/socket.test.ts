/**
 * The socket's lifecycle binding over the real SDK `RealtimeClient`, with a
 * mock WebSocket underneath (wakes are the kit's receive loop's — see
 * `loop.test.ts`):
 *   - the OpenClaw HELLO offers ack, heartbeat and rewake; an accepted HELLO
 *     is `connected` and `ready`;
 *   - server wake frames are labelled by reason for the metric, never acked;
 *   - the SDK's lifecycle is reported as it is: `ready` / `backoff` /
 *     `blocked` / `stopped` from its state, a rejected key from its
 *     `blocked` event (the SDK, not the plugin, tells it from a plain close
 *     and retries it 10–15 min later);
 *   - handler errors never escape; the stop is final.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseChannelConfig } from '../../src/config-schema.js'
import {
  IntegrationSocket,
  classifyRealtimeError,
  realtimeOptionsFor,
  wakeSourceOf,
  type SocketBlocked,
  type SocketHandlers,
} from '../../src/integration/socket.js'
import type { MetricsRecorder } from '../../src/metrics.js'
import { PACKAGE_VERSION } from '../../src/version.js'
import { MockWebSocket, MockWebSocketCtor, messageNew, sentFrames, settle, wakeFrame } from '../helpers/mock-websocket.js'
import { silentLogger } from '../helpers/logger.js'

const KEY = 'ac_live_' + 'w'.repeat(24)

function recordingMetrics(): MetricsRecorder & { states: string[]; wakes: string[]; disconnects: string[]; errors: string[] } {
  const m = {
    states: [] as string[],
    wakes: [] as string[],
    disconnects: [] as string[],
    errors: [] as string[],
    setConnectionState: (kind: string) => void m.states.push(kind),
    incWake: ({ source }: { source: string }) => void m.wakes.push(source),
    incDisconnect: ({ code, initiator }: { code: string; initiator: string }) => void m.disconnects.push(`${code}:${initiator}`),
    incError: ({ errorClass }: { errorClass: string }) => void m.errors.push(errorClass),
  }
  return m
}

function makeSocket(handlers: SocketHandlers = {}, configOverrides: Record<string, unknown> = {}) {
  const config = parseChannelConfig({
    apiKey: KEY,
    apiBase: 'https://api.agentchat.me',
    agentHandle: 'alice',
    reconnect: { initialBackoffMs: 100, maxBackoffMs: 1000, jitterRatio: 0.2 },
    ...configOverrides,
  })
  const metrics = recordingMetrics()
  const socket = new IntegrationSocket({ config, logger: silentLogger, handlers, metrics, webSocket: MockWebSocketCtor })
  return { socket, metrics, config }
}

/** What the receive loop does with the client: bind, then connect. */
async function start(socket: IntegrationSocket): Promise<void> {
  socket.bind()
  await socket.realtime.connect()
}

/** What the registry does on stop: the loop disconnects, then the binding reports `stopped`. */
function stop(socket: IntegrationSocket): void {
  socket.realtime.disconnect()
  socket.stopped()
}

const sockets: IntegrationSocket[] = []
beforeEach(() => MockWebSocket.reset())
afterEach(() => {
  for (const s of sockets.splice(0)) stop(s)
})

describe('IntegrationSocket — HELLO and wake frames', () => {
  it('the OpenClaw HELLO offers heartbeat and rewake, and ack once a message handler is attached (the loop attaches one); an accepted HELLO is `connected`, `ready`, and the connect metric', async () => {
    const connected: number[] = []
    const { socket, metrics } = makeSocket({ onConnected: (at) => connected.push(at) })
    sockets.push(socket)
    socket.realtime.on('message.new', () => undefined) // the receive loop's handler, standing in
    await start(socket)
    const ws = MockWebSocket.latest()
    expect(ws.url).toBe('wss://api.agentchat.me/v1/ws')
    ws.simulateOpen()
    const hello = sentFrames(ws, 'hello')[0]!
    // Contract v1: ack, plus heartbeat and rewake (the server's re-wake replaces any local retry ladder).
    expect(hello).toMatchObject({ api_key: KEY, capabilities: ['ack', 'heartbeat', 'rewake'], client: 'openclaw', client_version: PACKAGE_VERSION })
    expect(socket.getHealth().state).toBe('connecting')
    ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack', 'heartbeat', 'rewake'] })
    expect(connected).toHaveLength(1)
    expect(socket.getHealth().state).toBe('ready')
    expect(metrics.states).toEqual(['idle', 'connecting', 'ready'])
    expect(metrics.wakes).toEqual(['connect'])
  })

  it('without a message handler the SDK offers no ack (a handler-less client is marked on send)', async () => {
    const { socket } = makeSocket()
    sockets.push(socket)
    await start(socket)
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    expect(sentFrames(ws, 'hello')[0]!.capabilities).toEqual(['heartbeat', 'rewake'])
  })

  it('server wake frames are labelled by their reason (reminder, unanswered, other) for the metric, and never acked', async () => {
    const { socket, metrics } = makeSocket()
    sockets.push(socket)
    await start(socket)
    const ws = MockWebSocket.latest()
    ws.simulateReady(['ack', 'heartbeat', 'rewake']) // the contract-v1 wake shapes hold once rewake is echoed
    ws.simulateMessage(wakeFrame('conv_9', 2))
    ws.simulateMessage({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: ['conv_1', 'conv_2'], step: 1, at: '2026-11-08T00:00:00.000Z' } })
    ws.simulateMessage({ ...wakeFrame('conv_10'), payload: { ...(wakeFrame('conv_10').payload as object), reason: 'something-new' } })
    await settle()
    expect(metrics.wakes).toEqual(['connect', 'reminder', 'unanswered', 'other'])
    expect(sentFrames(ws, 'ack')).toEqual([])
    expect(socket.getHealth().counters.wakeFrames).toBe(3)
  })

  it('the binding attaches no message handler, so nothing is acked until the receive loop attaches its own (the SDK never acks unhandled)', async () => {
    const { socket } = makeSocket()
    sockets.push(socket)
    await start(socket)
    const ws = MockWebSocket.latest()
    ws.simulateReady()
    ws.simulateMessage(messageNew('conv_1', 1, { sender: '@bob' }))
    await settle()
    expect(sentFrames(ws, 'ack')).toEqual([])
  })

  it('a throwing handler never takes the socket down', async () => {
    const { socket } = makeSocket({
      onConnected: () => {
        throw new Error('handler boom')
      },
    })
    sockets.push(socket)
    await start(socket)
    MockWebSocket.latest().simulateReady()
    await settle()
    expect(socket.getHealth().state).toBe('ready')
  })
})

describe('IntegrationSocket — the SDK lifecycle, reported as it is', () => {
  it('a plain close is `backoff`; the SDK reconnects on its own and the next accepted HELLO is `ready` again', async () => {
    const events: string[] = []
    const { socket, metrics } = makeSocket({
      onDisconnected: (info) => events.push(`disconnected:${info.code}:${info.initiator}`),
      onConnected: () => events.push('connected'),
      onBlocked: () => events.push('blocked'),
      onStateChanged: (next) => events.push(`state:${next}`),
    })
    sockets.push(socket)
    await start(socket)
    MockWebSocket.latest().simulateReady()
    MockWebSocket.latest().simulateClose(1006, 'abnormal')
    expect(socket.getHealth().state).toBe('backoff')
    await new Promise((r) => setTimeout(r, 300)) // > initialBackoffMs with jitter
    expect(MockWebSocket.instances).toHaveLength(2)
    MockWebSocket.latest().simulateReady()
    expect(events).toEqual([
      'state:connecting',
      'state:ready',
      'connected',
      'disconnected:1006:server',
      'state:backoff',
      'state:connecting',
      'state:ready',
      'connected',
    ])
    expect(metrics.disconnects).toEqual(['1006:server'])
    expect(metrics.states).toEqual(['idle', 'connecting', 'ready', 'backoff', 'connecting', 'ready'])
    expect(metrics.errors).toEqual([])
    expect(socket.getHealth().counters.disconnects).toBe(1)
  })

  it("a 1008 without the server's auth reason (its own HELLO timer) is a plain close: `backoff`, never `blocked`", async () => {
    const blocked: SocketBlocked[] = []
    const { socket, metrics } = makeSocket({ onBlocked: (info) => blocked.push(info) })
    sockets.push(socket)
    await start(socket)
    MockWebSocket.latest().simulateOpen()
    MockWebSocket.latest().simulateClose(1008, 'HELLO frame required')
    expect(socket.getHealth().state).toBe('backoff')
    expect(blocked).toEqual([])
    expect(metrics.errors).toEqual([])
    expect(metrics.disconnects).toEqual(['1008:server'])
  })

  it('a rejected key (close 1008 Invalid token before hello.ok) is `blocked`: one `auth` per rejected HELLO, the SDK notice is no second signal, a fresh HELLO 10–15 min later, cleared by the next hello.ok', async () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const blocked: SocketBlocked[] = []
      const { socket, metrics } = makeSocket({
        onDisconnected: (info) => events.push(`disconnected:${info.code}:${info.initiator}`),
        onBlocked: (info) => {
          blocked.push(info)
          events.push('blocked')
        },
        onConnected: () => events.push('connected'),
        onError: (err) => events.push(`error:${err.message}`),
        onStateChanged: (next) => events.push(`state:${next}`),
      })
      sockets.push(socket)
      await start(socket)
      MockWebSocket.latest().simulateOpen()
      MockWebSocket.latest().simulateClose(1008, 'Invalid token')
      expect(socket.getHealth().state).toBe('blocked')
      // The SDK's order: the close, the state, then the typed event with the code and reason.
      expect(events).toEqual(['state:connecting', 'disconnected:1008:server', 'state:blocked', 'blocked'])
      expect(blocked[0]).toMatchObject({ code: 1008, reason: 'Invalid token' })
      expect(blocked[0]!.retryInMs).toBeGreaterThanOrEqual(600_000)
      expect(blocked[0]!.retryInMs).toBeLessThanOrEqual(900_000)
      expect(metrics.errors).toEqual(['auth'])
      expect(metrics.disconnects).toEqual(['1008:server'])

      // No new socket before the retry is due; one when it is.
      vi.advanceTimersByTime(blocked[0]!.retryInMs! - 1)
      expect(MockWebSocket.instances).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(socket.getHealth().state).toBe('connecting')

      // Rejected again: `blocked` again, one more `auth`, still nothing through onError.
      MockWebSocket.latest().simulateOpen()
      MockWebSocket.latest().simulateClose(1008, 'Invalid token')
      expect(blocked).toHaveLength(2)
      expect(metrics.errors).toEqual(['auth', 'auth'])
      expect(events.filter((e) => e.startsWith('error:'))).toEqual([])

      // Accepted on the next try (the key rotated back, the account reinstated): `ready`, the connect wake.
      vi.advanceTimersByTime(blocked[1]!.retryInMs!)
      expect(MockWebSocket.instances).toHaveLength(3)
      MockWebSocket.latest().simulateReady()
      expect(socket.getHealth().state).toBe('ready')
      expect(events.at(-1)).toBe('connected')
      expect(metrics.states).toEqual(['idle', 'connecting', 'blocked', 'connecting', 'blocked', 'connecting', 'ready'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('the stop is final: `stopped` through the SDK state, the socket is closed, and nothing fires afterwards', async () => {
    const events: string[] = []
    const { socket, metrics } = makeSocket({
      onDisconnected: () => events.push('disconnected'),
      onConnected: () => events.push('connected'),
      onStateChanged: (next) => events.push(`state:${next}`),
    })
    await start(socket)
    const ws = MockWebSocket.latest()
    ws.simulateReady()
    stop(socket)
    expect(socket.getHealth().state).toBe('stopped')
    expect(ws.closed).not.toBeNull()
    ws.simulateClose(1000, 'bye')
    await settle()
    expect(events).toEqual(['state:connecting', 'state:ready', 'connected', 'state:stopped'])
    expect(metrics.states.at(-1)).toBe('stopped')
    stop(socket) // idempotent
    socket.bind() // a stopped binding stays stopped
    expect(metrics.states.filter((s) => s === 'stopped')).toHaveLength(1)
  })

  it('stopped before any connect is `stopped` too', () => {
    const { socket, metrics } = makeSocket()
    socket.stopped()
    expect(socket.getHealth().state).toBe('stopped')
    expect(metrics.states).toEqual(['idle', 'stopped'])
    expect(MockWebSocket.instances).toHaveLength(0)
  })
})

describe('classifyRealtimeError / wakeSourceOf / realtimeOptionsFor', () => {
  it('classifies the SDK notices for the metric with a bounded label; a rejected key is the `blocked` event, not an error class here', () => {
    expect(classifyRealtimeError(new Error('handshake timeout: no hello.ok within 15000ms'))).toBe('transport')
    expect(classifyRealtimeError(new Error('liveness timeout: nothing received for 100000ms'))).toBe('transport')
    expect(classifyRealtimeError(new Error('still reconnecting after 60 consecutive failed attempts; backing off to at most 300s between attempts and not giving up'))).toBe('transport')
    expect(classifyRealtimeError(new Error('WebSocket error'))).toBe('transport')
    expect(classifyRealtimeError(new Error('message.new handler failed: boom'))).toBe('handler')
    expect(classifyRealtimeError(new Error('wake frame failed validation: step is not an integer'))).toBe('protocol')
    expect(classifyRealtimeError(new Error('something else'))).toBe('other')
  })

  it('maps a server wake reason onto the fixed source set', () => {
    expect(wakeSourceOf('reminder')).toBe('reminder')
    expect(wakeSourceOf('unanswered')).toBe('unanswered')
    expect(wakeSourceOf('digest')).toBe('other')
    expect(wakeSourceOf(undefined)).toBe('other')
  })

  it('maps the channel config onto the SDK realtime options: wss base, ack on receipt, the configured backoff, the OpenClaw identity', () => {
    const config = parseChannelConfig({
      apiKey: KEY,
      apiBase: 'https://staging.agentchat.me/',
      reconnect: { initialBackoffMs: 500, maxBackoffMs: 60_000, jitterRatio: 0.5 },
      ping: { intervalMs: 20_000, timeoutMs: 5_000 }, // accepted, unused
      outbound: { maxInFlight: 1, sendTimeoutMs: 1000 }, // accepted, unused
    })
    const options = realtimeOptionsFor(config)
    expect(options).toMatchObject({
      apiKey: KEY,
      baseUrl: 'wss://staging.agentchat.me',
      ackOnReceipt: true,
      capabilities: { rewake: true },
      reconnect: true,
      reconnectInterval: 500,
      maxReconnectInterval: 60_000,
      clientIdentity: { name: 'openclaw', version: PACKAGE_VERSION },
    })
    expect('client' in options).toBe(false)
  })
})
