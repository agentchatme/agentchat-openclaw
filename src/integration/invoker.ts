/**
 * Wake → tray → gate → one turn per reply → what actually happened.
 * The only path from the socket to the agent (gate-call mode, contract v1).
 *
 * What happens on a wake
 * ──────────────────────
 * 1. **Coalesce.** Frames inside a short window become one cycle (the kit's
 *    `WakeCoalescer`); a wake during a cycle earns exactly one more.
 * 2. **Read the tray.** `client.inbox.tray()` — the server's cards, its gate
 *    question, and the pending group invites (tray v1).
 * 3. **Leave running turns alone.** A card or invite whose turn is still
 *    running is that turn's: it is not gated again, so no second turn can
 *    answer the same message. A turn runs until OpenClaw confirms its run
 *    ended (`./run.ts`) — a wait that elapsed is not an end.
 * 4. **Gate.** The kit's gate renders the served gate-call texts, the
 *    question and the cards, asks the agent's own model (`callModel`, a
 *    tool-free completion), and records `dismiss` / `defer` at once.
 * 5. **Turn.** For every `reply`, one OpenClaw run with the served wake
 *    instruction and the conversation id. For every pending invite, one run
 *    with the served invite prompt. The cycle does not wait for the runs:
 *    OpenClaw's lane serializes them.
 * 6. **After the run ends,** the host records from what happened, never from
 *    the runtime's "turn ok" (D5, the kit's `turnOutcome`): a fresh tray read
 *    shows whether the turn recorded its own verdict, whether the answer
 *    went out (then `reply` is recorded through the anchor the gate saw), or
 *    whether it looked and did nothing (the second time for the same anchor
 *    is a `dismiss`). The run's AgentChat calls, counted from its transcript,
 *    tell a turn that could not look from one that chose silence. Invites
 *    follow the same rule (`inviteOutcome`).
 *
 * No retry ladder lives here. A cycle that could not finish (tray unread,
 * model unreachable, texts missing, tools not ready) records nothing and
 * leaves the cards on the tray; the server re-wakes unanswered cards on its
 * own durable ladder (D3). A truncated tray, and cards skipped while a turn
 * ran, earn one more cycle.
 */

import { gate, integration, type AgentChatClient, type GateReply, type InboxTray, type Texts, type TrayInvite } from 'agentchatme'

import type { Logger } from '../log.js'
import type { MetricsRecorder } from '../metrics.js'
import { createNoopMetrics } from '../metrics.js'
import type { GateModelCall, TurnStarter, TurnOutcome as RunOutcome, TurnAdmission, TurnReadiness } from './model.js'
import { RunningTurns, conversationKey, inviteKey, UNGATED_KEY, type RunningKind } from './running.js'
import { OPENCLAW_TOOL_NAMER, integrationLane, inviteSessionKey, wakeSessionKey, wakeTurnPrompt, inviteTurnPrompt } from './turn.js'

/**
 * Where a wake came from — a closed set, because it is a metric label:
 * `message` (a peer wrote), `connect` (an accepted HELLO), `reminder` (a
 * deferred conversation came due), `unanswered` (the server's re-wake for
 * cards still waiting), `invite` (a group invite arrived), `other` (a server
 * wake with a reason this version does not know).
 */
export type WakeSource = 'message' | 'connect' | 'reminder' | 'unanswered' | 'invite' | 'other'

/** The SDK resources a cycle uses; `AgentChatClient` satisfies it. */
export type InvokerClient = Pick<AgentChatClient, 'inbox' | 'decisions' | 'groups'>

/** The served texts as the invoker sees them: the current copy, or one attempt to get it. */
export interface TextsSource {
  readonly current: Texts | null
  ensure(): Promise<Texts | null>
}

export interface AgentInvokerOptions {
  readonly accountId: string
  readonly agentId: string
  readonly client: InvokerClient
  readonly callModel: GateModelCall
  readonly startTurn: TurnStarter
  readonly texts: TextsSource
  readonly logger: Logger
  /** The account's running turns; shared with any later invoker for the same account (`runningTurnsFor`). */
  readonly running?: RunningTurns
  readonly metrics?: MetricsRecorder
  /**
   * Whether a turn started now can have the hosted tools (`turnReadiness`).
   * Checked before the gate: while unready nothing is gated, no model call
   * is spent, no turn starts. Default: always ready.
   */
  readonly readiness?: () => TurnReadiness
  /** `false`: no gate step — one turn per cycle with the served wake instruction; the agent judges in-turn and records its own verdicts. */
  readonly gateEnabled?: boolean
  readonly quietMs?: number
  readonly maxMs?: number
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
}

