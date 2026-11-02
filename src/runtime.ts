/**
 * AgentChat channel runtime — the socket as a knock.
 *
 * One instance per (channelId, accountId). It owns the WebSocket transport
 * (`AgentchatWsClient`: HELLO, state machine, heartbeat, reconnect) and turns
 * what arrives on it into knocks for the doorbell's invoker:
 *
 *   - `message.new`              → `onKnock('message')` — after reading only
 *                                   the sender (to skip our own echo) and the
 *                                   ids for the log line. The body is never
 *                                   looked at; the agent reads it through the
 *                                   hosted tools inside its turn.
 *   - every successful HELLO     → `onKnock('connect')` — whatever landed
 *                                   while the socket was down is on the tray.
 *   - `group.invite.received`    → `onGroupInvite(invite)` — the second knock
 *                                   kind; not on the tray, not gated.
 *
 * Nothing is parsed into message shapes, nothing is acknowledged, nothing is
 * sent: the socket advertises the `ack` capability so the server keeps every
 * envelope `stored` until a verdict or a send settles it, and this runtime
 * has no code path that could emit an ack frame (`ws-client.ts`). Delivery
 * is judged by the agent, never by the transport.
 */

import type { Logger } from './log.js'
import type { MetricsRecorder } from './metrics.js'
import { createLogger, type LogLevel } from './log.js'
import { createNoopMetrics } from './metrics.js'
import type { AgentchatChannelConfig } from './config-schema.js'
import { AgentchatWsClient, type InboundFrame } from './ws-client.js'
import { readGroupInviteKnock, readMessageKnock, type GroupInviteKnock } from './knock-frames.js'
import type { AgentChatChannelError } from './errors.js'
import type { ConnectionState } from './state-machine.js'
import type { UnixMillis } from './types.js'

export type KnockSource = 'message' | 'connect'

export interface ChannelRuntimeHandlers {
  /** A knock: the tray may have changed. `source` is for the log line only. */
  onKnock?: (source: KnockSource) => void
  /** The second knock kind. */
  onGroupInvite?: (invite: GroupInviteKnock) => void
  /** Called on state transitions — surface to the gateway for health/UI. */
  onStateChanged?: (next: ConnectionState, prev: ConnectionState) => void
  /** Called once per successful HELLO (initial + every reconnect), before the connect knock. */
  onAuthenticated?: (at: UnixMillis) => void
  /** Called on every closed/unreachable situation worth observing. */
  onError?: (error: AgentChatChannelError) => void
}

export interface ChannelRuntimeOptions {
  readonly config: AgentchatChannelConfig
  readonly handlers?: ChannelRuntimeHandlers
  /** Pre-built logger — if absent, we construct one from `config.observability`. */
  readonly logger?: Logger
  /** Pre-built metrics recorder — if absent, uses no-op. */
  readonly metrics?: MetricsRecorder
  /** Provided by tests. */
  readonly webSocketCtor?: ConstructorParameters<typeof AgentchatWsClient>[0]['webSocketCtor']
  readonly now?: () => UnixMillis
  readonly random?: () => number
}

export interface HealthSnapshot {
  readonly state: ConnectionState
  readonly authenticated: boolean
  /** Whether the server echoed the `ack` capability on the last HELLO (envelopes stay `stored` until judged). */
  readonly ackNegotiated: boolean
  readonly counters: {
    readonly frames: number
    readonly selfFiltered: number
    readonly knocks: number
    readonly invites: number
  }
}

export class AgentchatChannelRuntime {
  private readonly config: AgentchatChannelConfig
  private readonly handlers: ChannelRuntimeHandlers
  private readonly logger: Logger
  private readonly ws: AgentchatWsClient
  private readonly selfHandle: string | undefined
  private readonly now: () => UnixMillis
  private started = false
  private authenticated = false
  private stopPromise: Promise<void> | null = null

  private frames = 0
  private selfFiltered = 0
  private knocks = 0
  private invites = 0

