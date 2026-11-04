/**
 * AgentChat WebSocket client — state-machine-driven, production-grade.
 *
 * Responsibilities:
 *   - Own the WS transport and HELLO handshake lifecycle.
 *   - Drive the connection state machine (`./state-machine.ts`) by emitting
 *     events in response to socket/auth/heartbeat transitions.
 *   - Maintain native WS PING/PONG heartbeat at `ping.intervalMs`; declare
 *     DEGRADED on `ping.timeoutMs` miss, then force-reconnect.
 *   - Schedule reconnect with exponential backoff + ±`jitterRatio` jitter
 *     per `reconnect.*` config. Thundering-herd-safe across a fleet.
 *   - Emit typed events upwards (`inboundFrame`, `stateChanged`, `error`,
 *     `authenticated`) so the runtime can turn frames into knocks.
 *
 * Intentional design choices:
 *   - Uses the `ws` package directly (not `globalThis.WebSocket`) because
 *     OpenClaw runs on Node — `ws` exposes `.ping()` / `.pong()` / event
 *     hooks that native WebSocket omits. Every major agent-hosting target
 *     (Fly, Render, Vercel functions, Lambda) is Node.
 *   - Authenticates via HELLO frame (`{type: "hello", api_key}`), never via
 *     URL query string. Keeps the key out of access logs and Referers.
 *   - Advertises the `ack` capability in HELLO and NEVER acknowledges. With
 *     the capability negotiated the server keeps every envelope `stored`
 *     until an ack arrives (WS Delivery-Ack Protocol v1); none ever does
 *     from here — a verdict recorded by the gate, or a send by the agent,
 *     is what settles delivery. There is no code path in this module that
 *     can emit a frame other than HELLO: delivery is judged, never
 *     confirmed by the transport.
 *   - The client never gives up on its own. Only `stop()` ends it. A close
 *     the client itself initiated (hello-ack timeout, ping timeout, its own
 *     drain) is never read as a verdict from the server; a server-originated
 *     auth close enters `AUTH_FAIL` and retries slowly, because keys get
 *     rotated back and accounts get reinstated. A long outage widens the
 *     backoff cap to `RECONNECT_LONG_OUTAGE_BACKOFF_MS` and logs one error
 *     line so an operator sees it without a log flood.
 *   - Frame parsing is defensive: malformed JSON, unknown `type`, missing
 *     payload — all classified as `validation` errors (non-terminal for
 *     the connection, but dropped with a metric + log).
 *   - No message-layer ordering here. Per-conversation seq ordering + gap
 *     recovery belong to the SDK's `RealtimeClient` and the drain layer
 *     (P3 consumers). This module is strictly the transport.
 */

import type { RawData, WebSocket as WsInstance } from 'ws'
import { WebSocket as NodeWebSocket } from 'ws'

import {
  AgentChatChannelError,
  classifyNetworkError,
  type ErrorClass,
} from './errors.js'
import type { Logger } from './log.js'
import type { MetricsRecorder } from './metrics.js'
import {
  isTerminal,
  transition,
  type ConnectionEvent,
  type ConnectionState,
} from './state-machine.js'
import type { AgentchatChannelConfig } from './config-schema.js'
import type { UnixMillis } from './types.js'
import { AGENTCHAT_CLIENT_NAME } from './client-identity.js'
import { PACKAGE_VERSION } from './version.js'

// HELLO handshake must resolve faster than the server's 5s cutoff — we give
// ourselves 4s so a clean close + reconnect happens before the server drops.
const HELLO_ACK_TIMEOUT_MS = 4_000

// After this many consecutive failed attempts (about half an hour at the
// default 30 s cap) the outage is long: one error line is logged for the
// operator and the backoff cap widens to RECONNECT_LONG_OUTAGE_BACKOFF_MS.
// Retrying continues until the server is back — a deploy, a DNS outage or a
// laptop closed overnight is not a reason to stay dead afterwards.
const RECONNECT_LONG_OUTAGE_AFTER_ATTEMPTS = 60
const RECONNECT_LONG_OUTAGE_BACKOFF_MS = 5 * 60_000