export interface InvokerCounters {
  readonly cycles: number
  readonly turns: number
  readonly inviteTurns: number
  /** Runs this account started that OpenClaw has not reported ended (any invoker). */
  readonly turnsInFlight: number
  readonly wakes: number
  readonly absorbed: number
  /** What the host recorded after turns ended, by D5 reason. */
  readonly outcomes: Readonly<Record<string, number>>
}

export type CycleOutcome =
  /** Nothing new to decide: no cards, no invites (or only those with a turn running). */
  | 'empty'
  /** The gate decided; turns were started for the replies and invites. */
  | 'decided'
  /** The model failed or answered nothing usable; nothing recorded, no turn. */
  | 'fail_closed'
  /** The gate is off; one turn with the served wake instruction. */
  | 'gate_off'
  /** The tray could not be read. */
  | 'tray_failed'
  /** The served texts are not available yet; nothing gated, the cards wait. */
  | 'texts_missing'
  /** A turn could not have the hosted tools; nothing gated, no model call, the cards wait. */
  | 'tools_unavailable'

export interface CycleResult {
  readonly outcome: CycleOutcome
  readonly cards: number
  readonly invites: number
  readonly reply: number
  readonly dismiss: number
  readonly defer: number
  readonly undecided: number
  /** `dismiss` / `defer` the server took in this cycle. */
  readonly recorded: number
  readonly recordFailures: number
  readonly turnsStarted: number
  readonly turnsRefused: number
  /** Cards and invites left out of this cycle because their turn is still running. */
  readonly skippedInFlight: number
  readonly truncated: boolean
  readonly latencyMs: number
  readonly failure: string | null
}

/** Largest tray the server builds (`INBOX_TRAY_MAX_LIMIT`): the read after a turn asks for all of it. */
const POST_TURN_TRAY_LIMIT = 50

/** Silent-turn counts kept per anchor; a bound so a long-lived gateway does not grow it forever. */
const MAX_SILENT_ENTRIES = 500

export class AgentInvoker {
  private readonly accountId: string
  private readonly agentId: string
  private readonly client: InvokerClient
  private readonly callModel: GateModelCall
  private readonly startTurn: TurnStarter
  private readonly texts: TextsSource
  private readonly logger: Logger
  private readonly metrics: MetricsRecorder
  private readonly readiness: () => TurnReadiness
  private readonly gateEnabled: boolean
  private readonly now: () => number
  private readonly running: RunningTurns
  private readonly coalescer: integration.WakeCoalescer
  private readonly unsubscribe: () => void

  private stopped = false
  /** A cycle left a card or invite out because its turn was running; read the tray again when a turn ends. */
  private skippedWhileInFlight = false
  /** The reason the tools were last found unavailable; logged when it changes, not per wake. */
  private unreadyReason: string | null = null
  /** Turns that looked and did nothing, per `conversation|anchor` or `invite:<id>` (D5: the second is a dismiss). */
  private readonly silent = new Map<string, number>()
  /** This invoker's own work: settled by `settled()` for tests and graceful stops. */
  private readonly work = new Set<Promise<unknown>>()

  cycles = 0
  turns = 0
  inviteTurns = 0
  private readonly outcomes: Record<string, number> = {}

