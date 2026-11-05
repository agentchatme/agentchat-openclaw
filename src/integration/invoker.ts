/**
 * Wake → gate → turn. The only path from the socket to the agent.
 *
 * What happens on a wake
 * ──────────────────────
 * 1. **Coalesce.** Frames inside a short window become one wake
 *    (`WakeCoalescer`). A group waking up is one cycle, not twenty.
 * 2. **Read the tray.** `client.inbox.tray()` — the server's briefing cards
 *    and its gate question, as it built them.
 * 3. **Gate.** The SDK's gate helper renders the question and the cards,
 *    asks the agent's own model (`callModel`, a tool-free completion through
 *    `runtime.llm.complete`) and records `dismiss` / `defer` with the card's
 *    anchor. `reply` comes back as entries the invoker records itself.
 * 4. **Turn.** For every conversation decided `reply`, start ONE OpenClaw
 *    agent turn (`runtime.subagent.run`, `deliver: false`) with the served
 *    wake instruction and the conversation id. The `reply` verdict is
 *    recorded when the run has COMPLETED (`status: ok`) — never at its
 *    start: recorded at admission it marked the conversation read before
 *    the turn's own inbox call, which then waited on an empty tray, and a
 *    turn that crashed left the peer with a read receipt and no answer. A
 *    completed turn counts as read even if it chose not to send. A turn
 *    OpenClaw refuses, or one that ends in error or on the wait timeout,
 *    records nothing: the conversation stays unread, the card stays on the
 *    tray, and the ladder re-wakes so it is gated again (one more gate
 *    call, no silent drop). The turn's final text is discarded — nothing is
 *    auto-routed anywhere.
 *
 * One cycle at a time per account: a wake that lands while a cycle runs is
 * remembered and runs once the cycle ends (the tray is re-read, so whatever
 * the earlier wake announced is covered). A cycle ends when its turns are
 * ADMITTED, not when they finish: OpenClaw serializes the turns on the
 * account's lane (`integrationLane`), so the next cycle's turn simply queues
 * behind, and holding the wake loop for up to 15 minutes per turn would only
 * delay the next tray read. Completion is logged as it happens. A cycle
 * that could not complete — model unreachable, server error, turn refused —
 * re-wakes itself on a local ladder (1 m, 5 m, 30 m) because a connected
 * socket gets no re-wake from the server; the cards wait on the tray
 * meanwhile. One outage climbs the ladder one rung: a retry already on its
 * way is never replaced by a later one.
 *
 * Group invites are a second wake kind: not on the tray, not gated, one turn
 * each with the served invite prompt, serialized on the same worker. An
 * invite whose turn OpenClaw refused stays pending and is tried again on the
 * next wake; one that started is remembered on disk (`InviteLedger`) so a
 * restart never offers it twice.
 */

import { gate, type AgentChatClient, type GateReply, type InboxTray, type Texts } from 'agentchatme'

import type { Logger } from '../log.js'
import type { MetricsRecorder } from '../metrics.js'
import { createNoopMetrics } from '../metrics.js'
import { WakeCoalescer, DEFAULT_DEBOUNCE_MS } from './wake.js'
import type { GateModelCall, TurnStarter, TurnOutcome, TurnAdmission } from './model.js'
import type { GroupInvite } from './invites.js'
import { OPENCLAW_TOOL_NAMER, integrationLane, inviteSessionKey, inviteTurnPrompt, wakeSessionKey, wakeTurnPrompt } from './turn.js'

/**
 * Local re-wake ladder after a cycle that could not complete. Mirrors the
 * server's webhook ladder (1 m, 5 m, 30 m) — a connected socket never gets
 * that re-wake, so the integration carries it. After the last rung the cycle
 * waits for the next wake; the cards are still on the tray.
 */
export const RETRY_LADDER_MS: readonly number[] = [60_000, 300_000, 1_800_000]

/**
 * Where a wake came from — a closed set, because it is a metric label:
 * `message` (a peer wrote), `connect` (an accepted HELLO), `reminder` (the
 * server's wake frame for a deferred conversation), `retry` (the local
 * ladder), `other` (a server wake with a reason this version does not know).
 */
export type WakeSource = 'message' | 'connect' | 'reminder' | 'retry' | 'other'

/** The two SDK resources a cycle uses; `AgentChatClient` satisfies it. */
export type InvokerClient = Pick<AgentChatClient, 'inbox' | 'decisions'>

/** The served texts as the invoker sees them: the current copy, or one attempt to get it. */
export interface TextsSource {
  readonly current: Texts | null
  ensure(): Promise<Texts | null>
}