// After the server rejects the key, retry a fresh HELLO at this cadence
// (jittered by `reconnect.jitterRatio`: 10–15 min at the default 0.2). A
// rejected key is not a dead end: keys get rotated back, suspended accounts
// get reinstated, and a server-side lookup failure also presents as a reject.
const AUTH_RETRY_INTERVAL_MS = 750_000

// Maximum frame size we'll accept from the server. Matches AgentChat's
// own server-side outbound cap (2 MiB — large attachments go via the REST
// upload flow, not inline in WS frames).
const MAX_FRAME_BYTES = 2 * 1024 * 1024

// Capabilities advertised in HELLO. `ack` asks the server to keep envelopes
// `stored` until this client acknowledges them — which it never does.
const HELLO_CAPABILITIES: readonly string[] = ['ack']

// Close codes that mean "the server rejected this session" when the SERVER
// sends them during the handshake. 4401/4403 are unambiguous. 1008 (policy
// violation) is not: the AgentChat server closes a rejected HELLO with
// 1008 'Invalid token', but also uses 1008 for a handshake that was merely
// too slow ('HELLO frame required', from its own 5 s timer) — which a
// gateway event-loop stall or one slow network leg produces with a
// perfectly good key. So 1008 counts as a rejection only with the server's
// auth reason (the server's own close classification keys on reasons the
// same way); any other 1008 takes the normal backoff. A close this client
// initiated itself never counts (see `closeInitiatedLocally`), and these
// codes after `hello.ok` (key rotated, account suspended) are an eviction:
// the next HELLO is the evidence, so they take the normal reconnect path.
const UNAMBIGUOUS_AUTH_CLOSE_CODES: ReadonlySet<number> = new Set([4401, 4403])
const AMBIGUOUS_AUTH_CLOSE_CODE = 1008
const SERVER_AUTH_CLOSE_REASONS: readonly string[] = ['invalid token']

/**
 * True iff a server-originated close with this code and reason, received
 * during the handshake, means the key was rejected. Pure; exported for tests.
 */
export function isHandshakeRejection(code: number, reason: string): boolean {
  if (UNAMBIGUOUS_AUTH_CLOSE_CODES.has(code)) return true
  if (code !== AMBIGUOUS_AUTH_CLOSE_CODE) return false
  const lower = reason.toLowerCase()
  return SERVER_AUTH_CLOSE_REASONS.some((known) => lower.includes(known))
}

/** One parsed inbound server frame. */
export interface InboundFrame {
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly receivedAt: UnixMillis
  readonly raw: unknown
}

export interface WsClientEvents {
  stateChanged: (next: ConnectionState, prev: ConnectionState) => void
  inboundFrame: (frame: InboundFrame) => void
  error: (error: AgentChatChannelError) => void
  /** Fired once per `hello.ok` — the runtime turns it into the connect knock. */
  authenticated: (at: UnixMillis) => void
  /** Fired once the client reached CLOSED — only ever after `stop()`. */
  closed: () => void
}

export interface WsClientOptions {
  readonly config: AgentchatChannelConfig
  readonly logger: Logger
  readonly metrics: MetricsRecorder
  /** Clock source — override in tests. Default: `Date.now`. */
  readonly now?: () => UnixMillis
  /** WebSocket constructor override — tests pass a mock. Default: `ws`. */
  readonly webSocketCtor?: typeof NodeWebSocket
  /** Random source for jitter — override in tests. Default: `Math.random`. */
  readonly random?: () => number
  /** timer.setTimeout override for tests. */
  readonly setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout
  readonly clearTimeout?: (h: NodeJS.Timeout) => void
  readonly setInterval?: (fn: () => void, ms: number) => NodeJS.Timeout
  readonly clearInterval?: (h: NodeJS.Timeout) => void
}