  constructor(options: AgentInvokerOptions) {
    this.accountId = options.accountId
    this.agentId = options.agentId
    this.client = options.client
    this.callModel = options.callModel
    this.startTurn = options.startTurn
    this.texts = options.texts
    this.logger = options.logger.child({ component: 'integration', accountId: options.accountId })
    this.metrics = options.metrics ?? createNoopMetrics()
    this.readiness = options.readiness ?? (() => ({ ready: true }))
    this.gateEnabled = options.gateEnabled ?? true
    this.now = options.now ?? Date.now
    this.running = options.running ?? new RunningTurns()
    this.coalescer = new integration.WakeCoalescer({
      onCycle: () => this.track(this.runCycle()),
      onError: (err) => this.logger.error({ err: describe(err) }, 'cycle failed with an unhandled error — the cards stay on the tray'),
      ...(options.quietMs !== undefined ? { quietMs: options.quietMs } : {}),
      ...(options.maxMs !== undefined ? { maxMs: options.maxMs } : {}),
      now: this.now,
      ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
      ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
    })
    // A turn ending — this invoker's or one an earlier invoker for the same
    // account started — frees its card; if a cycle skipped one, look again.
    this.unsubscribe = this.running.onEnded(() => {
      if (this.stopped || !this.skippedWhileInFlight) return
      this.skippedWhileInFlight = false
      this.logger.debug({}, 'a turn ended — re-reading the tray for the cards left out meanwhile')
      this.coalescer.wake()
    })
  }

  // ─── wakes ──────────────────────────────────────────────────────────

  /** A wake from the socket (a frame, a connect, a server wake). Coalesced, then cycled. */
  wake(source: WakeSource): void {
    if (this.stopped) return
    this.logger.debug({ source }, 'wake')
    this.coalescer.wake()
  }

  /**
   * Stop starting work: no more cycles. Turns already running are not
   * cancelled (they are OpenClaw's); their outcome is still recorded when
   * they end, and they stay registered for the account until then.
   */
  stop(): void {
    this.stopped = true
    this.coalescer.stop()
    this.unsubscribe()
  }

  /** Resolves when this invoker's running cycle and every outcome it is recording have settled. Test and shutdown seam. */
  async settled(): Promise<void> {
    await this.coalescer.settled()
    while (this.work.size > 0) await Promise.allSettled([...this.work])
  }

  counters(): InvokerCounters {
    const coalescer = this.coalescer.counters()
    return {
      cycles: this.cycles,
      turns: this.turns,
      inviteTurns: this.inviteTurns,
      turnsInFlight: this.running.size,
      wakes: coalescer.wakes,
      absorbed: coalescer.absorbed,
      outcomes: { ...this.outcomes },
    }
  }

  // ─── one cycle ──────────────────────────────────────────────────────

  /** Read the tray, gate it, start the turns. Public so tests can drive one cycle. */
  async runCycle(): Promise<CycleResult> {
    this.cycles += 1
    const started = this.now()
    let tray: InboxTray
    try {
      tray = await this.client.inbox.tray({ waitMs: 0 })
    } catch (err) {
      this.logger.warn({ err: describe(err) }, 'tray read failed — the cards stay on the tray; the server re-wakes')
      return this.result('tray_failed', started, { failure: describe(err) })
    }

    const truncated = tray.truncated === true || tray.invites_truncated === true
    const allCards = gate.cardsOf(tray)
    const allInvites = invitesOf(tray)
    const cards = allCards.filter((card) => !this.running.has(conversationKey(card.conversation_id)))
    const invites = allInvites.filter((invite) => !this.running.has(inviteKey(invite.invite_id)))
    const skippedInFlight = allCards.length - cards.length + (allInvites.length - invites.length)
    if (skippedInFlight > 0) this.skippedWhileInFlight = true
    const base = { cards: cards.length, invites: invites.length, skippedInFlight, truncated }

    if (cards.length === 0 && invites.length === 0) {
      if (skippedInFlight > 0) this.logger.info({ skippedInFlight }, 'every card on the tray has a turn running — nothing new to decide')
      else this.logger.info({ deferred: tray.deferred ?? 0 }, 'tray empty — nothing to decide')
      return this.result('empty', started, base)
    }

    // The turn texts and the gate-call texts are served, never bundled.
    const texts = await this.texts.ensure()
    if (!texts) {
      this.logger.warn(base, 'served texts not available — not gating; the cards wait on the tray')
      return this.result('texts_missing', started, { ...base, failure: 'texts missing' })
    }

    // A turn that cannot have the hosted tools is not worth a gate call.
    const readiness = this.readiness()
    if (!readiness.ready) {
      const changed = this.unreadyReason !== readiness.reason
      this.unreadyReason = readiness.reason
      this.logger[changed ? 'warn' : 'debug']({ ...base, reason: readiness.reason }, 'AgentChat tools not available to a turn — not gating; the cards wait on the tray')
      return this.result('tools_unavailable', started, { ...base, failure: readiness.reason })
    }
    if (this.unreadyReason !== null) {
      this.unreadyReason = null
      this.logger.info({}, 'AgentChat tools available to turns again')
    }

    let result: CycleResult
    if (!this.gateEnabled) {
      result = await this.runUngated(texts, started, base)
    } else {
      const gated = cards.length > 0 ? await this.runGated({ ...tray, conversations: cards }, texts, started, base) : this.result('decided', started, base)
      const inviteTurns = await this.startInviteTurns(invites, texts)
      result = { ...gated, turnsStarted: gated.turnsStarted + inviteTurns.started, turnsRefused: gated.turnsRefused + inviteTurns.refused }
    }

    if (truncated && result.outcome !== 'fail_closed') {
      // More conversations or invites are waiting than one tray shows.
      this.logger.info({}, 'tray truncated — waking again for the rest')
      this.coalescer.wake()
    }
    return result
  }

