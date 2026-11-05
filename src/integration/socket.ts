/**
 * The socket as a wake — the SDK's `RealtimeClient` bound to one account.
 *
 * The transport is the SDK's (HELLO, reconnect with backoff, the delivery
 * ack, per-conversation ordering, the reconnect drain). This module holds
 * what is runtime logic: starting and stopping it with the account, turning
 * what arrives into wakes for the invoker, filtering the echo of the agent's
 * own sends, and mapping the SDK's connection events onto the states the
 * gateway reports.
 *
 *   - `message.new`              → `onWake('message')` — after reading only
 *                                   the sender (to skip our own echo) and the
 *                                   ids for the log line. The body is never
 *                                   looked at; the agent reads it through the
 *                                   hosted tools inside its turn.
 *   - `wake`                     → `onWake(reason)` — the server's content-free
 *                                   wake (a deferred conversation's reminder).
 *   - every successful HELLO     → `onWake('connect')` — whatever landed while
 *                                   the socket was down is on the tray.
 *   - `group.invite.received`    → `onGroupInvite(invite)` — the second wake
 *                                   kind; not on the tray, not gated.
 *
 * `ackOnReceipt: true`: the SDK acknowledges every `message.new` the moment
 * the frame is parsed, before any handler runs — delivered means this
 * machine received it. Whether the agent looked is read state, recorded by
 * the gate's verdicts; an early ack never empties the tray. No frame is
 * ever acknowledged by this module; it sends nothing.
 *
 * Every frame is a wake and every wake reads the whole tray, so no ordering
 * assumption is made: frames the SDK parks on a sequence gap and flushes on
 * a close are wakes like any other.
 */

import { RealtimeClient, type AgentChatClient, type RealtimeOptions, type WakeFrame, type WsMessage } from 'agentchatme'

import type { AgentchatChannelConfig } from '../config-schema.js'
import type { Logger } from '../log.js'
import type { MetricsRecorder } from '../metrics.js'
import { createNoopMetrics } from '../metrics.js'
import { AGENTCHAT_CLIENT_IDENTITY } from '../client-identity.js'
import { groupInviteFromRecord, type GroupInvite } from './invites.js'
import type { WakeSource } from './invoker.js'

/**
 * The connection as the gateway reports it. The SDK keeps its own machine
 * private; these are derived from its events: `connecting` until the first
 * HELLO is accepted, `connected` while a session is up, `reconnecting`
 * between a close and the next accepted HELLO, `blocked` once the server
 * rejected the key or the SDK stopped retrying, `stopped` after `stop()`.
 */
export type SocketState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'blocked' | 'stopped'

export interface SocketDisconnect {
  readonly code: number
  readonly reason: string
  /** The server rejected the key during the handshake (4401/4403, or 1008 with its own `Invalid token` reason). */
  readonly keyRejected: boolean
}

export interface WakeDetail {
  readonly conversationId?: string
  readonly messageId?: string
  readonly from?: string
}

export interface SocketHandlers {
  /** A wake: the tray may have changed. `source` is for the log line and the metric label only. */
  onWake?: (source: WakeSource, detail: WakeDetail) => void
  /** The second wake kind. */
  onGroupInvite?: (invite: GroupInvite) => void
  /** Once per accepted HELLO (initial + every reconnect), before the connect wake. */
  onConnected?: (at: number) => void
  /** Every socket close the SDK reports (never for our own `stop()`). */
  onDisconnected?: (info: SocketDisconnect) => void
  /** The SDK stopped reconnecting on its own (a terminal close code). Only a new socket can recover. */
  onStopped?: (reason: string) => void
  /** Every other error the SDK surfaces (transport, handshake timeout, handler failures). */
  onError?: (error: Error) => void
  onStateChanged?: (next: SocketState, prev: SocketState) => void
}

export interface IntegrationSocketOptions {
  readonly config: AgentchatChannelConfig
  readonly logger: Logger
  readonly handlers?: SocketHandlers
  readonly metrics?: MetricsRecorder
  /**
   * The SDK client for the realtime client's reconnect drain and gap fill.
   * Without it offline envelopes wait for the server's own re-push.
   */
  readonly client?: AgentChatClient
  /** Test seam: build the realtime client. Production constructs the SDK's. */
  readonly createRealtime?: (options: RealtimeOptions) => RealtimeClient
  /** Test seam / polyfill: the WebSocket constructor the SDK uses. */
  readonly webSocket?: typeof globalThis.WebSocket
  readonly now?: () => number
}

export interface SocketHealth {
  readonly state: SocketState
  readonly connectedAt: number | null
  readonly counters: {
    readonly frames: number
    readonly selfFiltered: number
    readonly wakes: number
    readonly invites: number
    readonly disconnects: number
  }
}