type Listener<E extends keyof WsClientEvents> = WsClientEvents[E]

/**
 * AgentChat channel WebSocket client.
 *
 * Lifecycle:
 *   1. `start()` — DISCONNECTED → CONNECTING. Transport opens, HELLO is sent.
 *   2. `hello.ok` → READY. Heartbeat timer starts. Upstream consumers begin.
 *   3. On socket drop → DISCONNECTED → CONNECTING (with backoff).
 *   4. `stop(deadlineMs)` → DRAINING. Wait for in-flight drains, then CLOSED.
 *
 * Thread-safety: this class is single-threaded. All callbacks fire on the
 * Node event loop; callers should never invoke public methods from timer
 * callbacks without being aware of reentrancy (e.g., a `stateChanged`
 * listener that calls `send()` is fine, but `start()` inside `closed()`
 * will re-enter the lifecycle — usually a bug).
 */
export class AgentchatWsClient {
  private readonly config: AgentchatChannelConfig
  private readonly logger: Logger
  private readonly metrics: MetricsRecorder
  private readonly now: () => UnixMillis
  private readonly WebSocketCtor: typeof NodeWebSocket
  private readonly random: () => number
  private readonly _setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout
  private readonly _clearTimeout: (h: NodeJS.Timeout) => void
  private readonly _setInterval: (fn: () => void, ms: number) => NodeJS.Timeout
  private readonly _clearInterval: (h: NodeJS.Timeout) => void

  private state: ConnectionState = { kind: 'DISCONNECTED' }
  private ws: WsInstance | null = null
  private attempt = 0
  private _ackNegotiated = false
  /**
   * Set by `closeSocket()` before it closes the current socket, read and
   * cleared by `handleClose()`. A close this client asked for says nothing
   * about the server, whatever code travelled with it.
   */
  private closeInitiatedLocally = false
  /** One error line per long outage / per run of rejected keys, then debug. */
  private longOutageAnnounced = false
  private authFailAnnounced = false

  private helloAckTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private drainTimer: NodeJS.Timeout | null = null

  private readonly listeners: {
    [K in keyof WsClientEvents]: Set<Listener<K>>
  } = {
    stateChanged: new Set(),
    inboundFrame: new Set(),
    error: new Set(),
    authenticated: new Set(),
    closed: new Set(),
  }

