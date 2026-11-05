/**
 * The socket as a wake — the SDK's `RealtimeClient` bound to one account.
 *
 * The transport is the SDK's, lifecycle included: HELLO, the reconnect
 * backoff that never gives up (one notice after a long outage, then a wider
 * cap), the handshake and idle watchdogs, the 10–15 min retry of a rejected
 * key, the delivery ack, per-conversation ordering, the reconnect drain. This
 * module holds what is runtime logic: starting and stopping it with the
 * account, turning what arrives into wakes for the invoker, filtering the
 * echo of the agent's own sends, and handing the SDK's lifecycle events to
 * the gateway as they are.
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
 *
 * Nothing here classifies a close. Whether a close was a rejected key, a
 * slow handshake or the client's own watchdog is the SDK's call: it says
 * `blocked` (a typed event with the code, the reason and the delay to its
 * next HELLO) or it backs off, and this module reports which.
 */

import {
  RealtimeClient,
  type AgentChatClient,
  type BlockedInfo,
  type DisconnectInfo,
  type RealtimeOptions,
  type RealtimeState,
  type WakeFrame,
  type WsMessage,
} from 'agentchatme'

import type { AgentchatChannelConfig } from '../config-schema.js'
import type { Logger } from '../log.js'
import type { MetricsRecorder } from '../metrics.js'
import { createNoopMetrics } from '../metrics.js'
import { AGENTCHAT_CLIENT_IDENTITY } from '../client-identity.js'
import { groupInviteFromRecord, type GroupInvite } from './invites.js'
import type { WakeSource } from './invoker.js'

/** A server wake frame's `reason` → the fixed wake-source set (the metric label must stay bounded). */
export function wakeSourceOf(reason: unknown): WakeSource {
  return reason === 'reminder' ? 'reminder' : 'other'
}

/**
 * The connection as the gateway reports it: the SDK's own lifecycle, read
 * from `realtime.state`. `idle` before the first start, `connecting` while a
 * socket opens or its HELLO awaits `hello.ok`, `ready` while a session is up,
 * `backoff` between a close and the next attempt, `blocked` after the server
 * rejected the key during the handshake (the SDK retries a fresh HELLO every
 * 10–15 min; a later `hello.ok` clears it), `stopped` after `stop()` — the
 * only state the client never leaves on its own.
 */
export type SocketState = RealtimeState

/** Every socket close the SDK reports: the code, the reason, and who ended it (`client` = the SDK's own watchdog). */
export type SocketDisconnect = DisconnectInfo

/** A rejected HELLO: the close code and reason, and the delay to the SDK's next attempt. */
export type SocketBlocked = BlockedInfo

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
  /** Every socket close the SDK reports (never for our own `stop()`). The state that follows says what comes next. */
  onDisconnected?: (info: SocketDisconnect) => void
  /**
   * The server rejected the key during the handshake. Once per rejected
   * HELLO: the first of a run and every 10–15 min retry after it, until one
   * is accepted (`onConnected`). The state is `blocked` by the time it fires.
   */
  onBlocked?: (info: SocketBlocked) => void
  /** Every notice the SDK surfaces (transport errors, watchdog trips, the long-outage and rejection notices, handler failures). */
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
  /** The SDK's state as last reported through its `state` event; `stopped` is set here only for a stop before any start. */
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
    this.connectedAt = null
    if (realtime) {
      try {
        // `disconnect()` is the SDK's only way into `stopped`; its state event
        // carries the transition to the gateway like every other.
        realtime.disconnect()
      } catch (err) {
        this.logger.warn({ err: describe(err) }, 'socket disconnect threw — continuing')
      }
    }
    if (this.state !== 'stopped') this.onState('stopped', this.state)
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
    realtime.on('state', (next, prev) => this.onState(next, prev))

    realtime.onConnect(() => {
      const at = this.now()
      this.connectedAt = at
      this.logger.info({ at: new Date(at).toISOString() }, 'connected (HELLO accepted)')
      this.guard('onConnected', () => this.handlers.onConnected?.(at))
      // Whatever landed while the socket was down is on the tray now; the
      // connect itself is the wake that covers the gap.
      this.wake('connect', {})
    })

    realtime.onDisconnect((info) => {
      if (this.stopping) return
      this.disconnects += 1
      this.connectedAt = null
      this.metrics.incDisconnect({ code: String(info.code), initiator: info.initiator })
      this.logger.info({ code: info.code, reason: info.reason, initiator: info.initiator }, 'socket closed — the SDK decides what follows (backoff or blocked)')
      this.guard('onDisconnected', () => this.handlers.onDisconnected?.(info))
    })

    realtime.on('blocked', (info) => {
      if (this.stopping) return
      // One rejected HELLO: the SDK's typed event is what counts it.
      this.metrics.incError({ errorClass: 'auth' })
      this.logger.warn(
        { code: info.code, reason: info.reason, retryInMs: info.retryInMs },
        'the server rejected the key during the handshake — the SDK retries a fresh HELLO on its own',
      )
      this.guard('onBlocked', () => this.handlers.onBlocked?.(info))
    })

    realtime.onError((error) => {
      if (this.stopping) return
      if (realtime.state === 'blocked') {
        // The SDK's one rejection notice per blocked run is emitted between
        // its `blocked` state and the `blocked` event that carries the code
        // and reason; the event is what the gateway reports and the metric
        // counts, so the notice itself is a debug line here, not a second
        // signal for the same rejection.
        this.logger.debug({ err: error.message }, 'SDK notice while blocked')
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
    const reason: unknown = frame.payload?.reason
    const detail: WakeDetail = { conversationId: frame.payload.conversation_id }
    this.logger.info({ ...detail, reason, step: frame.payload.step }, 'wake — server wake frame')
    this.wake(wakeSourceOf(reason), detail)
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

  /** The SDK's state transition, mirrored for the health probe and the gauge, then handed on. */
  private onState(next: SocketState, prev: SocketState): void {
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

/**
 * Low-cardinality class for the error metric, for the notices the SDK
 * surfaces through `onError`. A rejected key is not among them: that is the
 * SDK's `blocked` event, counted as `auth` where it fires.
 */
export function classifyRealtimeError(error: Error): 'transport' | 'handler' | 'protocol' | 'other' {
  const message = error.message
  if (/handler failed/i.test(message)) return 'handler'
  if (/failed validation|not an object|expected a bare array/i.test(message)) return 'protocol'
  if (error.name === 'ConnectionError' || /websocket|hello|handshake|liveness|reconnecting|sync drain|sync ack/i.test(message)) return 'transport'
  return 'other'
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
