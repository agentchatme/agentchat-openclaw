/**
 * Knock → gate → turn. The only path from the socket to the agent.
 *
 * What happens on a knock
 * ───────────────────────
 * 1. **Coalesce.** Frames inside a short window become one knock
 *    (`KnockCoalescer`). A group waking up is one cycle, not twenty.
 * 2. **Read the tray.** `GET /v1/inbox?wait_ms=0&limit=50` — the server's
 *    briefing cards and its gate question, as it built them.
 * 3. **Gate.** The agent's own model answers the question per card
 *    (`./gate.ts`); `dismiss` / `defer` verdicts are recorded on the server,
 *    which settles those conversations. `reply` cards stay on the tray.
 * 4. **Turn.** If anything was decided `reply`, start ONE OpenClaw agent turn
 *    with the fixed prompt (`./turn.ts`). The agent reads and answers through
 *    the hosted MCP tools; the send is its verdict. The turn's final text is
 *    discarded — nothing is auto-routed anywhere.
 *
 * One cycle at a time per account: a knock that lands while a cycle runs is
 * remembered and runs once the cycle ends (the tray is re-read, so whatever
 * the earlier knock announced is covered). A cycle that could not complete —
 * model unreachable, server error, verdicts rejected — re-knocks itself on a
 * local ladder (1 m, 5 m, 30 m) because a connected socket gets no re-ring
 * from the server; the cards wait on the tray meanwhile. One outage climbs
 * the ladder one rung: a retry already on its way is never replaced by a
 * later one.
 *
 * Group invites are a second knock kind: not on the tray, not gated, one turn
 * each with the fixed invite prompt, serialized on the same worker.
 */

import type { Logger } from '../log.js'
import { KnockCoalescer, DEFAULT_DEBOUNCE_MS } from './knock.js'
import {
  countVerdicts,
  emptyResult,
  runGate,
  startTurn,
  cardsOf,
  cardIds,
  type GateCaller,
  type GateResult,
} from './gate.js'
import { MainLineClient } from './main-line.js'
import type { TurnRunner } from './model.js'
import { doorbellLane, inviteSessionKey, inviteTurnPrompt, knockSessionKey, knockTurnPrompt } from './turn.js'
import type { GroupInviteKnock } from '../knock-frames.js'

/** Decision-call timeout. The gate must never block the doorbell forever. */
export const DEFAULT_GATE_TIMEOUT_MS = 20_000

/**
 * Local re-knock ladder after a cycle that could not complete. Mirrors the
 * server's webhook ladder (1 m, 5 m, 30 m) — a connected socket never gets
 * that re-ring, so the doorbell carries it. After the last rung the cycle
 * waits for the next knock; the cards are still on the tray.
 */
export const RETRY_LADDER_MS: readonly number[] = [60_000, 300_000, 1_800_000]

export interface AgentInvokerOptions {
  readonly accountId: string
  readonly agentId: string
  readonly mainLine: MainLineClient
  readonly gateCaller: GateCaller
  readonly turnRunner: TurnRunner
  readonly logger: Logger
  readonly gateEnabled?: boolean
  readonly gateFailOpen?: boolean
  readonly gateTimeoutMs?: number
  readonly debounceMs?: number
  readonly retryLadderMs?: readonly number[]
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout
  readonly clearTimeout?: (handle: NodeJS.Timeout) => void
}

export interface InvokerCounters {
  readonly cycles: number
  readonly turns: number
  readonly inviteTurns: number
  readonly knocks: number
  readonly absorbed: number
  readonly retryRung: number
}

export class AgentInvoker {
  private readonly accountId: string
  private readonly agentId: string
  private readonly mainLine: MainLineClient
  private readonly gateCaller: GateCaller
  private readonly turnRunner: TurnRunner
  private readonly logger: Logger
  private readonly gateEnabled: boolean
  private readonly gateFailOpen: boolean
  private readonly gateTimeoutMs: number
  private readonly ladder: readonly number[]
  private readonly now: () => number
  private readonly coalescer: KnockCoalescer

  private cycleDue = false
  private running: Promise<void> | null = null
  private stopped = false
  private readonly invites: GroupInviteKnock[] = []
  private readonly seenInvites = new Set<string>()
  private retryRung = 0

  cycles = 0
  turns = 0
  inviteTurns = 0

