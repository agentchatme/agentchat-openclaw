/**
 * The socket binding over the real SDK `RealtimeClient`, with a mock
 * WebSocket underneath:
 *   - every accepted HELLO is a connect wake; `message.new` and server `wake`
 *     frames are wakes; our own echo is not;
 *   - the delivery ack is on the wire before any wake handler — and before
 *     the gate's model call when a real invoker is wired in;
 *   - `group.invite.received` is handed on; malformed ones are dropped;
 *   - the SDK's connection events map onto connected / reconnecting /
 *     blocked / stopped, a rejected key is told apart from a plain close;
 *   - handler errors never escape; `stop()` is final.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseChannelConfig } from '../../src/config-schema.js'
import { AgentInvoker } from '../../src/integration/invoker.js'
import { InviteLedger } from '../../src/integration/invites.js'
import { IntegrationSocket, isKeyRejection, isRealtimeStopped, realtimeOptionsFor, type SocketHandlers } from '../../src/integration/socket.js'
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
    incDisconnect: ({ code }: { code: string }) => void m.disconnects.push(code),
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
  it('starts the SDK socket with an OpenClaw HELLO; an accepted HELLO is a connect wake and `connected`', async () => {
    const wakes: string[] = []
    const connected: number[] = []
    const { socket, metrics } = makeSocket({ onWake: (s) => wakes.push(s), onConnected: (at) => connected.push(at) })
    sockets.push(socket)
    await socket.start()
    const ws = MockWebSocket.latest()
    expect(ws.url).toBe('wss://api.agentchat.me/v1/ws')
    ws.simulateOpen()
    const hello = sentFrames(ws, 'hello')[0]!
    expect(hello).toMatchObject({ api_key: KEY, capabilities: ['ack'], client: 'openclaw', client_version: PACKAGE_VERSION })
    expect(socket.getHealth().state).toBe('connecting')
    ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    expect(connected).toHaveLength(1)
    expect(wakes).toEqual(['connect'])
    expect(socket.getHealth().state).toBe('connected')
    expect(metrics.states).toEqual(['idle', 'connecting', 'connected'])
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
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-socket-invoker-'))
    try {
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
        invites: new InviteLedger({ accountId: 'default', stateDir }),
        logger: silentLogger,
        debounceMs: 0,
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
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('a server wake frame is one wake with the reminder as its source, never acked', async () => {
    const wakes: Array<[string, unknown]> = []
    const { socket, metrics } = makeSocket({ onWake: (source, detail) => wakes.push([source, detail]) })
    sockets.push(socket)
    await socket.start()
    const ws = MockWebSocket.latest()
    ws.simulateReady()
    ws.simulateMessage(wakeFrame('conv_9', 2))
    await settle()
    expect(wakes).toEqual([
      ['connect', {}],
      ['reminder', { conversationId: 'conv_9' }],
    ])
    expect(sentFrames(ws, 'ack')).toEqual([])
    expect(metrics.wakes).toEqual(['connect', 'reminder'])
  })

  it('group.invite.received is the second wake kind; malformed invites are dropped', async () => {
    const invites: unknown[] = []
    const wakes: string[] = []
    const { socket } = makeSocket({ onGroupInvite: (i) => invites.push(i), onWake: (s) => wakes.push(s) })
    sockets.push(socket)
    await socket.start()
    const ws = MockWebSocket.latest()
    ws.simulateReady()
    ws.simulateMessage({ type: 'group.invite.received', payload: { id: 'inv_1', group_id: 'grp_1', group_name: 'Ops', inviter_handle: '@bob', created_at: 'x' } })
    ws.simulateMessage({ type: 'group.invite.received', payload: { group_name: 'no ids' } })
    await settle()
    expect(invites).toEqual([{ inviteId: 'inv_1', groupId: 'grp_1', groupName: 'Ops', inviterHandle: 'bob' }])
    expect(wakes).toEqual(['connect'])
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
    expect(socket.getHealth().state).toBe('connected')
  })
})

describe('IntegrationSocket — the SDK connection events, mapped', () => {
  it('a plain close is `reconnecting` and the SDK reconnects on its own; the next accepted HELLO is `connected` again', async () => {
    const events: string[] = []
    const { socket, metrics } = makeSocket({
      onDisconnected: (info) => events.push(`disconnected:${info.code}:${info.keyRejected}`),
      onConnected: () => events.push('connected'),
      onStateChanged: (next) => events.push(`state:${next}`),
    })
    sockets.push(socket)
    await socket.start()
    MockWebSocket.latest().simulateReady()
    MockWebSocket.latest().simulateClose(1006, 'abnormal')
    expect(socket.getHealth().state).toBe('reconnecting')
    await new Promise((r) => setTimeout(r, 300)) // > initialBackoffMs with jitter
    expect(MockWebSocket.instances).toHaveLength(2)
    MockWebSocket.latest().simulateReady()
    expect(events).toEqual(['state:connecting', 'state:connected', 'connected', 'state:reconnecting', 'disconnected:1006:false', 'state:connected', 'connected'])
    expect(metrics.disconnects).toEqual(['1006'])
    expect(socket.getHealth().counters.disconnects).toBe(1)
  })

  it('a rejected key (close 1008 Invalid token) is `blocked`, then the SDK stops reconnecting and says so once; no new socket is opened', async () => {
    const events: string[] = []
    const { socket, metrics } = makeSocket({
      onDisconnected: (info) => events.push(`disconnected:${info.code}:${info.keyRejected}`),
      onStopped: (reason) => events.push(`stopped:${/terminal code 1008/.test(reason)}`),
      onError: (err) => events.push(`error:${err.message}`),
    })
    sockets.push(socket)
    await socket.start()
    MockWebSocket.latest().simulateOpen()
    MockWebSocket.latest().simulateClose(1008, 'Invalid token')
    await new Promise((r) => setTimeout(r, 300))
    expect(events).toEqual(['disconnected:1008:true', 'stopped:true'])
    expect(socket.getHealth().state).toBe('blocked')
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(metrics.errors).toEqual(['auth'])
  })

  it('a terminal close with another reason is not a key rejection, but the SDK still stops: `onStopped` is the signal', async () => {
    const events: string[] = []
    const { socket } = makeSocket({
      onDisconnected: (info) => events.push(`disconnected:${info.code}:${info.keyRejected}`),
      onStopped: () => events.push('stopped'),
    })
    sockets.push(socket)
    await socket.start()
    MockWebSocket.latest().simulateOpen()
    MockWebSocket.latest().simulateClose(1008, 'HELLO frame required')
    await settle()
    expect(events).toEqual(['disconnected:1008:false', 'stopped'])
    expect(socket.getHealth().state).toBe('blocked')
  })

  it('stop() is final: `stopped`, the SDK socket is closed, and nothing fires afterwards', async () => {
    const events: string[] = []
    const { socket, metrics } = makeSocket({ onDisconnected: () => events.push('disconnected'), onWake: () => events.push('wake') })
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
    expect(events).toEqual(['wake']) // the connect wake only
    expect(metrics.states.at(-1)).toBe('stopped')
    await socket.start() // a stopped socket stays stopped
    expect(MockWebSocket.instances).toHaveLength(1)
  })
})

describe('isKeyRejection / isRealtimeStopped / realtimeOptionsFor', () => {
  it("4401 and 4403 always; 1008 only with the server's own auth reason", () => {
    expect(isKeyRejection(4401, '')).toBe(true)
    expect(isKeyRejection(4403, 'forbidden')).toBe(true)
    expect(isKeyRejection(1008, 'Invalid token')).toBe(true)
    expect(isKeyRejection(1008, 'invalid token: revoked')).toBe(true)
    expect(isKeyRejection(1008, 'HELLO frame required')).toBe(false)
    expect(isKeyRejection(1008, 'HELLO ack timeout')).toBe(false) // the SDK's own self-close reuses 1008
    expect(isKeyRejection(1006, 'Invalid token')).toBe(false)
    expect(isKeyRejection(1000, '')).toBe(false)
  })

  it("recognises the SDK's terminal-close error and nothing else", () => {
    expect(isRealtimeStopped(new Error('WebSocket closed with terminal code 1008 (Invalid token); the server rejected the session and auto-reconnect has stopped.'))).toBe(true)
    expect(isRealtimeStopped(new Error('HELLO ack timeout'))).toBe(false)
    expect(isRealtimeStopped(new Error('WebSocket error'))).toBe(false)
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
      reconnect: true,
      reconnectInterval: 500,
      maxReconnectInterval: 60_000,
      clientIdentity: { name: 'openclaw', version: PACKAGE_VERSION },
    })
    expect('client' in options).toBe(false)
  })
})