  constructor(options: WsClientOptions) {
    this.config = options.config
    this.logger = options.logger.child({ component: 'ws-client' })
    this.metrics = options.metrics
    this.now = options.now ?? Date.now
    this.WebSocketCtor = options.webSocketCtor ?? NodeWebSocket
    this.random = options.random ?? Math.random
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((h) => clearTimeout(h))
    this._setInterval = options.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this._clearInterval = options.clearInterval ?? ((h) => clearInterval(h))

    this.metrics.setConnectionState(this.state.kind)
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /** Current connection state. Read-only from the caller's perspective. */
  getState(): ConnectionState {
    return this.state
  }

  /**
   * True when the last `hello.ok` echoed the `ack` capability: the server
   * keeps envelopes `stored` until acknowledged — and this client never
   * acknowledges. False against a legacy server (envelopes marked on push).
   */
  get ackNegotiated(): boolean {
    return this._ackNegotiated
  }

  /**
   * Kick off connection. No-op if already connecting, authenticating, ready,
   * or waiting out a backoff / auth retry. Throws only on `CLOSED`.
   */
  start(): void {
    if (this.state.kind === 'CLOSED') {
      throw new Error('cannot start: client is closed. Create a new instance.')
    }
    if (this.state.kind !== 'DISCONNECTED' || this.reconnectTimer) {
      // Already in progress (AUTH_FAIL has its own retry timer) — nothing to do.
      return
    }
    this.openSocket(1)
  }

  /**
   * Request a graceful drain. The caller-supplied deadline is a Unix-ms
   * timestamp; after it passes, the socket is force-closed regardless of
   * remaining in-flight work. Safe to call from any state.
   */
  stop(deadline?: UnixMillis): void {
    const now = this.now()
    const computedDeadline = deadline ?? now + 5_000

    if (this.state.kind === 'DRAINING') {
      // Second stop() — tighten the deadline if the caller asked for
      // earlier closure, otherwise ignore.
      if (computedDeadline < this.state.deadline) {
        this.applyEvent({ type: 'DRAIN_REQUESTED', now, deadline: computedDeadline })
        this.scheduleDrainDeadline(computedDeadline)
      }
      return
    }

    if (isTerminal(this.state)) {
      return
    }

    this.applyEvent({ type: 'DRAIN_REQUESTED', now, deadline: computedDeadline })

    // `applyEvent` mutated `this.state`; widen the read so TS doesn't
    // over-narrow against the pre-apply snapshot (TS tracks the control-flow
    // narrowing across the earlier guards and isn't aware the method call
    // mutated state).
    const after = (this.state as ConnectionState).kind
    if (after === 'DRAINING') {
      this.scheduleDrainDeadline(computedDeadline)
    } else if (after === 'CLOSED') {
      this.closeSocket(1000, 'client drain (immediate)')
      this.emit('closed')
    }
  }

  /**
   * Signal that the operator has rotated the API key: leave AUTH_FAIL and
   * retry now instead of waiting for the slow retry timer. A no-op in every
   * other state (the client is already connecting or connected).
   */
  reconfigured(): void {
    if (this.state.kind !== 'AUTH_FAIL') return
    this.clearReconnectTimer()
    this.applyEvent({ type: 'RECONFIGURED' })
    this.openSocket(1)
  }

  on<E extends keyof WsClientEvents>(event: E, handler: Listener<E>): () => void {
    this.listeners[event].add(handler as Listener<E>)
    return () => {
      this.listeners[event].delete(handler as Listener<E>)
    }
  }

  // ─── Internals: socket lifecycle ─────────────────────────────────────

  private openSocket(attempt: number): void {
    if (this.state.kind === 'CLOSED') return
    this.attempt = attempt
    this.closeInitiatedLocally = false
    const now = this.now()
    this.applyEvent({ type: 'CONNECT', now, attempt })

    const url = `${this.config.apiBase.replace(/^http/, 'ws')}/v1/ws`

    let ws: WsInstance
    try {
      ws = new this.WebSocketCtor(url, {
        perMessageDeflate: false,
        // `ws` auto-pong is on by default — we keep it so heartbeat RTT
        // is symmetric even when the server initiates the ping.
        maxPayload: MAX_FRAME_BYTES,
      })
    } catch (err) {
      this.emitError(
        new AgentChatChannelError(
          classifyNetworkError(err),
          'ws constructor threw',
          { cause: err },
        ),
      )
      this.scheduleReconnect('ctor-failed')
      return
    }

    this.ws = ws
    this.bindSocket(ws)
  }

  private bindSocket(ws: WsInstance): void {
    ws.on('open', () => this.handleOpen())
    ws.on('message', (data, isBinary) => this.handleMessage(data, isBinary))
    ws.on('pong', () => this.handlePong())
    ws.on('close', (code, reason) => this.handleClose(code, reason.toString()))
    ws.on('error', (err) => {
      this.emitError(
        new AgentChatChannelError(
          classifyNetworkError(err),
          'ws transport error',
          { cause: err },
        ),
      )
      // Don't transition here — `close` always follows `error`. Let
      // handleClose drive the state transition.
    })
  }

  private handleOpen(): void {
    if (!this.ws) return
    const now = this.now()
    this.applyEvent({ type: 'SOCKET_OPEN', now })

    // Send HELLO. This is the sole authentication path — the server will
    // reject any non-hello frame before `hello.ok` and close 1008.
    try {
      this.ws.send(
        JSON.stringify({
          type: 'hello',
          api_key: this.config.apiKey,
          client: AGENTCHAT_CLIENT_NAME,
          client_version: PACKAGE_VERSION,
          capabilities: HELLO_CAPABILITIES,
        }),
      )
    } catch (err) {
      this.emitError(
        new AgentChatChannelError(
          'retry-transient',
          'hello send failed',
          { cause: err },
        ),
      )
      this.closeSocket(1011, 'hello send failed')
      return
    }

    // Bound the handshake. Server has a 5s HELLO_TIMEOUT; we stay under.
    // 1001 (going away): a slow handshake is our own decision to hang up,
    // not a policy verdict, and `handleClose` sees it as ours either way.
    this.helloAckTimer = this._setTimeout(() => {
      this.helloAckTimer = null
      this.logger.warn({ timeoutMs: HELLO_ACK_TIMEOUT_MS }, 'hello ack timeout')
      this.emitError(
        new AgentChatChannelError('retry-transient', 'hello ack timeout'),
      )
      this.closeSocket(1001, 'hello ack timeout')
    }, HELLO_ACK_TIMEOUT_MS)
  }

  private handleMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.logger.warn({}, 'received binary frame — dropping (text-only protocol)')
      return
    }