  /** Gate off: the agent judges in-turn with the hosted tools and records its own verdicts (single-run behaviour). One turn at a time. */
  private async runUngated(texts: Texts, started: number, base: Partial<CycleResult>): Promise<CycleResult> {
    if (this.running.has(UNGATED_KEY)) {
      this.skippedWhileInFlight = true
      this.logger.info({}, 'gate off — the last turn is still running; this wake waits for it')
      return this.result('gate_off', started, base)
    }
    this.logger.info({ cards: base.cards }, 'gate off — starting one turn with the served wake instruction')
    const sessionKey = wakeSessionKey(this.agentId, this.now())
    const admission = await this.startTurn({ sessionKey, prompt: wakeTurnPrompt(texts), lane: integrationLane(this.accountId) })
    if (!admission.ran) {
      this.logger.warn({ sessionKey, error: admission.error }, 'turn not started — the cards stay on the tray')
      return this.result('gate_off', started, { ...base, turnsRefused: 1 })
    }
    this.turns += 1
    this.watch(UNGATED_KEY, 'ungated', sessionKey, admission, async () => undefined)
    return this.result('gate_off', started, { ...base, turnsStarted: 1 })
  }

  private async runGated(tray: InboxTray, texts: Texts, started: number, base: Partial<CycleResult>): Promise<CycleResult> {
    const decided = await gate.run({ tray, callModel: this.callModel, client: this.client, texts, toolNamer: OPENCLAW_TOOL_NAMER })
    const latencyMs = this.now() - started
    const counts = { reply: 0, dismiss: 0, defer: 0 }
    for (const verdict of decided.verdicts) counts[verdict.decision] += 1

    if (decided.outcome === 'fail_closed') {
      // Nothing recorded, no turn. The cards stay on the tray; the server
      // re-wakes unanswered cards (D3), so a provider outage is not a drop.
      this.logger.warn({ cards: base.cards, failure: decided.failure, latencyMs }, 'gate failed closed — nothing recorded, no turn started')
      return this.result('fail_closed', started, { ...base, undecided: base.cards ?? 0, failure: decided.failure ?? null })
    }
    if (decided.outcome === 'empty') return this.result('empty', started, base)

    let turnsStarted = 0
    let turnsRefused = 0
    for (const reply of decided.reply) {
      if (this.running.has(conversationKey(reply.conversationId))) {
        // Its card was left out of the tray the gate saw: the model named a
        // conversation it was not shown.
        this.skippedWhileInFlight = true
        continue
      }
      const sessionKey = wakeSessionKey(this.agentId, this.now())
      const turnStartedAt = new Date(this.now()).toISOString()
      this.logger.info({ sessionKey, conversationId: reply.conversationId }, 'turn start')
      const admission = await this.startTurn({ sessionKey, prompt: wakeTurnPrompt(texts, reply.conversationId), lane: integrationLane(this.accountId) })
      if (!admission.ran) {
        turnsRefused += 1
        this.logger.warn({ sessionKey, conversationId: reply.conversationId, error: admission.error }, 'turn not started — nothing recorded; the card stays on the tray')
        continue
      }
      turnsStarted += 1
      this.turns += 1
      this.watch(conversationKey(reply.conversationId), 'reply', sessionKey, admission, (outcome) => this.afterReplyTurn(sessionKey, reply, turnStartedAt, outcome))
    }

    const summary = {
      ...base,
      reply: counts.reply,
      dismiss: counts.dismiss,
      defer: counts.defer,
      undecided: decided.undecided.length,
      recorded: decided.recorded,
      recordFailures: decided.recordFailures.length,
      turnsStarted,
      turnsRefused,
      latencyMs,
    }
    const unsettled = turnsRefused > 0 || summary.recordFailures > 0 || summary.undecided > 0
    this.logger[unsettled ? 'warn' : 'info'](summary, unsettled ? 'gate — some cards were left on the tray; the server re-wakes' : 'gate')
    return { ...this.result('decided', started, base), ...summary }
  }