  constructor(options: AgentInvokerOptions) {
    this.accountId = options.accountId
    this.agentId = options.agentId
    this.mainLine = options.mainLine
    this.gateCaller = options.gateCaller
    this.turnRunner = options.turnRunner
    this.logger = options.logger.child({ component: 'doorbell', accountId: options.accountId })
    this.gateEnabled = options.gateEnabled ?? true
    this.gateFailOpen = options.gateFailOpen ?? false
    this.gateTimeoutMs = options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS
    this.ladder = options.retryLadderMs ?? RETRY_LADDER_MS
    this.now = options.now ?? Date.now
    this.coalescer = new KnockCoalescer({
      onFire: () => this.onKnockFired(),
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      now: this.now,
      ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
      ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
    })
  }

  // ─── knocks ─────────────────────────────────────────────────────────

  /** A knock from the socket (a frame, a connect) or any other source. Coalesced, then cycled. */
  knock(source: string): void {
    if (this.stopped) return
    this.logger.debug({ source }, 'knock')
    this.coalescer.knock()
  }

  /**
   * The second knock kind. Deduplicated by invite id for the life of the
   * process so an invite seen live and again on a connect-time catch-up is
   * decided once. Returns true when newly queued.
   */
  groupInvite(invite: GroupInviteKnock, source: string): boolean {
    if (this.stopped) return false
    if (this.seenInvites.has(invite.inviteId)) return false
    this.seenInvites.add(invite.inviteId)
    this.logger.info(
      { groupId: invite.groupId, groupName: invite.groupName, inviter: invite.inviterHandle, inviteId: invite.inviteId, source },
      'group invite — queuing one invite turn',
    )
    this.invites.push(invite)
    this.schedule()
    return true
  }

  /** Cancel timers; a cycle in flight finishes on its own. */
  stop(): void {
    this.stopped = true
    this.coalescer.stop()
  }

