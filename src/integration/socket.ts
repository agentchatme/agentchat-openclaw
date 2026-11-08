/**
 * The SDK socket's lifecycle, as OpenClaw reports it — one account.
 *
 * The transport is the SDK's `RealtimeClient`, lifecycle included: HELLO,
 * the reconnect backoff that never gives up (one notice after a long outage,
 * then a wider cap), the handshake and idle watchdogs, the 10–15 min retry
 * of a rejected key, the delivery ack, per-conversation ordering, the
 * reconnect drain. What arrives on it is the kit's receive loop's: it
 * attaches its own handlers to the same client (message frames that are not
 * the agent's own echo, wake frames, invites, every accepted HELLO become
 * one cycle), and connects and disconnects it.
 *
 * This module builds the client with the plugin's options and hands the
 * SDK's lifecycle events to the gateway as they are, for OpenClaw's status
 * and the metrics: connected, closed, blocked, the state, notices. It acts on
 * nothing and sends nothing.
 *
 * HELLO offers `ack`, `heartbeat` and `rewake`: while cards stay unanswered
 * the server re-wakes this socket on its own durable ladder (contract v1,
 * D3), so the integration keeps no retry ladder of its own.
 *
 * `ackOnReceipt: true`: the SDK acknowledges every `message.new` the moment
 * the frame is parsed, before any handler runs — delivered means this
 * machine received it. Whether the agent looked is read state, recorded by
 * the verdicts; an early ack never empties the tray.
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
} from 'agentchatme'

import type { AgentchatChannelConfig } from '../config-schema.js'
import type { Logger } from '../log.js'
import type { MetricsRecorder } from '../metrics.js'
import { createNoopMetrics } from '../metrics.js'
import { AGENTCHAT_CLIENT_IDENTITY } from '../client-identity.js'

/**
 * A wake's label for the metric and the log — a closed set: `message` (a
 * peer wrote), `connect` (an accepted HELLO), `reminder` (a deferred
 * conversation came due), `unanswered` (the server's re-wake for cards
 * still waiting), `invite` (a group invite arrived), `other` (a server wake
 * with a reason this version does not know).
 */
export type WakeLabel = 'message' | 'connect' | 'reminder' | 'unanswered' | 'invite' | 'other'

/** A server wake frame's `reason` → the fixed label set (the metric label must stay bounded). */
export function wakeSourceOf(reason: unknown): WakeLabel {
  if (reason === 'reminder') return 'reminder'
  if (reason === 'unanswered') return 'unanswered'
  return 'other'
}

/**
 * The connection as the gateway reports it: the SDK's own lifecycle, read
 * from `realtime.state`. `idle` before the first start, `connecting` while a
 * socket opens or its HELLO awaits `hello.ok`, `ready` while a session is up,
 * `backoff` between a close and the next attempt, `blocked` after the server
 * rejected the key during the handshake (the SDK retries a fresh HELLO every
 * 10–15 min; a later `hello.ok` clears it), `stopped` after the stop — the
 * only state the client never leaves on its own.
 */
export type SocketState = RealtimeState

/** Every socket close the SDK reports: the code, the reason, and who ended it (`client` = the SDK's own watchdog). */
export type SocketDisconnect = DisconnectInfo

/** A rejected HELLO: the close code and reason, and the delay to the SDK's next attempt. */
export type SocketBlocked = BlockedInfo

export interface SocketHandlers {
  /** Once per accepted HELLO (initial + every reconnect). */
  onConnected?: (at: number) => void
  /** Every socket close the SDK reports (never for our own stop). The state that follows says what comes next. */
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
    readonly wakeFrames: number
    readonly disconnects: number
  }
}

/** The SDK realtime options for a channel config: `wss://…` base, the account's backoff, the integration identity, contract-v1 capabilities. */
export function realtimeOptionsFor(config: AgentchatChannelConfig, extra: Pick<IntegrationSocketOptions, 'client' | 'webSocket'> = {}): RealtimeOptions {
  return {
    apiKey: config.apiKey,
    baseUrl: config.apiBase.replace(/^http/, 'ws').replace(/\/+$/, ''),
    clientIdentity: AGENTCHAT_CLIENT_IDENTITY,
    ackOnReceipt: true,
    // `rewake`: the server re-wakes this socket while cards stay unanswered
    // (contract v1, D3) — the integration keeps no retry ladder of its own.
    // `heartbeat` is offered by default (the idle watchdog's proof of life).
    capabilities: { rewake: true },
    reconnect: true,
    reconnectInterval: config.reconnect.initialBackoffMs,
    maxReconnectInterval: config.reconnect.maxBackoffMs,
    ...(extra.client ? { client: extra.client } : {}),
    ...(extra.webSocket ? { webSocket: extra.webSocket } : {}),
  }
}

export class IntegrationSocket {
  /** The SDK client: handed to the receive loop, which connects and disconnects it. */
  readonly realtime: RealtimeClient