  /** One turn per pending invite (tray v1). The agent answers it with the hosted tools, or leaves it pending. */
  private async startInviteTurns(invites: readonly TrayInvite[], texts: Texts): Promise<{ started: number; refused: number }> {
    let started = 0
    let refused = 0
    for (const invite of invites) {
      if (this.stopped) break
      const sessionKey = inviteSessionKey(this.agentId, invite.invite_id)
      this.logger.info({ sessionKey, inviteId: invite.invite_id, groupId: invite.group?.id }, 'group-invite turn start')
      let admission: TurnAdmission
      try {
        admission = await this.startTurn({ sessionKey, prompt: inviteTurnPrompt(texts), lane: integrationLane(this.accountId) })
      } catch (err) {
        admission = { ran: false, error: describe(err) }
      }
      if (!admission.ran) {
        refused += 1
        this.logger.warn({ sessionKey, inviteId: invite.invite_id, error: admission.error }, 'group-invite turn not started — the invite stays pending on the tray')
        continue
      }
      started += 1
      this.inviteTurns += 1
      this.watch(inviteKey(invite.invite_id), 'invite', sessionKey, admission, (outcome) => this.afterInviteTurn(sessionKey, invite, outcome))
    }
    return { started, refused }
  }

  // ─── turns ──────────────────────────────────────────────────────────

  /**
   * Register an admitted run and handle its end whenever OpenClaw confirms
   * it. The key stays registered — its card or invite is not gated again —
   * until then. A run whose end was never confirmed (`gone`: the plugin
   * runtime went away) stays registered: nothing in this process may start a
   * second turn for it.
   */
  private watch(key: string, kind: RunningKind, sessionKey: string, admission: Extract<TurnAdmission, { ran: true }>, after: (outcome: RunOutcome) => Promise<void>): void {
    this.running.add({ key, kind, runId: admission.runId, sessionKey, startedAt: this.now() })
    // The wait itself is not tracked (`settled()` must not wait on a live
    // run); the recording that follows the end is.
    void admission.done.then((outcome) => this.track(this.ended(key, kind, sessionKey, outcome, after)))
  }