  constructor(opts: ChannelRuntimeOptions) {
    this.config = opts.config
    this.handlers = opts.handlers ?? {}
    this.now = opts.now ?? Date.now
    this.logger =
      opts.logger ??
      createLogger({
        level: this.config.observability.logLevel as LogLevel,
        redactKeys: this.config.observability.redactKeys,
      })
    this.selfHandle = this.config.agentHandle?.replace(/^@/, '').toLowerCase()

    this.ws = new AgentchatWsClient({
      config: this.config,
      logger: this.logger,
      metrics: opts.metrics ?? createNoopMetrics(),
      webSocketCtor: opts.webSocketCtor,
      now: opts.now,
      random: opts.random,
    })
    this.bindWsEvents()
  }

  /** Open the transport. Idempotent — subsequent calls are no-ops. */
  start(): void {
    if (this.started) return
    this.started = true
    this.ws.start()
  }

  /** Graceful shutdown: close the socket (nothing is in flight — the runtime sends nothing). */
  stop(deadlineMs?: UnixMillis): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const deadline = deadlineMs ?? this.now() + 5_000
    this.stopPromise = new Promise<void>((resolve) => {
      const off = this.ws.on('closed', () => {
        off()
        resolve()
      })
      this.ws.stop(deadline)
      // No outbound work exists, so the drain completes at once.
      this.ws.drainCompleted()
    })
    return this.stopPromise
  }

  /** Operator rotated the API key — leave AUTH_FAIL so the next `start()` can retry. */
  reconfigured(): void {
    this.ws.reconfigured()
  }

  getHealth(): HealthSnapshot {
    return {
      state: this.ws.getState(),
      authenticated: this.authenticated,
      ackNegotiated: this.ws.ackNegotiated,
      counters: { frames: this.frames, selfFiltered: this.selfFiltered, knocks: this.knocks, invites: this.invites },
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private bindWsEvents(): void {
    this.ws.on('stateChanged', (next, prev) => {
      if (next.kind !== 'READY' && next.kind !== 'DEGRADED') this.authenticated = false
      this.guard('onStateChanged', () => this.handlers.onStateChanged?.(next, prev))
    })

    this.ws.on('authenticated', (at) => {
      this.authenticated = true
      if (!this.ws.ackNegotiated) {
        // A server that does not echo `ack` marks envelopes delivered on
        // push — the pre-v3 window. Loud, so an operator sees it.
        this.logger.warn({}, 'server did not negotiate the ack capability — envelopes will be marked delivered on push, before any verdict')
      }
      this.guard('onAuthenticated', () => this.handlers.onAuthenticated?.(at))
      // Whatever landed while the socket was down is on the tray now; the
      // connect itself is the knock that covers the gap.
      this.knock('connect')
    })

    this.ws.on('inboundFrame', (frame) => this.dispatchFrame(frame))

    this.ws.on('error', (error) => {
      this.guard('onError', () => this.handlers.onError?.(error))
    })
  }

  private dispatchFrame(frame: InboundFrame): void {
    this.frames += 1
    if (frame.type === 'message.new') {
      const knock = readMessageKnock(frame)
      if (!knock) return
      if (this.selfHandle && knock.sender === this.selfHandle) {
        // Server-side fan-out echoes our own sends back; our own words never wake us.
        this.selfFiltered += 1
        this.logger.debug({ conversationId: knock.conversationId, messageId: knock.messageId }, 'own echo — not a knock')
        return
      }
      this.logger.info(
        { conversationId: knock.conversationId, messageId: knock.messageId, from: knock.sender || '?' },
        'knock — message.new',
      )
      this.knock('message')
      return
    }
    if (frame.type === 'group.invite.received') {
      const invite = readGroupInviteKnock(frame)
      if (!invite) {
        this.logger.warn({ keys: Object.keys(frame.payload).sort() }, 'group.invite.received without ids — dropped')
        return
      }
      this.invites += 1
      this.guard('onGroupInvite', () => this.handlers.onGroupInvite?.(invite))
      return
    }
    // typing, read receipts, presence, rate-limit advisories, group.deleted,
    // unknown frames: not knocks. The agent sees presence and receipts
    // through the hosted tools when it looks.
    this.logger.debug({ type: frame.type }, 'frame — not a knock')
  }

  private knock(source: KnockSource): void {
    this.knocks += 1
    this.guard('onKnock', () => this.handlers.onKnock?.(source))
  }

  /** A failing handler never takes the socket down; the next frame knocks again and the tray keeps the cards. */
  private guard(name: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.logger.error({ err: err instanceof Error ? err.message : String(err), handler: name }, 'handler threw — continuing')
    }
  }
}