// Close codes that mean "the server rejected this key" when the SERVER
// sends them during the handshake. 4401/4403 are unambiguous. 1008 (policy
// violation) is not: the AgentChat server closes a rejected HELLO with
// 1008 'Invalid token', but also uses 1008 for a handshake that was merely
// too slow ('HELLO frame required', from its own 5 s timer) — and the SDK
// closes its own hello-ack timeout with 1008 too. So 1008 counts as a
// rejection only with the server's own auth reason.
const UNAMBIGUOUS_AUTH_CLOSE_CODES: ReadonlySet<number> = new Set([4401, 4403])
const AMBIGUOUS_AUTH_CLOSE_CODE = 1008
const SERVER_AUTH_CLOSE_REASONS: readonly string[] = ['invalid token']

/** True iff a close with this code and reason means the key was rejected. Pure; exported for tests. */
export function isKeyRejection(code: number, reason: string): boolean {
  if (UNAMBIGUOUS_AUTH_CLOSE_CODES.has(code)) return true
  if (code !== AMBIGUOUS_AUTH_CLOSE_CODE) return false
  const lower = reason.toLowerCase()
  return SERVER_AUTH_CLOSE_REASONS.some((known) => lower.includes(known))
}

/**
 * The SDK's one signal that its reconnect loop is off for good: the error it
 * emits after a terminal close code (`realtime.ts`, "closed with terminal
 * code"). There is no typed event for it, so the message is matched.
 */
export function isRealtimeStopped(error: Error): boolean {
  return /terminal code/i.test(error.message)
}

/** The SDK realtime options for a channel config: `wss://…` base, the account's backoff, the integration identity. */
export function realtimeOptionsFor(config: AgentchatChannelConfig, extra: Pick<IntegrationSocketOptions, 'client' | 'webSocket'> = {}): RealtimeOptions {
  return {
    apiKey: config.apiKey,
    baseUrl: config.apiBase.replace(/^http/, 'ws').replace(/\/+$/, ''),
    clientIdentity: AGENTCHAT_CLIENT_IDENTITY,
    ackOnReceipt: true,
    reconnect: true,
    reconnectInterval: config.reconnect.initialBackoffMs,
    maxReconnectInterval: config.reconnect.maxBackoffMs,
    ...(extra.client ? { client: extra.client } : {}),
    ...(extra.webSocket ? { webSocket: extra.webSocket } : {}),
  }
}

export class IntegrationSocket {
  private readonly config: AgentchatChannelConfig
  private readonly logger: Logger
  private readonly handlers: SocketHandlers
  private readonly metrics: MetricsRecorder
  private readonly client: AgentChatClient | undefined
  private readonly createRealtime: (options: RealtimeOptions) => RealtimeClient
  private readonly webSocket: typeof globalThis.WebSocket | undefined
  private readonly now: () => number
  private readonly selfHandle: string | undefined

  private realtime: RealtimeClient | null = null
  private state: SocketState = 'idle'
  private connectedAt: number | null = null
  private stopping = false

  private frames = 0
  private selfFiltered = 0
  private wakes = 0
  private invites = 0
  private disconnects = 0

  constructor(options: IntegrationSocketOptions) {
    this.config = options.config
    this.logger = options.logger.child({ component: 'socket' })
    this.handlers = options.handlers ?? {}
    this.metrics = options.metrics ?? createNoopMetrics()
    this.client = options.client
    this.createRealtime = options.createRealtime ?? ((opts) => new RealtimeClient(opts))
    this.webSocket = options.webSocket
    this.now = options.now ?? Date.now
    this.selfHandle = this.config.agentHandle?.replace(/^@/, '').toLowerCase()
    this.metrics.setConnectionState(this.state)
  }

  /**
   * Open the socket. Idempotent. Resolves once the SDK has started its
   * connect loop; a failure to resolve a WebSocket implementation is logged
   * and left to the SDK's own retry. Never throws.
   */
  async start(): Promise<void> {
    if (this.realtime || this.stopping) return
    const realtime = this.createRealtime(realtimeOptionsFor(this.config, { client: this.client, webSocket: this.webSocket }))
    this.realtime = realtime
    this.bind(realtime)
    this.setState('connecting')
    try {
      await realtime.connect()
    } catch (err) {
      this.logger.warn({ err: describe(err) }, 'socket connect failed — the SDK retries on its own schedule')
    }
  }

  /** Close the socket for good; a stopped socket does not reconnect. Idempotent. */
  async stop(): Promise<void> {
    this.stopping = true
    const realtime = this.realtime
    this.realtime = null
    if (realtime) {
      try {
        realtime.disconnect()
      } catch (err) {
        this.logger.warn({ err: describe(err) }, 'socket disconnect threw — continuing')
      }
    }
    this.connectedAt = null
    this.setState('stopped')
  }