  /** The run ended (or the runtime is gone): log it, record what it calls for, free its key. */
  private async ended(key: string, kind: RunningKind, sessionKey: string, outcome: RunOutcome, after: (outcome: RunOutcome) => Promise<void>): Promise<void> {
    if (outcome.status === 'gone') {
      this.logger.warn({ sessionKey, runId: outcome.runId }, 'turn end not confirmed: the plugin runtime is gone — its card stays reserved')
      return
    }
    this.logger[outcome.status === 'ok' ? 'info' : 'warn'](
      {
        sessionKey,
        runId: outcome.runId,
        status: outcome.status,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.elapsedMs !== undefined ? { elapsedMs: outcome.elapsedMs } : {}),
        agentchatCalls: outcome.agentchatCalls ?? null,
      },
      kind === 'invite' ? 'group-invite turn ended' : 'turn ended (final text discarded; the send is a hosted-tool call)',
    )
    try {
      await after(outcome)
    } catch (err) {
      this.logger.warn({ sessionKey, err: describe(err) }, 'recording after the turn failed — the card stays on the tray; the server re-wakes')
    } finally {
      this.running.end(key)
    }
  }

  /** D5: read the card again and record what the turn's effects call for. */
  private async afterReplyTurn(sessionKey: string, reply: GateReply, turnStartedAt: string, outcome: RunOutcome): Promise<void> {
    const freshTray = await this.freshTray(reply.conversationId)
    const anchor = gate.anchorOf(reply.card) ?? ''
    const silentKey = `${reply.conversationId}|${anchor}`
    const decision = integration.turnOutcome({
      turn: turnEndOf(outcome),
      turnStartedAt,
      gateCard: reply.card,
      category: reply.category,
      freshTray,
      silentBefore: this.silent.get(silentKey) ?? 0,
    })
    this.count(decision.reason)
    if (decision.reason === 'silent_first') this.noteSilent(silentKey)
    if (decision.action !== 'none') this.silent.delete(silentKey)
    const recorded = await integration.applyOutcome(this.client, decision)
    this.logger.info(
      { sessionKey, conversationId: reply.conversationId, action: decision.action, reason: decision.reason, ...(recorded ? { through: anchor || null } : {}) },
      recorded ? `${decision.action === 'record_reply' ? 'reply' : 'dismiss'} recorded after the turn (${decision.reason})` : `nothing recorded after the turn (${decision.reason})`,
    )
  }

  /** The same rule for an invite turn: an invite still pending after two turns that looked is dismissed (seen, left pending). */
  private async afterInviteTurn(sessionKey: string, invite: TrayInvite, outcome: RunOutcome): Promise<void> {
    const freshTray = await this.freshTray(null)
    const silentKey = inviteKey(invite.invite_id)
    const decision = integration.inviteOutcome({ turn: turnEndOf(outcome), invite, freshTray, silentBefore: this.silent.get(silentKey) ?? 0 })
    this.count(`invite_${decision.reason}`)
    if (decision.reason === 'silent_first') this.noteSilent(silentKey)
    if (decision.action !== 'none') this.silent.delete(silentKey)
    const dismissed = await integration.applyInviteOutcome(this.client, decision)
    this.logger.info(
      { sessionKey, inviteId: invite.invite_id, action: decision.action, reason: decision.reason },
      dismissed ? 'invite dismissed after a second silent turn (left pending)' : `nothing recorded for the invite (${decision.reason})`,
    )
  }

  /** The tray after a turn, whole; null when the read failed (D5 then records nothing). */
  private async freshTray(conversationId: string | null): Promise<InboxTray | null> {
    try {
      return await this.client.inbox.tray({ waitMs: 0, limit: POST_TURN_TRAY_LIMIT })
    } catch (err) {
      this.logger.info({ conversationId, err: describe(err) }, 'tray re-read after the turn failed — nothing recorded; the card stays on the tray')
      return null
    }
  }

  private noteSilent(key: string): void {
    this.silent.set(key, (this.silent.get(key) ?? 0) + 1)
    if (this.silent.size > MAX_SILENT_ENTRIES) {
      const oldest = this.silent.keys().next().value
      if (oldest !== undefined) this.silent.delete(oldest)
    }
  }

  private count(reason: string): void {
    this.outcomes[reason] = (this.outcomes[reason] ?? 0) + 1
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise)
    const remove = () => this.work.delete(promise)
    promise.then(remove, remove)
    return promise
  }

  private result(outcome: CycleOutcome, started: number, fields: Partial<CycleResult> = {}): CycleResult {
    return {
      outcome,
      cards: 0,
      invites: 0,
      reply: 0,
      dismiss: 0,
      defer: 0,
      undecided: 0,
      recorded: 0,
      recordFailures: 0,
      turnsStarted: 0,
      turnsRefused: 0,
      skippedInFlight: 0,
      truncated: false,
      failure: null,
      ...fields,
      latencyMs: this.now() - started,
    }
  }
}

/** What OpenClaw reported, as the kit's D5 rule reads it. `ok` is the only completed end. */
export function turnEndOf(outcome: RunOutcome): integration.TurnEnd {
  const agentchatCalls = outcome.agentchatCalls ?? null
  if (outcome.status === 'ok' && !outcome.error) return { status: 'completed', agentchatCalls }
  return { status: 'failed', agentchatCalls, ...(outcome.error ? { detail: outcome.error } : {}) }
}

/** The tray's pending invites (tray v1); none on a server that does not serve them. */
function invitesOf(tray: InboxTray): TrayInvite[] {
  const invites = (tray as { invites?: unknown }).invites
  if (!Array.isArray(invites)) return []
  return invites.filter((invite): invite is TrayInvite => typeof (invite as { invite_id?: unknown } | null)?.invite_id === 'string')
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