/** Which invites already got their turn (persisted across restarts). */
export interface InviteStore {
  isOffered(inviteId: string): boolean
  markOffered(inviteId: string): void
}

export interface AgentInvokerOptions {
  readonly accountId: string
  readonly agentId: string
  readonly client: InvokerClient
  readonly callModel: GateModelCall
  readonly startTurn: TurnStarter
  readonly texts: TextsSource
  readonly invites: InviteStore
  readonly logger: Logger
  /** Counts the ladder's re-wakes (`agentchat_channel_wake_total{source="retry"}`). The socket counts the others. */
  readonly metrics?: MetricsRecorder
  /** `false`: no gate step — one turn per cycle with the served wake instruction; the agent judges in-turn. */
  readonly gateEnabled?: boolean
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
  /** Turns admitted whose run has not ended yet (OpenClaw's lane serializes them). */
  readonly turnsInFlight: number
  readonly wakes: number
  readonly absorbed: number
  readonly retryRung: number
  readonly pendingInvites: number
}

export type CycleOutcome =
  /** The tray had no cards. */
  | 'empty'
  /** The gate decided; turns were started for the replies. */
  | 'decided'
  /** The model failed or answered nothing usable; nothing recorded, no turn. */
  | 'fail_closed'
  /** The gate is off; one turn with the served wake instruction. */
  | 'gate_off'
  /** The tray could not be read. */
  | 'tray_failed'
  /** The served texts are not available yet; nothing gated, the cards wait. */
  | 'texts_missing'

export interface CycleResult {
  readonly outcome: CycleOutcome
  readonly cards: number
  readonly reply: number
  readonly dismiss: number
  readonly defer: number
  readonly undecided: number
  /** `dismiss` / `defer` the server took in this cycle. `reply` verdicts are recorded as their turns complete, after the cycle. */
  readonly recorded: number
  readonly recordFailures: number
  readonly turnsStarted: number
  readonly turnsRefused: number
  readonly truncated: boolean
  readonly latencyMs: number
  readonly failure: string | null
}

type RetryPlan = { readonly kind: 'armed'; readonly delayMs: number; readonly rung: number } | { readonly kind: 'pending' } | { readonly kind: 'exhausted' }

export class AgentInvoker {
  private readonly accountId: string
  private readonly agentId: string
  private readonly client: InvokerClient
  private readonly callModel: GateModelCall
  private readonly startTurn: TurnStarter
  private readonly texts: TextsSource
  private readonly invites: InviteStore
  private readonly logger: Logger
  private readonly metrics: MetricsRecorder
  private readonly gateEnabled: boolean
  private readonly ladder: readonly number[]
  private readonly now: () => number
  private readonly coalescer: WakeCoalescer

  private cycleDue = false
  private running: Promise<void> | null = null
  private stopped = false
  private pendingInvites: GroupInvite[] = []
  private invitesDirty = false
  private retryRung = 0
  private turnsInFlight = 0

  cycles = 0
  turns = 0
  inviteTurns = 0

  constructor(options: AgentInvokerOptions) {
    this.accountId = options.accountId
    this.agentId = options.agentId
    this.client = options.client
    this.callModel = options.callModel
    this.startTurn = options.startTurn
    this.texts = options.texts
    this.invites = options.invites
    this.logger = options.logger.child({ component: 'integration', accountId: options.accountId })
    this.metrics = options.metrics ?? createNoopMetrics()
    this.gateEnabled = options.gateEnabled ?? true
    this.ladder = options.retryLadderMs ?? RETRY_LADDER_MS
    this.now = options.now ?? Date.now
    this.coalescer = new WakeCoalescer({
      onFire: () => this.onWakeFired(),
      onDelayedWake: () => {
        this.logger.debug({ source: 'retry' }, 'wake')
        this.metrics.incWake({ source: 'retry' })
      },
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      now: this.now,
      ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
      ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
    })
  }

  // ─── wakes ──────────────────────────────────────────────────────────

  /** A wake from the socket (a frame, a connect, a reminder) or any other source. Coalesced, then cycled. */
  wake(source: WakeSource): void {
    if (this.stopped) return
    this.logger.debug({ source }, 'wake')
    this.coalescer.wake()
  }