  getHealth(): SocketHealth {
    return {
      state: this.state,
      connectedAt: this.connectedAt,
      counters: { frames: this.frames, selfFiltered: this.selfFiltered, wakes: this.wakes, invites: this.invites, disconnects: this.disconnects },
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private bind(realtime: RealtimeClient): void {
    realtime.onConnect(() => {
      const at = this.now()
      this.connectedAt = at
      this.logger.info({ at: new Date(at).toISOString() }, 'connected (HELLO accepted)')
      this.setState('connected')
      this.guard('onConnected', () => this.handlers.onConnected?.(at))
      // Whatever landed while the socket was down is on the tray now; the
      // connect itself is the wake that covers the gap.
      this.wake('connect', {})
    })

    realtime.onDisconnect(({ code, reason }) => {
      if (this.stopping) return
      this.disconnects += 1
      this.connectedAt = null
      this.metrics.incDisconnect({ code: String(code) })
      const keyRejected = isKeyRejection(code, reason)
      this.logger[keyRejected ? 'warn' : 'info']({ code, reason }, keyRejected ? 'socket closed — the server rejected the key' : 'socket closed — the SDK reconnects')
      this.setState(keyRejected ? 'blocked' : 'reconnecting')
      this.guard('onDisconnected', () => this.handlers.onDisconnected?.({ code, reason, keyRejected }))
    })

    realtime.onError((error) => {
      if (this.stopping) return
      if (isRealtimeStopped(error)) {
        this.metrics.incError({ errorClass: 'auth' })
        this.logger.warn({ err: error.message }, 'the SDK stopped reconnecting')
        this.setState('blocked')
        this.guard('onStopped', () => this.handlers.onStopped?.(error.message))
        return
      }
      this.metrics.incError({ errorClass: classifyRealtimeError(error) })
      this.logger.debug({ err: error.message }, 'socket error')
      this.guard('onError', () => this.handlers.onError?.(error))
    })

    realtime.on('message.new', (message) => this.onMessageNew(message))
    realtime.on('wake', (frame) => this.onWakeFrame(frame))
    realtime.on('group.invite.received', (message) => this.onInvite(message))
  }

  private onMessageNew(message: WsMessage): void {
    this.frames += 1
    const payload = message.payload ?? {}
    const senderRaw = payload.sender ?? payload.from ?? ''
    const sender = typeof senderRaw === 'string' ? senderRaw.replace(/^@/, '').toLowerCase() : ''
    const detail: WakeDetail = {
      ...(typeof payload.conversation_id === 'string' ? { conversationId: payload.conversation_id } : {}),
      ...(typeof payload.id === 'string' ? { messageId: payload.id } : {}),
      ...(sender ? { from: sender } : {}),
    }
    if (this.selfHandle && sender === this.selfHandle) {
      // Server-side fan-out echoes our own sends back; our own words never wake us.
      this.selfFiltered += 1
      this.logger.debug(detail, 'own echo — not a wake')
      return
    }
    this.logger.debug(detail, 'wake — message.new')
    this.wake('message', detail)
  }

  private onWakeFrame(frame: WakeFrame): void {
    this.frames += 1
    const reason = typeof frame.payload?.reason === 'string' && frame.payload.reason.length > 0 ? frame.payload.reason : 'wake'
    const detail: WakeDetail = { conversationId: frame.payload.conversation_id }
    this.logger.info({ ...detail, reason, step: frame.payload.step }, 'wake — server wake frame')
    this.wake(reason, detail)
  }

  private onInvite(message: WsMessage): void {
    this.frames += 1
    const invite = groupInviteFromRecord(message.payload)
    if (!invite) {
      this.logger.warn({ keys: Object.keys(message.payload ?? {}).sort() }, 'group.invite.received without ids — dropped')
      return
    }
    this.invites += 1
    this.guard('onGroupInvite', () => this.handlers.onGroupInvite?.(invite))
  }

  private wake(source: WakeSource, detail: WakeDetail): void {
    this.wakes += 1
    this.metrics.incWake({ source })
    this.guard('onWake', () => this.handlers.onWake?.(source, detail))
  }

  private setState(next: SocketState): void {
    const prev = this.state
    if (prev === next) return
    this.state = next
    this.metrics.setConnectionState(next)
    this.logger.debug({ from: prev, to: next }, 'socket state')
    this.guard('onStateChanged', () => this.handlers.onStateChanged?.(next, prev))
  }

  /** A failing handler never takes the socket down; the next frame wakes again and the tray keeps the cards. */
  private guard(name: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.logger.error({ err: describe(err), handler: name }, 'handler threw — continuing')
    }
  }
}

/** Low-cardinality class for the error metric. */
export function classifyRealtimeError(error: Error): 'auth' | 'transport' | 'handler' | 'protocol' | 'other' {
  const message = error.message
  if (/terminal code/i.test(message)) return 'auth'
  if (/handler failed/i.test(message)) return 'handler'
  if (/failed validation|not an object|expected a bare array/i.test(message)) return 'protocol'
  if (error.name === 'ConnectionError' || /websocket|hello|sync drain|sync ack/i.test(message)) return 'transport'
  return 'other'
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