  private readonly logger: Logger
  private readonly handlers: SocketHandlers
  private readonly metrics: MetricsRecorder
  private readonly now: () => number

  /** The SDK's state as last reported through its `state` event. */
  private state: SocketState = 'idle'
  private connectedAt: number | null = null
  private bound = false
  private stopping = false
  private readonly unbind: Array<() => void> = []

  private wakeFrames = 0
  private disconnects = 0

  constructor(options: IntegrationSocketOptions) {
    this.logger = options.logger.child({ component: 'socket' })
    this.handlers = options.handlers ?? {}
    this.metrics = options.metrics ?? createNoopMetrics()
    this.now = options.now ?? Date.now
    const create = options.createRealtime ?? ((opts: RealtimeOptions) => new RealtimeClient(opts))
    this.realtime = create(realtimeOptionsFor(options.config, { client: options.client, webSocket: options.webSocket }))
    this.metrics.setConnectionState(this.state)
  }

  /** Attach the lifecycle handlers. Idempotent. The receive loop connects the client. */
  bind(): void {
    if (this.bound || this.stopping) return
    this.bound = true
    const realtime = this.realtime
    this.unbind.push(
      realtime.on('state', (next, prev) => this.onState(next, prev)),
      realtime.onConnect(() => {
        const at = this.now()
        this.connectedAt = at
        this.logger.info({ at: new Date(at).toISOString() }, 'connected (HELLO accepted)')
        this.metrics.incWake({ source: 'connect' })
        this.guard('onConnected', () => this.handlers.onConnected?.(at))
      }),
      realtime.onDisconnect((info) => {
        if (this.stopping) return
        this.disconnects += 1
        this.connectedAt = null
        this.metrics.incDisconnect({ code: String(info.code), initiator: info.initiator })
        this.logger.info({ code: info.code, reason: info.reason, initiator: info.initiator }, 'socket closed — the SDK decides what follows (backoff or blocked)')
        this.guard('onDisconnected', () => this.handlers.onDisconnected?.(info))
      }),
      realtime.on('blocked', (info) => {
        if (this.stopping) return
        // One rejected HELLO: the SDK's typed event is what counts it.
        this.metrics.incError({ errorClass: 'auth' })
        this.logger.warn(
          { code: info.code, reason: info.reason, retryInMs: info.retryInMs },
          'the server rejected the key during the handshake — the SDK retries a fresh HELLO on its own',
        )
        this.guard('onBlocked', () => this.handlers.onBlocked?.(info))
      }),
      realtime.onError((error) => {
        if (this.stopping) return
        if (realtime.state === 'blocked') {
          // The SDK's one rejection notice per blocked run is emitted between
          // its `blocked` state and the `blocked` event that carries the code
          // and reason; the event is what the gateway reports and the metric
          // counts, so the notice itself is a debug line here.
          this.logger.debug({ err: error.message }, 'SDK notice while blocked')
          return
        }
        this.metrics.incError({ errorClass: classifyRealtimeError(error) })
        this.logger.debug({ err: error.message }, 'socket error')
        this.guard('onError', () => this.handlers.onError?.(error))
      }),
      // The loop turns a wake frame into a cycle; here it is only labelled
      // by its reason for the log line and the metric.
      realtime.on('wake', (frame: WakeFrame) => {
        this.wakeFrames += 1
        const payload = (frame.payload ?? {}) as { reason?: unknown; conversation_id?: unknown; conversation_ids?: unknown; step?: unknown }
        const conversations = Array.isArray(payload.conversation_ids) ? payload.conversation_ids.length : undefined
        this.metrics.incWake({ source: wakeSourceOf(payload.reason) })
        this.logger.info(
          {
            reason: payload.reason,
            step: payload.step,
            ...(typeof payload.conversation_id === 'string' ? { conversationId: payload.conversation_id } : {}),
            ...(conversations !== undefined ? { conversations } : {}),
          },
          'wake — server wake frame',
        )
      }),
    )
  }

  /** The loop has disconnected the client (or never started it): report `stopped`, detach. Idempotent. */
  stopped(): void {
    this.stopping = true
    this.connectedAt = null
    for (const off of this.unbind.splice(0)) {
      try {
        off()
      } catch {
        // already detached
      }
    }
    if (this.state !== 'stopped') this.onState('stopped', this.state)
  }

  getHealth(): SocketHealth {
    return { state: this.state, connectedAt: this.connectedAt, counters: { wakeFrames: this.wakeFrames, disconnects: this.disconnects } }
  }

  /** The SDK's state transition, mirrored for the health probe and the gauge, then handed on. */
  private onState(next: SocketState, prev: SocketState): void {
    if (this.state === next) return
    this.state = next
    this.metrics.setConnectionState(next)
    this.logger.debug({ from: prev, to: next }, 'socket state')
    this.guard('onStateChanged', () => this.handlers.onStateChanged?.(next, prev))
  }

  /** A failing handler never takes the socket down. */
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