  /**
   * The second wake kind. An invite already offered (this process or an
   * earlier one, per the ledger) or already pending is ignored, so an
   * invite seen live and again on a connect-time catch-up is decided once.
   * Returns true when newly queued.
   */
  groupInvite(invite: GroupInvite, source: string): boolean {
    if (this.stopped) return false
    if (this.invites.isOffered(invite.inviteId)) return false
    if (this.pendingInvites.some((pending) => pending.inviteId === invite.inviteId)) return false
    this.logger.info(
      { groupId: invite.groupId, groupName: invite.groupName, inviter: invite.inviterHandle, inviteId: invite.inviteId, source },
      'group invite — queuing one invite turn',
    )
    this.pendingInvites.push(invite)
    this.invitesDirty = true
    this.schedule()
    return true
  }

  /** Cancel timers; a cycle in flight finishes on its own. */
  stop(): void {
    this.stopped = true
    this.coalescer.stop()
  }

  /** The promise of the work currently running, for tests and for graceful stops. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  counters(): InvokerCounters {
    return {
      cycles: this.cycles,
      turns: this.turns,
      inviteTurns: this.inviteTurns,
      turnsInFlight: this.turnsInFlight,
      wakes: this.coalescer.wakes,
      absorbed: this.coalescer.absorbed,
      retryRung: this.retryRung,
      pendingInvites: this.pendingInvites.length,
    }
  }

  // ─── worker ─────────────────────────────────────────────────────────

  private onWakeFired(): void {
    this.cycleDue = true
    // A wake is also the moment to retry invites whose turn OpenClaw refused.
    if (this.pendingInvites.length > 0) this.invitesDirty = true
    this.schedule()
  }

  /** Run the worker if idle. One cycle at a time; work that lands mid-cycle runs afterwards. */
  private schedule(): void {
    if (this.running) return
    this.running = this.drain().finally(() => {
      this.running = null
      if (!this.stopped && (this.cycleDue || this.invitesDirty)) this.schedule()
    })
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      if (this.invitesDirty) {
        this.invitesDirty = false
        await this.runInviteTurns()
        continue
      }
      if (this.cycleDue) {
        // Clear BEFORE the cycle: a wake landing during the cycle sets it
        // again and earns one more cycle afterwards.
        this.cycleDue = false
        try {
          await this.runCycle()
        } catch (err) {
          // Whatever escaped the cycle must not kill the worker. Re-wake on
          // the ladder so the tray is read again.
          this.logger.error({ err: describe(err), ...this.retry() }, 'cycle failed with an unhandled error — re-waking later')
        }
        continue
      }
      return
    }
  }

  // ─── one cycle ──────────────────────────────────────────────────────

  /** Read the tray, gate it, start a turn per reply. Public so tests can drive one cycle. */
  async runCycle(): Promise<CycleResult> {
    this.cycles += 1
    const started = this.now()
    let tray: InboxTray
    try {
      tray = await this.client.inbox.tray({ waitMs: 0 })
    } catch (err) {
      this.logger.warn({ err: describe(err), ...this.retry() }, 'tray read failed — re-waking later')
      return this.result('tray_failed', 0, false, started, describe(err))
    }

    const cards = gate.cardsOf(tray)
    const truncated = tray.truncated === true
    if (cards.length === 0) {
      this.logger.info({ deferred: tray.deferred ?? 0 }, 'tray empty — nothing to decide')
      this.retryRung = 0
      return this.result('empty', 0, truncated, started)
    }

    // The turn text is served, never bundled. Without it no turn can start,
    // so nothing is gated either: the cards wait, and the next copy (retried
    // by the texts store) or the next wake tries again.
    const texts = await this.texts.ensure()
    if (!texts) {
      this.logger.warn({ cards: cards.length, ...this.retry() }, 'served texts not available — not gating; the cards wait on the tray')
      return this.result('texts_missing', cards.length, truncated, started, 'texts missing')
    }

    let result: CycleResult
    if (!this.gateEnabled) {
      result = await this.runUngated(cards.length, texts, truncated, started)
    } else {
      result = await this.runGated(tray, cards.length, texts, truncated, started)
    }

    if (truncated && result.outcome !== 'fail_closed') {
      // More conversations are waiting than one tray shows.
      this.logger.info({}, 'tray truncated — waking again for the rest')
      this.coalescer.wake()
    }
    return result
  }

  /** Gate off: the agent judges in-turn with the hosted tools. One turn, nothing recorded here. */
  private async runUngated(cards: number, texts: Texts, truncated: boolean, started: number): Promise<CycleResult> {
    this.logger.info({ cards }, 'gate off — starting one turn with the served wake instruction')
    const sessionKey = wakeSessionKey(this.agentId, this.now())
    this.logger.info({ sessionKey }, 'turn start')
    const admission = await this.startTurn({ sessionKey, prompt: wakeTurnPrompt(texts), lane: integrationLane(this.accountId) })
    if (!admission.ran) {
      this.logger.warn({ sessionKey, error: admission.error, ...this.retry() }, 'turn not started — re-waking later')
    } else {
      this.admitted(sessionKey, admission, 'turn complete (final text discarded; the send is a hosted-tool call)')
      this.retryRung = 0
    }
    return {
      ...this.result('gate_off', cards, truncated, started),
      turnsStarted: admission.ran ? 1 : 0,
      turnsRefused: admission.ran ? 0 : 1,
    }
  }

  private async runGated(tray: InboxTray, cards: number, texts: Texts, truncated: boolean, started: number): Promise<CycleResult> {
    const decided = await gate.run({ tray, callModel: this.callModel, client: this.client, toolNamer: OPENCLAW_TOOL_NAMER })
    const latencyMs = this.now() - started
    const counts = { reply: 0, dismiss: 0, defer: 0 }
    for (const verdict of decided.verdicts) counts[verdict.decision] += 1

    if (decided.outcome === 'fail_closed') {
      // Nothing recorded, no turn. The cards stay on the tray; re-wake on
      // the ladder so a transient provider outage does not leave peers
      // unanswered until the next message happens to arrive. One line.
      this.logger.warn({ cards, failure: decided.failure, latencyMs, ...this.retry() }, 'gate failed closed — nothing recorded, no turn started')
      return { ...this.result('fail_closed', cards, truncated, started, decided.failure), undecided: cards, latencyMs }
    }
    if (decided.outcome === 'empty') {
      this.retryRung = 0
      return this.result('empty', cards, truncated, started)
    }

    // One turn per conversation decided reply. The verdict is recorded when
    // the run has completed (see `admitted`) — never here, at its start: a
    // refused, crashed or timed-out turn records nothing, the card stays on
    // the tray, and the ladder re-wakes so it is gated again. The cycle does
    // not wait for the runs to end: the lane serializes them.
    let turnsStarted = 0
    let turnsRefused = 0
    const recordFailures = decided.recordFailures.length
    const recorded = decided.recorded
    for (const entry of decided.reply) {
      const sessionKey = wakeSessionKey(this.agentId, this.now())
      this.logger.info({ sessionKey, conversationId: entry.conversationId }, 'turn start')
      const admission = await this.startTurn({ sessionKey, prompt: wakeTurnPrompt(texts, entry.conversationId), lane: integrationLane(this.accountId) })
      if (!admission.ran) {
        turnsRefused += 1
        this.logger.warn({ sessionKey, conversationId: entry.conversationId, error: admission.error }, 'turn not started — reply not recorded; the conversation stays unread')
        continue
      }
      turnsStarted += 1
      this.admitted(sessionKey, admission, 'turn complete (final text discarded; the send is a hosted-tool call)', entry)
    }

    const summary = {
      cards,
      reply: counts.reply,
      dismiss: counts.dismiss,
      defer: counts.defer,
      undecided: decided.undecided.length,
      recorded,
      recordFailures,
      turnsStarted,
      turnsRefused,
      latencyMs,
    }
    if (turnsRefused > 0) {
      this.logger.warn({ ...summary, ...this.retry() }, 'gate — some turns were refused; re-waking later')
    } else if (recordFailures > 0 || decided.undecided.length > 0) {
      // Some cards were not settled (verdict rejected, or the model skipped
      // them). They are still on the tray; look again later.
      this.logger.warn({ ...summary, ...this.retry() }, 'gate — cards left on the tray; re-waking later')
    } else {
      this.retryRung = 0
      this.logger.info(summary, 'gate')
    }
    return { ...this.result('decided', cards, truncated, started), ...summary }
  }

  private result(outcome: CycleOutcome, cards: number, truncated: boolean, started: number, failure: string | null = null): CycleResult {
    return {
      outcome,
      cards,
      reply: 0,
      dismiss: 0,
      defer: 0,
      undecided: 0,
      recorded: 0,
      recordFailures: 0,
      turnsStarted: 0,
      turnsRefused: 0,
      truncated,
      latencyMs: this.now() - started,
      failure,
    }
  }

  /** Arm the next rung (or report why not). Returned as log fields so every caller writes ONE line. */
  private retry(): { retry: RetryPlan } {
    if (this.coalescer.delayedPending) {
      // A retry is already on its way (a wake landed mid-outage and failed
      // again). One outage climbs the ladder once; climbing per failed cycle
      // would replace the sooner retry with a later one.
      return { retry: { kind: 'pending' } }
    }
    if (this.retryRung >= this.ladder.length) {
      return { retry: { kind: 'exhausted' } }
    }
    const delayMs = this.ladder[this.retryRung] ?? this.ladder[this.ladder.length - 1] ?? 60_000
    this.retryRung += 1
    this.coalescer.wakeAfter(delayMs)
    return { retry: { kind: 'armed', delayMs, rung: this.retryRung } }
  }

  // ─── turns ──────────────────────────────────────────────────────────

  /**
   * Book an admitted turn and log its end whenever it comes. The cycle moves
   * on at once; OpenClaw's lane keeps the runs of one account in order.
   *
   * For a reply turn the end is also when the `reply` verdict is recorded —
   * only if the run completed (`status: ok`, no error): a turn that looked
   * and chose not to send still counts as read. A run that ended in error,
   * on the wait timeout, or whose wait failed records nothing: the card stays
   * on the tray and the ladder re-wakes so the conversation is gated again.
   */
  private admitted(sessionKey: string, admission: Extract<TurnAdmission, { ran: true }>, completeLine: string, reply?: GateReply): void {
    this.turns += 1
    this.turnsInFlight += 1
    void admission.done.then(
      async (outcome: TurnOutcome) => {
        this.turnsInFlight -= 1
        const completed = outcome.ran && outcome.status === 'ok' && !outcome.error
        this.logger[completed ? 'info' : 'warn'](
          { sessionKey, runId: outcome.runId, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) },
          completeLine,
        )
        if (!reply) return
        if (!completed) {
          this.logger.warn(
            { sessionKey, conversationId: reply.conversationId, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}), ...this.retry() },
            'turn did not complete — reply not recorded; the conversation stays unread and is gated again',
          )
          return
        }
        await this.recordReply(sessionKey, reply)
      },
      async (err: unknown) => {
        this.turnsInFlight -= 1
        this.logger.warn({ sessionKey, runId: admission.runId, err: describe(err) }, `${completeLine} — the wait failed`)
        if (reply) {
          this.logger.warn(
            { sessionKey, conversationId: reply.conversationId, err: describe(err), ...this.retry() },
            'turn did not complete — reply not recorded; the conversation stays unread and is gated again',
          )
        }
      },
    )
  }

  /** The `reply` verdict for a completed turn. A record the server refuses leaves the conversation unread; the ladder re-wakes. */
  private async recordReply(sessionKey: string, reply: GateReply): Promise<void> {
    try {
      await reply.record()
      this.logger.info({ sessionKey, conversationId: reply.conversationId }, 'reply verdict recorded — turn completed')
    } catch (err) {
      this.logger.warn(
        { sessionKey, conversationId: reply.conversationId, err: describe(err), ...this.retry() },
        'reply verdict not recorded after the turn completed — the conversation stays unread; the next wake gates it again',
      )
    }
  }

  /**
   * Every pending invite gets one attempt. An invite leaves the pending list
   * only once its turn was admitted (and is then remembered in the ledger);
   * a refused one stays there for the next wake. Invites that arrive while
   * this runs are appended and get their pass on the next drain.
   */
  private async runInviteTurns(): Promise<void> {
    const batch = [...this.pendingInvites]
    let texts: Texts | null = null
    let refused = 0
    let waitingForTexts = 0
    for (const invite of batch) {
      if (this.stopped) return
      texts ??= await this.texts.ensure()
      if (!texts) {
        waitingForTexts = batch.length
        break
      }
      const sessionKey = inviteSessionKey(this.agentId, invite.inviteId)
      this.logger.info({ sessionKey, groupId: invite.groupId, inviteId: invite.inviteId }, 'group-invite turn start')
      let admission
      try {
        admission = await this.startTurn({ sessionKey, prompt: inviteTurnPrompt(texts), lane: integrationLane(this.accountId) })
      } catch (err) {
        admission = { ran: false as const, error: describe(err) }
      }
      if (!admission.ran) {
        refused += 1
        this.logger.warn({ sessionKey, inviteId: invite.inviteId, error: admission.error }, 'group-invite turn not started — the invite stays pending; retried on the next wake')
        continue
      }
      this.inviteTurns += 1
      this.invites.markOffered(invite.inviteId)
      this.pendingInvites = this.pendingInvites.filter((pending) => pending.inviteId !== invite.inviteId)
      this.admitted(sessionKey, admission, 'group-invite turn complete')
    }
    if (this.stopped) return
    if (waitingForTexts > 0) {
      this.logger.warn({ pending: waitingForTexts, ...this.retry() }, 'served texts not available — invite turns wait; re-waking later')
    } else if (refused > 0) {
      this.logger.warn({ pending: refused, ...this.retry() }, 'invite turns refused — re-waking later')
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
