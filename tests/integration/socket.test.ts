/**
 * The socket binding over the real SDK `RealtimeClient`, with a mock
 * WebSocket underneath:
 *   - every accepted HELLO is a connect wake; `message.new` and server `wake`
 *     frames are wakes; our own echo is not;
 *   - the delivery ack is on the wire before any wake handler — and before
 *     the gate's model call when a real invoker is wired in;
 *   - `group.invite.received` is a wake (the invite is read from the tray);
 *   - the SDK's lifecycle is reported as it is: `ready` / `backoff` /
 *     `blocked` / `stopped` from its state, a rejected key from its
 *     `blocked` event (the SDK, not the plugin, tells it from a plain close
 *     and retries it 10–15 min later);
 *   - handler errors never escape; `stop()` is final.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseChannelConfig } from '../../src/config-schema.js'
import { AgentInvoker } from '../../src/integration/invoker.js'
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
import { card, fakeClient, tray } from '../helpers/fake-client.js'
import { silentLogger } from '../helpers/logger.js'
import { staticTexts } from '../helpers/texts.js'

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

const sockets: IntegrationSocket[] = []
beforeEach(() => MockWebSocket.reset())
afterEach(async () => {
  for (const s of sockets.splice(0)) await s.stop()
})

describe('IntegrationSocket — wakes', () => {
  it('starts the SDK socket with an OpenClaw HELLO; an accepted HELLO is a connect wake and `ready`', async () => {
    const wakes: string[] = []
    const connected: number[] = []
    const { socket, metrics } = makeSocket({ onWake: (s) => wakes.push(s), onConnected: (at) => connected.push(at) })
    sockets.push(socket)
    await socket.start()
    const ws = MockWebSocket.latest()
    expect(ws.url).toBe('wss://api.agentchat.me/v1/ws')
    ws.simulateOpen()
    const hello = sentFrames(ws, 'hello')[0]!
    // Contract v1: ack, plus heartbeat and rewake (the server's re-wake replaces any local retry ladder).
    expect(hello).toMatchObject({ api_key: KEY, capabilities: ['ack', 'heartbeat', 'rewake'], client: 'openclaw', client_version: PACKAGE_VERSION })
    expect(socket.getHealth().state).toBe('connecting')
    ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    expect(connected).toHaveLength(1)
    expect(wakes).toEqual(['connect'])
    expect(socket.getHealth().state).toBe('ready')
    expect(metrics.states).toEqual(['idle', 'connecting', 'ready'])
    expect(metrics.wakes).toEqual(['connect'])
  })

  it('a peer message.new is a wake with the ack already on the wire; our own echo is not a wake; the body is never needed', async () => {
    const wakes: Array<{ source: string; acksSoFar: number; detail: unknown }> = []
    const { socket } = makeSocket({
      onWake: (source, detail) => wakes.push({ source, acksSoFar: sentFrames(MockWebSocket.latest(), 'ack').length, detail }),
    })
    sockets.push(socket)
    await socket.start()
    const ws = MockWebSocket.latest()
    ws.simulateReady()
    ws.simulateMessage(messageNew('conv_1', 1, { sender: '@bob' }))
    ws.simulateMessage(messageNew('grp_1', 1, { id: 'msg_x', sender: 'carol', content: { text: 'secret' } }))
    ws.simulateMessage(messageNew('conv_1', 2, { sender: '@Alice' })) // our own echo
    await settle()
    expect(wakes.map((w) => w.source)).toEqual(['connect', 'message', 'message'])
    expect(wakes[1]).toMatchObject({ acksSoFar: 1, detail: { conversationId: 'conv_1', messageId: 'msg_1', from: 'bob' } })
    expect(wakes[2]).toMatchObject({ acksSoFar: 2, detail: { conversationId: 'grp_1', messageId: 'msg_x', from: 'carol' } })
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_1', 'msg_x', 'msg_2'])
    expect(socket.getHealth().counters).toMatchObject({ frames: 3, selfFiltered: 1, wakes: 3 })
  })

  it('ackOnReceipt before any gate call: with a real invoker wired in, the ack is sent before the model is asked', async () => {
    const { client, posts } = fakeClient({ trays: [tray([card('conv_1', 'msg_1')])] })
    const acksAtModelCall: number[] = []
    const invoker = new AgentInvoker({
      accountId: 'default',
      agentId: 'main',
      client,
      callModel: async () => {
        acksAtModelCall.push(sentFrames(MockWebSocket.latest(), 'ack').length)
        return '{"decisions":[{"conversation_id":"conv_1","decision":"dismiss"}]}'
      },
      startTurn: async () => ({ ran: false, error: 'not in this test' }),
      texts: staticTexts(),
      logger: silentLogger,
      quietMs: 0,
      maxMs: 0,
    })
    const { socket } = makeSocket({ onWake: (source) => invoker.wake(source) })
    sockets.push(socket)
    await socket.start()
    const ws = MockWebSocket.latest()
    ws.simulateReady()
    ws.simulateMessage(messageNew('conv_1', 1, { sender: '@bob' }))
    await settle(30)
    for (let i = 0; i < 10; i++) await invoker.settled()
    expect(acksAtModelCall).toEqual([1])
    expect(posts).toEqual([{ conversationId: 'conv_1', body: { decision: 'dismiss', through_message_id: 'msg_1' } }])
    invoker.stop()
  })

  it('a server wake frame is one wake labelled by its reason, never acked', async () => {
    const wakes: Array<[string, unknown]> = []
    const { socket, metrics } = makeSocket({ onWake: (source, detail) => wakes.push([source, detail]) })
    sockets.push(socket)
    await socket.start()
    const ws = MockWebSocket.latest()
    ws.simulateReady()
    ws.simulateMessage(wakeFrame('conv_9', 2))
    // A reason this version does not know is still a wake, labelled `other` (the metric label stays bounded).
    ws.simulateMessage({ ...wakeFrame('conv_10'), payload: { ...(wakeFrame('conv_10').payload as object), reason: 'something-new' } })
    await settle()
    expect(wakes).toEqual([
      ['connect', {}],
      ['reminder', { conversationId: 'conv_9' }],
      ['other', { conversationId: 'conv_10' }],
    ])
    expect(sentFrames(ws, 'ack')).toEqual([])
    expect(metrics.wakes).toEqual(['connect', 'reminder', 'other'])
  })

  it('a contract-v1 re-wake for unanswered cards is a wake labelled `unanswered`', async () => {
    const wakes: string[] = []
    const { socket } = makeSocket({ onWake: (source) => wakes.push(source) })
    sockets.push(socket)
    await socket.start()
    const ws = MockWebSocket.latest()
    ws.simulateReady()
    ws.simulateMessage({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: ['conv_1', 'conv_2'], step: 1, at: '2026-11-08T00:00:00.000Z' } })
    await settle()
    expect(wakes).toEqual(['connect', 'unanswered'])
  })

  it('group.invite.received is a wake: the invite itself is read from the tray', async () => {
    const wakes: string[] = []
    const { socket } = makeSocket({ onWake: (s) => wakes.push(s) })
    sockets.push(socket)
    await socket.start()
    const ws = MockWebSocket.latest()
    ws.simulateReady()
    ws.simulateMessage({ type: 'group.invite.received', payload: { id: 'inv_1', group_id: 'grp_1', group_name: 'Ops', inviter_handle: '@bob', created_at: 'x' } })
    await settle()
    expect(wakes).toEqual(['connect', 'invite'])
    expect(socket.getHealth().counters.invites).toBe(1)
  })

  it('a throwing handler never takes the socket down', async () => {
    const seen: string[] = []
    const { socket } = makeSocket({
      onWake: (source) => {
        seen.push(source)
        throw new Error('handler boom')
      },
    })
    sockets.push(socket)
    await socket.start()
    const ws = MockWebSocket.latest()
    ws.simulateReady()
    ws.simulateMessage(messageNew('conv_1', 1))
    ws.simulateMessage(messageNew('conv_1', 2))
    await settle()
    expect(seen).toEqual(['connect', 'message', 'message'])
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
    await socket.start()
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
    await socket.start()
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
      await socket.start()
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

  it('stop() is final: `stopped` through the SDK state, the socket is closed, and nothing fires afterwards', async () => {
    const events: string[] = []
    const { socket, metrics } = makeSocket({
      onDisconnected: () => events.push('disconnected'),
      onWake: () => events.push('wake'),
      onStateChanged: (next) => events.push(`state:${next}`),
    })
    sockets.push(socket)
    await socket.start()
    const ws = MockWebSocket.latest()
    ws.simulateReady()
    await socket.stop()
    expect(socket.getHealth().state).toBe('stopped')
    expect(ws.closed).not.toBeNull()
    ws.simulateMessage(messageNew('conv_1', 1))
    ws.simulateClose(1000, 'bye')
    await settle()
    expect(events).toEqual(['state:connecting', 'state:ready', 'wake', 'state:stopped'])
    expect(metrics.states.at(-1)).toBe('stopped')
    await socket.stop() // idempotent
    await socket.start() // a stopped socket stays stopped
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(metrics.states.filter((s) => s === 'stopped')).toHaveLength(1)
  })

  it('stop() before any start() is `stopped` too, and a later start() opens nothing', async () => {
    const { socket, metrics } = makeSocket()
    await socket.stop()
    expect(socket.getHealth().state).toBe('stopped')
    expect(metrics.states).toEqual(['idle', 'stopped'])
    await socket.start()
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