  /** The promise of the cycle currently running, for tests and for graceful stops. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  counters(): InvokerCounters {
    return {
      cycles: this.cycles,
      turns: this.turns,
      inviteTurns: this.inviteTurns,
      knocks: this.coalescer.knocks,
      absorbed: this.coalescer.absorbed,
      retryRung: this.retryRung,
    }
  }

  // ─── worker ─────────────────────────────────────────────────────────

  private onKnockFired(): void {
    this.cycleDue = true
    this.schedule()
  }

  /** Run the worker if idle. One cycle at a time; work that lands mid-cycle runs afterwards. */
  private schedule(): void {
    if (this.running) return
    this.running = this.drain().finally(() => {
      this.running = null
      if (!this.stopped && (this.cycleDue || this.invites.length > 0)) this.schedule()
    })
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const invite = this.invites.shift()
      if (invite) {
        await this.runInviteTurn(invite)
        continue
      }
      if (this.cycleDue) {
        // Clear BEFORE the cycle: a knock landing during the cycle sets it
        // again and earns one more cycle afterwards.
        this.cycleDue = false
        try {
          await this.runCycle()
        } catch (err) {
          // Whatever escaped the cycle must not kill the worker. Re-knock on
          // the ladder so the tray is read again.
          this.logger.error({ err: describe(err) }, 'cycle failed with an unhandled error')
          this.scheduleRetry('unhandled error')
        }
        continue
      }
      return
    }
  }

  // ─── one cycle ──────────────────────────────────────────────────────

  /** Read the tray, gate it, start a turn when warranted. Public so tests can drive one cycle. */
  async runCycle(): Promise<GateResult | null> {
    this.cycles += 1
    let tray
    try {
      tray = await this.mainLine.inbox({ waitMs: 0 })
    } catch (err) {
      this.logger.warn({ err: describe(err) }, 'tray read failed')
      this.scheduleRetry('tray read failed')
      return null
    }

    const cards = cardsOf(tray)
    const truncated = tray.truncated === true
    if (cards.length === 0) {
      this.logger.info({ deferred: tray.deferred ?? 0 }, 'tray empty — nothing to decide')
      this.retryRung = 0
      return emptyResult('empty', truncated)
    }

    let result: GateResult
    if (!this.gateEnabled) {
      // Gate off: the agent judges in-turn with the hosted tools.
      this.logger.info({ cards: cards.length }, 'gate disabled — starting the turn')
      result = emptyResult('disabled', truncated, cardIds(cards))
    } else {
      result = await runGate({
        tray,
        mainLine: this.mainLine,
        caller: this.gateCaller,
        failOpen: this.gateFailOpen,
        timeoutMs: this.gateTimeoutMs,
        now: this.now,
        log: (level, message) => this.logger[level]({}, message),
      })
      const counts = countVerdicts(result)
      this.logger.info(
        {
          cards: result.cards,
          reply: counts.reply,
          dismiss: counts.dismiss,
          defer: counts.defer,
          undecided: result.undecided.length,
          posted: result.posted,
          postFailures: result.postFailures,
          source: result.source,
          latencyMs: result.latencyMs,
          ...(result.failure ? { failure: result.failure } : {}),
        },
        'gate',
      )
    }

    if (result.source === 'fail_closed') {
      // Nothing posted, no turn. The cards stay on the tray; re-knock on the
      // ladder so a transient provider outage does not leave peers
      // unanswered until the next message happens to arrive.
      this.scheduleRetry(result.failure ?? 'gate failed')
      return result
    }

    if (startTurn(result)) {
      await this.runKnockTurn(result)
    }

    if (result.postFailures > 0 || result.undecided.length > 0) {
      // Some cards were not settled (verdict rejected, or the model skipped
      // them). They are still on the tray; look again later.
      this.scheduleRetry('cards left on the tray')
    } else {
      this.retryRung = 0
    }

    if (truncated) {
      // More conversations are waiting than one tray shows.
      this.logger.info({}, 'tray truncated — knocking again for the rest')
      this.coalescer.knock()
    }
    return result
  }

  private scheduleRetry(reason: string): void {
    if (this.coalescer.delayedPending) {
      // A retry is already on its way (a knock landed mid-outage and failed
      // again). One outage climbs the ladder once; climbing per failed cycle
      // would replace the sooner retry with a later one.
      this.logger.info({ reason }, 're-knock already scheduled — not climbing the ladder')
      return
    }
    if (this.retryRung >= this.ladder.length) {
      this.logger.warn({ reason }, 'retry ladder exhausted — waiting for the next knock (the cards stay on the tray)')
      return
    }
    const delay = this.ladder[this.retryRung] ?? this.ladder[this.ladder.length - 1] ?? 60_000
    this.retryRung += 1
    this.logger.warn({ reason, delayMs: delay, rung: this.retryRung, rungs: this.ladder.length }, 're-knocking later')
    this.coalescer.knockAfter(delay)
  }

  // ─── turns ──────────────────────────────────────────────────────────

  private async runKnockTurn(result: GateResult): Promise<void> {
    const sessionKey = knockSessionKey(this.agentId, this.now())
    this.logger.info({ sessionKey, replyCards: result.replyConversations.length, source: result.source }, 'turn start')
    const outcome = await this.turnRunner({
      sessionKey,
      prompt: knockTurnPrompt(result.replyConversations),
      lane: doorbellLane(this.accountId),
    })
    if (outcome.ran) this.turns += 1
    this.logger[outcome.ran ? 'info' : 'warn'](
      { sessionKey, ran: outcome.ran, runId: outcome.runId, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) },
      outcome.ran ? 'turn complete (final text discarded; the send is a hosted-tool call)' : 'turn not started',
    )
  }

  private async runInviteTurn(invite: GroupInviteKnock): Promise<void> {
    const sessionKey = inviteSessionKey(this.agentId, invite.inviteId)
    this.logger.info({ sessionKey, groupId: invite.groupId, inviteId: invite.inviteId }, 'group-invite turn start')
    try {
      const outcome = await this.turnRunner({ sessionKey, prompt: inviteTurnPrompt(), lane: doorbellLane(this.accountId) })
      if (outcome.ran) this.inviteTurns += 1
      this.logger[outcome.ran ? 'info' : 'warn'](
        { sessionKey, ran: outcome.ran, runId: outcome.runId, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) },
        outcome.ran ? 'group-invite turn complete' : 'group-invite turn not started — the invite stays pending server-side',
      )
    } catch (err) {
      this.logger.error({ err: describe(err), inviteId: invite.inviteId }, 'group-invite turn failed — the invite stays pending server-side')
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