    const received = this.now()

    // `RawData` can be Buffer | ArrayBuffer | Buffer[]. Normalize to string.
    const text =
      typeof data === 'string'
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8')

    if (text.length > MAX_FRAME_BYTES) {
      this.logger.warn({ bytes: text.length }, 'oversized frame — dropping')
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      this.emitError(
        new AgentChatChannelError(
          'validation',
          'malformed json frame',
          { cause: err },
        ),
      )
      return
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.emitError(
        new AgentChatChannelError('validation', 'frame not an object'),
      )
      return
    }

    const obj = parsed as Record<string, unknown>
    const type = typeof obj.type === 'string' ? obj.type : null
    if (!type) {
      this.emitError(
        new AgentChatChannelError('validation', 'frame missing type'),
      )
      return
    }

    // Intercept the handshake ack. Never surfaces to subscribers — the
    // normalizer (P3) only sees app-level server events.
    if (this.state.kind === 'AUTHENTICATING') {
      if (type === 'hello.ok') {
        this.handleHelloOk(received, obj)
        return
      }
      if (type === 'hello.error' || type === 'auth.rejected' || type === 'error') {
        const reason = this.extractReason(obj) ?? 'auth rejected'
        this.handleAuthRejected(reason)
        return
      }
      // Frames that arrive mid-handshake before hello.ok are protocol
      // violations — close and reconnect.
      this.logger.warn({ type }, 'frame arrived before hello.ok — ignoring')
      return
    }

    const payload = this.extractPayload(obj)

    this.emit('inboundFrame', {
      type,
      payload,
      receivedAt: received,
      raw: parsed,
    })
  }

  private extractReason(obj: Record<string, unknown>): string | undefined {
    const payload = obj.payload
    if (payload && typeof payload === 'object') {
      const msg = (payload as Record<string, unknown>).message
      if (typeof msg === 'string') return msg
      const reason = (payload as Record<string, unknown>).reason
      if (typeof reason === 'string') return reason
    }
    const top = obj.message ?? obj.reason
    return typeof top === 'string' ? top : undefined
  }

  private extractPayload(obj: Record<string, unknown>): Record<string, unknown> {
    const payload = obj.payload
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  }

  private handleHelloOk(now: UnixMillis, frame: Record<string, unknown>): void {
    if (this.helloAckTimer) {
      this._clearTimeout(this.helloAckTimer)
      this.helloAckTimer = null
    }
    // The server echoes the capabilities it accepted; a `hello.ok` without
    // the field is a legacy server (ack-mode off, envelopes marked on push).
    const caps = frame.capabilities ?? this.extractPayload(frame).capabilities
    this._ackNegotiated = Array.isArray(caps) && caps.includes('ack')
    this.logger.info({ ackNegotiated: this._ackNegotiated }, 'hello.ok')
    this.applyEvent({ type: 'HELLO_OK', now })
    this.attempt = 0
    this.longOutageAnnounced = false
    this.authFailAnnounced = false
    this.startHeartbeat()
    this.emit('authenticated', now)
  }

  /** The server answered HELLO with a rejection frame (not a close). */
  private handleAuthRejected(reason: string): void {
    if (this.helloAckTimer) {
      this._clearTimeout(this.helloAckTimer)
      this.helloAckTimer = null
    }
    // Enter AUTH_FAIL first so the socket's own close event (synchronous
    // in some transports) finds the retry already scheduled and does nothing.
    this.enterAuthFail(reason)
    this.closeSocket(1000, 'auth rejected')
  }

  /**
   * The server rejected this key. AUTH_FAIL is not the end: retry a fresh
   * HELLO every `AUTH_RETRY_INTERVAL_MS` (jittered). The first rejection in a
   * run logs at error so an operator sees it; the following ones at debug.
   */
  private enterAuthFail(reason: string): void {
    this.logger[this.authFailAnnounced ? 'debug' : 'error'](
      { reason, retryIntervalMs: AUTH_RETRY_INTERVAL_MS, attempt: this.attempt },
      'auth rejected — retrying slowly until the key is accepted again',
    )
    this.authFailAnnounced = true
    this.applyEvent({ type: 'AUTH_REJECTED', reason })
    this.emitError(
      new AgentChatChannelError('terminal-auth', `auth rejected: ${reason}`),
    )
    this.scheduleAuthRetry()
  }

  private handleClose(code: number, reason: string): void {
    const wasAuthenticating = this.state.kind === 'AUTHENTICATING'
    const wasDraining = this.state.kind === 'DRAINING'
    const ours = this.closeInitiatedLocally
    this.closeInitiatedLocally = false
    // Only a close the SERVER sent during the handshake, with a code and
    // reason that mean rejection, is a rejection.
    const serverAuthClose = !ours && isHandshakeRejection(code, reason)

    this.stopHeartbeat()
    if (this.helloAckTimer) {
      this._clearTimeout(this.helloAckTimer)
      this.helloAckTimer = null
    }
    this.ws = null
    this._ackNegotiated = false

    // Widened read: TS narrows `this.state` from the comparisons above and
    // would otherwise reject this check (see the same note in `stop()`).
    const kind = (this.state as ConnectionState).kind
    if (kind === 'CLOSED') {
      // `drainCompleted()` already moved us to CLOSED and emitted `closed`;
      // this is the socket's own close event arriving afterwards. Nothing to
      // transition, nothing to emit twice.
      this.logger.debug({ code, reason }, 'socket closed after CLOSED — no-op')
      return
    }
    if (kind === 'AUTH_FAIL') {
      // `handleAuthRejected` already entered AUTH_FAIL and scheduled the
      // retry; this is our own close of that socket arriving afterwards.
      this.logger.debug({ code, reason }, 'socket closed after AUTH_FAIL — retry already scheduled')
      return
    }

    if (serverAuthClose && wasAuthenticating) {
      this.enterAuthFail(`close ${code}: ${reason}`)
      return
    }

    this.applyEvent({ type: 'SOCKET_CLOSED', code, reason })

    if (wasDraining || this.state.kind === 'CLOSED') {
      this.emit('closed')
      return
    }

    this.logger.info(
      { code, reason, ours, attempt: this.attempt },
      'socket closed — scheduling reconnect',
    )
    this.scheduleReconnect(`close-${code}`)
  }

  private closeSocket(code: number, reason: string): void {
    if (!this.ws) return
    // Mark before closing: `ws` may emit `close` synchronously from here.
    this.closeInitiatedLocally = true
    try {
      this.ws.close(code, reason)
    } catch {
      // Already closed or in an invalid state — `close` will still fire.
    }
  }

  // ─── Internals: heartbeat ────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const intervalMs = this.config.ping.intervalMs
    this.pingTimer = this._setInterval(() => this.sendPing(), intervalMs)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      this._clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.pongTimer) {
      this._clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private sendPing(): void {
    if (!this.ws || this.ws.readyState !== NodeWebSocket.OPEN) return
    try {
      this.ws.ping()
    } catch (err) {
      this.emitError(
        new AgentChatChannelError(
          'retry-transient',
          'ws ping failed',
          { cause: err },
        ),
      )
      return
    }
    const timeoutMs = this.config.ping.timeoutMs
    if (this.pongTimer) this._clearTimeout(this.pongTimer)
    this.pongTimer = this._setTimeout(() => {
      this.pongTimer = null
      const now = this.now()
      this.logger.warn({ timeoutMs }, 'ping timeout — declaring degraded')
      this.applyEvent({ type: 'PING_TIMEOUT', now })
      // The server has gone silent. Force-reconnect — the state machine
      // moves READY → DEGRADED on PING_TIMEOUT, but we need to actually
      // tear down the socket so `close` re-drives reconnect.
      this.closeSocket(1011, 'ping timeout')
    }, timeoutMs)
  }

  private handlePong(): void {
    if (this.pongTimer) {
      this._clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
    // If we were in DEGRADED due to backpressure, pong alone isn't the
    // recovery signal — backpressure clears when the outbound queue drains.
    // But if we were in DEGRADED due to ping-timeout (shouldn't happen —
    // we close immediately on that path), a pong would recover us.
    if (this.state.kind === 'DEGRADED' && this.state.reason === 'ping-timeout') {
      this.applyEvent({ type: 'RECOVERED', now: this.now() })
    }
  }

  // ─── Internals: reconnect ────────────────────────────────────────────

  private scheduleReconnect(reason: string): void {
    if (this.state.kind === 'CLOSED' || this.state.kind === 'AUTH_FAIL') return
    if (this.reconnectTimer) return

    const nextAttempt = this.attempt + 1

    if (nextAttempt > RECONNECT_LONG_OUTAGE_AFTER_ATTEMPTS && !this.longOutageAnnounced) {
      // Once per outage, at error level: the operator should know the
      // control plane has been unreachable for this long. Retrying goes on.
      this.longOutageAnnounced = true
      this.logger.error(
        {
          attempt: nextAttempt,
          maxBackoffMs: Math.max(this.config.reconnect.maxBackoffMs, RECONNECT_LONG_OUTAGE_BACKOFF_MS),
        },
        `still reconnecting after ${RECONNECT_LONG_OUTAGE_AFTER_ATTEMPTS} attempts — backing off further, not giving up`,
      )
    }

    const delay = this.computeReconnectDelay(nextAttempt)
    this.metrics.incReconnect({ reason })
    this.logger.info(
      { attempt: nextAttempt, delayMs: delay, reason },
      'scheduling reconnect',
    )

    this.reconnectTimer = this._setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket(nextAttempt)
    }, delay)
  }

  /** AUTH_FAIL's own cadence: a fresh HELLO every AUTH_RETRY_INTERVAL_MS, jittered. */
  private scheduleAuthRetry(): void {
    if (this.state.kind !== 'AUTH_FAIL') return
    this.clearReconnectTimer()
    const nextAttempt = this.attempt + 1
    const delay = this.jittered(AUTH_RETRY_INTERVAL_MS)
    this.metrics.incReconnect({ reason: 'auth-retry' })
    this.logger.debug({ attempt: nextAttempt, delayMs: delay }, 'scheduling auth retry')
    this.reconnectTimer = this._setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket(nextAttempt)
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      this._clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private computeReconnectDelay(attempt: number): number {
    const { initialBackoffMs, maxBackoffMs } = this.config.reconnect
    // `attempt` is the total connection count (1 = initial connect, 2+ =
    // reconnects). Backoff scales with the *reconnect* count, so the first
    // reconnect uses `initialBackoffMs * 2^0 = initialBackoffMs`.
    const reconnectCount = Math.max(1, attempt - 1)
    const exp = initialBackoffMs * Math.pow(2, Math.min(reconnectCount - 1, 20))
    // A long outage widens the cap: a down control plane is polled every few
    // minutes instead of every `maxBackoffMs`, for as long as it takes.
    const cap =
      attempt > RECONNECT_LONG_OUTAGE_AFTER_ATTEMPTS
        ? Math.max(maxBackoffMs, RECONNECT_LONG_OUTAGE_BACKOFF_MS)
        : maxBackoffMs
    return this.jittered(Math.min(exp, cap))
  }

  /**
   * Symmetric ±`jitterRatio`. Thundering-herd-safe: a fleet that all drops
   * at the same instant re-enters the connect queue spread across
   * ms * [1-jitterRatio, 1+jitterRatio].
   */
  private jittered(ms: number): number {
    const { jitterRatio } = this.config.reconnect
    const jitter = 1 - jitterRatio + this.random() * 2 * jitterRatio
    return Math.max(0, Math.floor(ms * jitter))
  }

  // ─── Internals: drain ────────────────────────────────────────────────

  private scheduleDrainDeadline(deadline: UnixMillis): void {
    if (this.drainTimer) this._clearTimeout(this.drainTimer)
    const now = this.now()
    const delay = Math.max(0, deadline - now)
    this.drainTimer = this._setTimeout(() => {
      this.drainTimer = null
      if (this.state.kind === 'DRAINING') {
        this.logger.warn({ deadline }, 'drain deadline exceeded — force-closing')
        this.applyEvent({ type: 'DRAIN_COMPLETED' })
        this.closeSocket(1000, 'drain deadline')
        this.emit('closed')
      }
    }, delay)
  }

  /**
   * Called by upper layers when their pending work has fully drained, to
   * let the WS client transition CLOSED earlier than the deadline.
   */
  drainCompleted(): void {
    if (this.state.kind !== 'DRAINING') return
    if (this.drainTimer) {
      this._clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
    this.applyEvent({ type: 'DRAIN_COMPLETED' })
    this.closeSocket(1000, 'drain completed')
    this.emit('closed')
  }

  // ─── Internals: state machine + emit ─────────────────────────────────

  private applyEvent(event: ConnectionEvent): void {
    const prev = this.state
    const next = transition(prev, event)
    if (next === prev) {
      // No transition — log at debug so we see invalid events without
      // crashing. Useful for catching bugs in upper layers.
      this.logger.debug(
        { from: prev.kind, event: event.type },
        'transition.invalid',
      )
      return
    }
    this.state = next
    if (next.kind === 'CLOSED') {
      // A backoff or auth-retry timer pending at stop() must die with the
      // client, or it would open a fresh socket after `closed` was emitted.
      this.clearReconnectTimer()
    }
    this.metrics.setConnectionState(next.kind)
    this.logger.info(
      { from: prev.kind, to: next.kind, event: event.type },
      'state transition',
    )
    this.emit('stateChanged', next, prev)
  }

  private emit<E extends keyof WsClientEvents>(
    event: E,
    ...args: Parameters<WsClientEvents[E]>
  ): void {
    for (const listener of this.listeners[event]) {
      try {
        ;(listener as (...a: unknown[]) => void)(...(args as unknown[]))
      } catch (err) {
        this.logger.error(
          { event, err: err instanceof Error ? err.message : String(err) },
          'listener threw — continuing',
        )
      }
    }
  }

  private emitError(error: AgentChatChannelError): void {
    this.metrics.incError({ errorClass: error.class_ })
    this.logger.warn(
      { class: error.class_, message: error.message, statusCode: error.statusCode },
      'channel error',
    )
    this.emit('error', error)
  }
}

/**
 * Classify a low-level error with the WS client's conventions — exported
 * for integration tests that want to assert on error class directly.
 */
export function classifyWsError(err: unknown): ErrorClass {
  return classifyNetworkError(err)
}
