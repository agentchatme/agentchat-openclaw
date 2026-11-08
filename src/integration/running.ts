/**
 * The account's turns, kept for the life of the gateway process — not of one
 * receive loop.
 *
 * A turn holds its conversation (or invite) until OpenClaw confirms its run
 * ended (`./run.ts`): while it runs, the card stays on the tray (nothing is
 * recorded before the turn ends), and gating it again would start a second
 * turn that answers the same message twice. The kit's `TurnTracker` is what
 * holds it, and there is one per account, handed to every loop for the
 * account: OpenClaw restarts an account's channel task on a config change
 * while the run started under the old loop goes on in OpenClaw's lane, so the
 * next loop leaves that card alone until the run ends (the old loop still
 * records what the run did). When a run that held a card ends, the account's
 * live loop is woken, so a message that arrived meanwhile is gated at once.
 *
 * A run OpenClaw never reports as ended must not freeze the account. After
 * `TURN_OVERDUE_MS` the turn is handed off, once: the kit's slot is released
 * and new turns move to a fresh OpenClaw lane (OpenClaw runs a lane's runs
 * one after another, so they would otherwise queue behind the hung run) —
 * other conversations get turns again — while this module keeps the
 * conversation held until OpenClaw reports that run ended, and then applies
 * the after-turn rule itself (`./after-turn.ts`: the kit no longer watches
 * it). At most `MAX_HUNG_TURNS` are held that way; beyond that, readiness
 * says not-ready (no gate calls) and status and doctor say why. An operator
 * can let one go: `openclaw agentchat release <conversation_id>`.
 *
 * Every hold here is keyed by run id. A run that was handed off or let go of
 * is never handed off again — whatever later "still running" reports say —
 * so a release sticks; and a run whose kit hold was released while OpenClaw
 * was still admitting it starts out let go of. Either way the old run can
 * never release a newer turn's hold on the same conversation.
 *
 * Gate off (single-run mode) one run reads the whole tray, so two would
 * answer the same cards: past `TURN_OVERDUE_MS` the cycle waiting on the run
 * is let go of (the loop is not stuck in it), but no new run starts while the
 * handed-off one lives — readiness says not-ready, status and doctor say why,
 * and `openclaw agentchat release <run id> --force` frees it.
 *
 * A gateway restart ends every run with the process, and OpenClaw (current
 * main) may continue a plugin's turn session afterwards: a plugin run with
 * no requester is registered under the agent's main session
 * (`src/gateway/server-methods/agent-subagent-registration.ts`), restart
 * resume walks a live subagent session up to that root — the "subagent"
 * skip applies to the root, which is the main session, not ours
 * (`src/gateway/session-restart-resume.ts`, `restartResumeSkipReason`) — and
 * wakes it with "send a fresh instruction to the same retained child
 * session when appropriate". Tested live: on 2026.11.5-beta.1 a restart
 * during a turn resumed `agent:<id>:main` with the restart text, its context
 * listing the AgentChat turn sessions; 2026.10.9 aborted the run and resumed
 * nothing. So the turns in flight are written to disk (`./turn-store.ts`)
 * and the next start adopts them (`adopt`): each conversation is held for
 * `RESTART_HOLD_MS`, and the after-turn rule is applied to what the ended run
 * did at once and again when the hold expires (an answer it — or the resumed
 * main session — sent records `reply`, so the card is not gated again). A
 * run OpenClaw starts in that turn's session during the hold — seen through
 * the `model_call_started` hook, the public way a plugin sees runs it did not
 * start — keeps the conversation held as a turn of its own: past
 * `TURN_OVERDUE_MS` it is handed off and counts toward `MAX_HUNG_TURNS`, and
 * when it ends it gets the after-turn rule. A stored turn first started more
 * than `STORED_TURN_MAX_AGE_MS` ago is dropped, so a restart storm cannot
 * re-adopt it forever. Not covered (accepted): a continuation that starts
 * after the hold, when the conversation may have been gated again; the wake
 * text AgentChat serves for OpenClaw is to tell the agent not to resume an
 * AgentChat turn after a restart (a server change). A plugin reload waits for the runs (OpenClaw drains a plugin's
 * admitted work first, and every turn holds it until it ends).
 */

import { integration, type InboxCard, type TrayInvite } from 'agentchatme'

import type { Logger } from '../log.js'
import { cardFromStored, type AfterTurnRecorder } from './after-turn.js'
import { KEEP_ENDED_MS, storedCard, type StoredTurn, type TurnStore } from './turn-store.js'

/** A turn running longer than this is handed off and reported (the kit's threshold). */
export const TURN_OVERDUE_MS = 30 * 60_000

/**
 * A wait that elapses comes back a few milliseconds early, so the sixth
 * 5-minute "still running" report lands at 29:59.9: the threshold allows
 * that much (seen live — without it the hand-off slipped to 35 minutes).
 */
export const OVERDUE_SLACK_MS = 5_000

/** Whether a turn this old is past `TURN_OVERDUE_MS` (with the wait's slack). */
export function isOverdue(elapsedMs: number): boolean {
  return elapsedMs + OVERDUE_SLACK_MS >= TURN_OVERDUE_MS
}

/** Hung turns held at once before the account stops gating (each holds one conversation). */
export const MAX_HUNG_TURNS = 2

/** OpenClaw's run deadline when `agents.defaults.timeoutSeconds` is unset (`src/agents/timeout.ts`: 48 h). */
export const OPENCLAW_DEFAULT_RUN_TIMEOUT_SECONDS = 2880 * 60

/**
 * After a restart, how long a conversation whose turn the restart ended stays
 * held when nothing continues that turn's session. OpenClaw's restart resume
 * wakes the main session at boot; this covers its decision to send the turn
 * session a fresh instruction (seen at the run's first model call).
 */
export const RESTART_HOLD_MS = 3 * 60_000

/** A stored turn first started longer ago than this is dropped, not adopted again (a restart storm). */
export const STORED_TURN_MAX_AGE_MS = 24 * 60 * 60_000

/** reply: a conversation; invite: a group invite; run: the one run of a gate-off cycle. */
export type TurnKind = 'reply' | 'invite' | 'run'

/** One OpenClaw run started for the account. */
export interface RunRecord {
  readonly runId: string
  readonly kind: TurnKind
  /** The conversation id (reply), the invite id (invite), or the run id (a gate-off run). */
  readonly id: string
  /** The message the gate's verdict read through (reply turns). */
  readonly anchor: string | null
  readonly sessionKey: string
  /** Local clock, ms. */
  readonly startedAt: number
  /** The loop that started it. */
  readonly owner: string
  /** reply: the card the gate decided on and its category — what the after-turn rule compares. */
  readonly card?: InboxCard
  readonly category?: string | null
  /** invite: the invite the turn was for. */
  readonly invite?: TrayInvite
  /** When the first turn of this chain started: a turn continued after a restart keeps its original's (stored turns age out by it). */
  readonly firstStartedAt?: number
}

export type ReleaseResult =
  | { readonly released: true; readonly what: 'hung' | 'running' | 'restart'; readonly key: string; readonly runId: string | null }
  | { readonly released: false; readonly reason: string }

/** Watches a run this process did not start until OpenClaw reports it ended; null when it cannot say. */
export type RunWatcher = (record: RunRecord) => Promise<integration.TurnEnd | null>

/** The AgentChat calls an ended run made, from its transcript; null when unknown. */
export type CallReader = (sessionKey: string, runId: string) => Promise<integration.AgentChatCallCount | null>

export interface TurnsWiring {
  /** Applies the after-turn rule to a turn that ended outside the kit's watch. */
  readonly recorder?: AfterTurnRecorder
  /** Where the turns in flight are written (the restart defense). */
  readonly store?: TurnStore
  readonly watch?: RunWatcher
  readonly readCalls?: CallReader
  readonly logger?: Logger
}

interface LiveLoop {
  readonly owner: string
  readonly wake: () => void
  /**
   * Runs `fn` in the async context the loop was created in. A release comes
   * in through a gateway RPC (`agentchat.release`); work it starts — the
   * wake's next cycle, a waiting turn admitted into the freed slot — must not
   * inherit that request's context, which OpenClaw retires when the RPC
   * returns ("Gateway caller authority is no longer active").
   */
  readonly run: <T>(fn: () => T) => T
}

/**
 * kit: the kit's loop holds it. watch: a run OpenClaw started in an adopted
 * turn's session, held here. hung: handed off, held here. released: let go
 * of; it holds nothing.
 */
type RunState = 'kit' | 'watch' | 'hung' | 'released'

interface Entry {
  readonly record: RunRecord
  state: RunState
  /** The hold this module keeps (hung reply / invite turns, continued runs). */
  handle: integration.TurnHandle | null
  /** When it was handed off. */
  since: number
  /** A gate-off run: ends the cycle that waits on it (the run goes on). */
  readonly letGo?: () => void
}

/** A turn the last process left in flight, held after a restart. */
interface Adopted {
  readonly stored: StoredTurn
  readonly record: RunRecord
  readonly handle: integration.TurnHandle
  readonly until: number
  /** What the ended run did (read once its transcript is): applied at the start and when the hold expires. */
  end: integration.TurnEnd | null
  timer: ReturnType<typeof setTimeout> | null
}

/** A turn OpenClaw is admitting: whether its kit hold was released meanwhile. */
export interface Admission {
  readonly key: string
  released: boolean
}

const RESTART_END_DETAIL = 'the gateway restarted during the turn'

function trackerKey(kind: TurnKind, id: string): string {
  return kind === 'reply' ? `conversation:${id}` : kind === 'invite' ? `invite:${id}` : `run:${id}`
}

function trackedTurn(record: RunRecord): integration.TrackedTurn | null {
  if (record.kind === 'reply') return { kind: 'reply', conversationId: record.id, anchor: record.anchor }
  if (record.kind === 'invite') return { kind: 'invite', inviteId: record.id }
  return null
}

function storedOf(record: RunRecord): StoredTurn | null {
  if (record.kind === 'run') return null
  return {
    runId: record.runId,
    kind: record.kind,
    id: record.id,
    anchor: record.anchor,
    sessionKey: record.sessionKey,
    startedAt: record.startedAt,
    ...(record.firstStartedAt !== undefined ? { firstStartedAt: record.firstStartedAt } : {}),
    ...(record.category !== undefined ? { category: record.category } : {}),
    ...(record.kind === 'reply' && record.card ? { card: storedCard(record.card, record.anchor) } : {}),
  }
}

function recordOf(stored: StoredTurn): RunRecord {
  return {
    runId: stored.runId,
    kind: stored.kind,
    id: stored.id,
    anchor: stored.anchor,
    sessionKey: stored.sessionKey,
    startedAt: stored.startedAt,
    firstStartedAt: stored.firstStartedAt ?? stored.startedAt,
    owner: 'previous-process',
    ...(stored.category !== undefined ? { category: stored.category } : {}),
    ...(stored.kind === 'reply' && stored.card ? { card: cardFromStored(stored.card as never) } : {}),
    ...(stored.kind === 'invite' ? { invite: { invite_id: stored.id } as TrayInvite } : {}),
  }
}

export class AccountTurns {
  /** The kit's tracker for the account, shared by every loop for it. */
  readonly tracker: integration.TurnTracker
  private readonly entries = new Map<string, Entry>()
  /** Turns the last process left in flight, by session key. */
  private readonly adopted = new Map<string, Adopted>()
  /** Turns OpenClaw is admitting right now. */
  private readonly admitting = new Set<Admission>()
  /** Ended runs still written to the store (`KEEP_ENDED_MS`). */
  private readonly kept = new Map<string, { readonly turn: StoredTurn; readonly endedAt: number }>()
  private keptTimer: ReturnType<typeof setTimeout> | null = null
  private live: LiveLoop | null = null
  private wiring: TurnsWiring = {}
  /** Which OpenClaw lane new turns go to; moves on at every hand-off (a hung run blocks its lane). */
  private lane = 0
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    this.tracker = new integration.TurnTracker({ now: this.now })
    // A kit hold released while OpenClaw is still admitting its run: that run
    // starts out let go of (`started`), so it can never release a newer
    // turn's hold on the same conversation.
    this.tracker.onRelease((handle) => {
      for (const admission of this.admitting) if (admission.key === handle.key) admission.released = true
    })
  }

  /** The account's after-turn recorder, store and run watcher (each account start; the latest wins). */
  configure(wiring: TurnsWiring): void {
    this.wiring = { ...this.wiring, ...wiring }
  }

  /** The loop now receiving for the account; a held run that ends wakes it. `run` = the loop's own async context (default: as called). */
  setLive(owner: string, wake: () => void, run: <T>(fn: () => T) => T = (fn) => fn()): void {
    this.live = { owner, wake, run }
  }

  clearLive(owner: string): void {
    if (this.live?.owner === owner) this.live = null
  }

  /** A turn is about to be admitted by OpenClaw: watch whether its kit hold is released meanwhile. */
  admission(kind: 'reply' | 'invite', id: string): Admission {
    const admission: Admission = { key: trackerKey(kind, id), released: false }
    this.admitting.add(admission)
    return admission
  }

  /** OpenClaw refused the turn: nothing to watch. */
  admitted(admission: Admission): void {
    this.admitting.delete(admission)
  }

  /**
   * A run OpenClaw admitted. `letGo` (gate-off runs): ends the cycle waiting
   * on it when it is handed off or released. `admission`: a turn whose kit
   * hold was released during admission starts out let go of.
   */
  started(record: RunRecord, options: { letGo?: () => void; admission?: Admission } = {}): void {
    const releasedMeanwhile = options.admission?.released === true
    if (options.admission) this.admitting.delete(options.admission)
    this.entries.set(record.runId, {
      record,
      state: releasedMeanwhile ? 'released' : 'kit',
      handle: null,
      since: 0,
      ...(options.letGo ? { letGo: options.letGo } : {}),
    })
    this.persist()
  }

  run(runId: string): RunRecord | undefined {
    return this.entries.get(runId)?.record
  }

  /** Where the run stands (`null`: not a run of this account, or ended). */
  stateOf(runId: string): RunState | null {
    return this.entries.get(runId)?.state ?? null
  }

  /** Every run OpenClaw has not reported ended that still holds something, oldest first. */
  runningRuns(): RunRecord[] {
    return [...this.entries.values()]
      .filter((entry) => entry.state !== 'released')
      .map((entry) => entry.record)
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  hungRuns(): RunRecord[] {
    return [...this.entries.values()].filter((entry) => entry.state === 'hung').map((entry) => entry.record)
  }

  get hungCount(): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.state === 'hung') count += 1
    return count
  }

  /** The handed-off gate-off run still going, if any: no new run starts while it lives. */
  hungSingleRun(): RunRecord | null {
    for (const entry of this.entries.values()) if (entry.state === 'hung' && entry.record.kind === 'run') return entry.record
    return null
  }

  /** Conversations (and invites) held after a restart: adopted (until when), or continued by a run OpenClaw started. */
  restartHolds(): Array<{ readonly record: RunRecord; readonly until: number | null; readonly watching: string | null }> {
    const holds: Array<{ readonly record: RunRecord; readonly until: number | null; readonly watching: string | null }> = [...this.adopted.values()].map((a) => ({
      record: a.record,
      until: a.until,
      watching: null,
    }))
    for (const entry of this.entries.values()) if (entry.state === 'watch') holds.push({ record: entry.record, until: null, watching: entry.record.runId })
    return holds
  }

  /** The lane generation new turns start on (`integrationLane(accountId, laneGeneration)`). */
  get laneGeneration(): number {
    return this.lane
  }

  /**
   * OpenClaw reported the run ended (`end`: what it did, when known). A turn
   * held here (handed off, or continued after a restart) gets the after-turn
   * rule, then its hold drops and the live loop is woken. A turn the kit
   * still holds is the kit's to record; the live loop is woken once the card
   * is free, only when an earlier loop started it. A run let go of records
   * nothing.
   */
  async ended(runId: string, end?: integration.TurnEnd): Promise<void> {
    const entry = this.entries.get(runId)
    if (!entry) return
    this.entries.delete(runId)
    if (entry.state !== 'released') this.keep(entry.record)
    else this.persist()
    if (entry.state === 'hung' || entry.state === 'watch') {
      try {
        if (end && this.wiring.recorder && entry.record.kind !== 'run') await this.wiring.recorder(entry.record, end)
      } finally {
        if (entry.handle) this.tracker.end(entry.handle)
        this.live?.wake()
      }
      return
    }
    if (entry.state === 'released' || entry.record.kind === 'run') return
    if (!this.live || this.live.owner === entry.record.owner) return
    this.wakeWhenFree(trackerKey(entry.record.kind, entry.record.id))
  }

  /**
   * Hand a long run off, once, by run id: release the kit's slot for it (its
   * loop records nothing for it and may start other turns) and hold the
   * conversation here until the run ends. A gate-off run: the cycle waiting
   * on it is let go of. A continued run is already held here: it becomes
   * hung (counted toward `MAX_HUNG_TURNS`). Returns the record when it was
   * handed off now; null when it was already handed off or let go of.
   */
  handOff(runId: string): RunRecord | null {
    const entry = this.entries.get(runId)
    if (!entry || (entry.state !== 'kit' && entry.state !== 'watch')) return null
    const record = entry.record
    entry.since = this.now()
    if (entry.state === 'watch') {
      // Its own session, not one of our lanes; its hold is ours already.
      entry.state = 'hung'
      this.live?.wake()
      return record
    }
    // OpenClaw serializes a lane: the next turn must not queue behind this
    // run. Moved first — the release below can admit a waiting turn at once.
    this.lane += 1
    entry.state = 'hung'
    const turn = trackedTurn(record)
    if (turn === null) {
      entry.letGo?.()
    } else {
      this.tracker.release(trackerKey(record.kind, record.id))
      entry.handle = this.tracker.begin(turn)
      if (!entry.handle) entry.state = 'released'
    }
    this.live?.wake()
    return entry.state === 'hung' ? record : null
  }

  /**
   * An operator lets go of a conversation's (or invite's) turn: a hung hold,
   * a restart hold, or — past `TURN_OVERDUE_MS`, or with `force` — a turn
   * still running. Its run may still be live and answer: a second reply is
   * then possible, which is why a turn under 30 minutes (most likely still
   * working) is refused without `force`. A gate-off run always needs
   * `force`: it reads the whole tray, so a new run would answer the same
   * cards while it may still be going.
   */
  release(id: string, options: { force?: boolean } = {}): ReleaseResult {
    const live = this.live
    return live ? live.run(() => this.releaseNow(id, options.force === true)) : this.releaseNow(id, options.force === true)
  }

  private releaseNow(id: string, force: boolean): ReleaseResult {
    const matches = (record: RunRecord) => record.id === id || record.runId === id
    for (const entry of this.entries.values()) {
      if (entry.state !== 'hung' || !matches(entry.record)) continue
      if (entry.record.kind === 'run' && !force) return this.refuseSingleRun(entry.record)
      entry.state = 'released'
      if (entry.handle) this.tracker.end(entry.handle)
      entry.handle = null
      this.persist()
      this.live?.wake()
      return { released: true, what: 'hung', key: trackerKey(entry.record.kind, entry.record.id), runId: entry.record.runId }
    }
    for (const [sessionKey, adopted] of this.adopted) {
      if (adopted.record.id !== id) continue
      this.finishAdopted(sessionKey)
      return { released: true, what: 'restart', key: trackerKey(adopted.record.kind, adopted.record.id), runId: null }
    }
    for (const entry of this.entries.values()) {
      if ((entry.state !== 'kit' && entry.state !== 'watch') || !matches(entry.record)) continue
      const refused = this.refuseYoung(entry.record.kind, entry.record.id, entry.record.startedAt, force)
      if (refused) return refused
      const key = trackerKey(entry.record.kind, entry.record.id)
      if (entry.state === 'watch') {
        if (entry.handle) this.tracker.end(entry.handle)
        entry.handle = null
      } else {
        // The released run may still be going in its lane: new turns move on
        // (first — the release can admit a waiting turn at once).
        this.lane += 1
        if (entry.record.kind === 'run') entry.letGo?.()
        else this.tracker.release(key)
      }
      entry.state = 'released'
      this.persist()
      this.live?.wake()
      return { released: true, what: 'running', key, runId: entry.record.runId }
    }
    // Held by the kit with no run behind it yet (admitted, or waiting for a slot).
    for (const held of this.tracker.running()) {
      const heldId = held.kind === 'reply' ? held.conversationId : held.inviteId
      if (heldId !== id) continue
      const refused = this.refuseYoung(held.kind, heldId, held.startedAt, force)
      if (refused) return refused
      this.lane += 1
      const key = trackerKey(held.kind, heldId)
      if (this.tracker.release(key)) {
        this.live?.wake()
        return { released: true, what: 'running', key, runId: null }
      }
    }
    return { released: false, reason: `no turn holds ${id}` }
  }

  private refuseYoung(kind: TurnKind, id: string, startedAt: number, force: boolean): ReleaseResult | null {
    const age = this.now() - startedAt
    if (force || age >= TURN_OVERDUE_MS) return null
    return {
      released: false,
      reason: `the turn for ${whatOf(kind, id)} has run ${Math.floor(age / 60_000)} min — under ${TURN_OVERDUE_MS / 60_000} min it is most likely still working, and releasing it lets the conversation be gated again while that run can still send its answer (the peer would get two replies); wait, or repeat with --force`,
    }
  }

  private refuseSingleRun(record: RunRecord): ReleaseResult {
    return {
      released: false,
      reason: `${whatOf('run', record.runId)} has run ${Math.floor((this.now() - record.startedAt) / 60_000)} min and reads the whole tray — releasing it lets a new run answer the same cards while this one may still be going (the peers would get two replies); repeat with --force`,
    }
  }

  /**
   * Adopt the turns the last process left in flight (the store). Each one's
   * conversation (or invite) is held at once — before the loop's first gate —
   * for `RESTART_HOLD_MS`; the after-turn rule is applied to what the ended
   * run did now and again when the hold expires. A run OpenClaw starts in the
   * turn's session meanwhile (`observeRun`) takes the hold over. A turn first
   * started more than `STORED_TURN_MAX_AGE_MS` ago is dropped. Returns what
   * was adopted.
   */
  adopt(stored: readonly StoredTurn[] = this.wiring.store?.load() ?? []): RunRecord[] {
    const adopted: RunRecord[] = []
    const now = this.now()
    for (const turn of stored) {
      // Still running in this process (an account restart, not a gateway restart).
      if (this.entries.has(turn.runId) || this.adopted.has(turn.sessionKey) || this.kept.has(turn.runId)) continue
      const first = turn.firstStartedAt ?? turn.startedAt
      if (now - first > STORED_TURN_MAX_AGE_MS) {
        this.wiring.logger?.info({ runId: turn.runId, [turn.kind === 'reply' ? 'conversationId' : 'inviteId']: turn.id }, 'a stored turn older than a day was dropped, not adopted again')
        continue
      }
      const record = recordOf(turn)
      const tracked = trackedTurn(record)
      const handle = tracked ? this.tracker.begin(tracked) : null
      if (!handle) continue
      const entry: Adopted = { stored: { ...turn, firstStartedAt: first }, record, handle, until: now + RESTART_HOLD_MS, end: null, timer: null }
      this.adopted.set(turn.sessionKey, entry)
      entry.timer = setTimeout(() => this.expireAdopted(turn.sessionKey, entry), RESTART_HOLD_MS)
      entry.timer.unref?.()
      adopted.push(record)
      void this.recordRestartEnded(entry)
    }
    this.persist()
    return adopted
  }

  /**
   * A run started in some session (the `model_call_started` hook). One in
   * the session of a turn adopted after a restart is OpenClaw continuing
   * that turn: it takes the hold over as a turn of its own (`watch`), handed
   * off past `TURN_OVERDUE_MS` like any other.
   */
  observeRun(runId: string, sessionKey: string | undefined): void {
    if (!sessionKey || this.entries.has(runId)) return
    const adopted = this.adopted.get(sessionKey)
    if (!adopted) return
    this.adopted.delete(sessionKey)
    if (adopted.timer) clearTimeout(adopted.timer)
    const record: RunRecord = { ...adopted.record, runId, startedAt: this.now(), owner: 'restart' }
    this.entries.set(runId, { record, state: 'watch', handle: adopted.handle, since: 0 })
    this.persist()
    this.wiring.logger?.info(
      { runId, sessionKey, [record.kind === 'reply' ? 'conversationId' : 'inviteId']: record.id },
      'OpenClaw continued a turn session after the restart — its conversation stays held until that run ends',
    )
    void this.watchContinued(record)
  }

  private async watchContinued(record: RunRecord): Promise<void> {
    let end: integration.TurnEnd | null = null
    try {
      end = this.wiring.watch ? await this.wiring.watch(record) : null
    } catch {
      end = null
    }
    // null: the plugin runtime is gone — the hold stays (nothing in this
    // process starts a second turn for it).
    if (end === null) return
    await this.ended(record.runId, end)
  }

  private async recordRestartEnded(adopted: Adopted): Promise<void> {
    const { record } = adopted
    let calls: integration.AgentChatCallCount | null = null
    try {
      calls = this.wiring.readCalls ? await this.wiring.readCalls(record.sessionKey, record.runId) : null
    } catch {
      calls = null
    }
    adopted.end = { status: 'failed', agentchatCalls: calls, detail: RESTART_END_DETAIL }
    if (this.adopted.get(record.sessionKey) !== adopted || !this.wiring.recorder) return
    await this.wiring.recorder(record, adopted.end)
  }

  /**
   * The hold expired with nothing continuing the turn: the after-turn rule
   * once more — the resumed main session may have answered the card
   * meanwhile — then the conversation is free.
   */
  private expireAdopted(sessionKey: string, adopted: Adopted): void {
    if (this.adopted.get(sessionKey) !== adopted) return // taken over by a continued run, or released
    void (async () => {
      try {
        if (this.wiring.recorder) await this.wiring.recorder(adopted.record, adopted.end ?? { status: 'failed', agentchatCalls: null, detail: RESTART_END_DETAIL })
      } catch {
        // the recorder never rejects; a failure leaves the card to the server's re-wake
      }
      if (this.adopted.get(sessionKey) === adopted) this.finishAdopted(sessionKey)
    })()
  }

  private finishAdopted(sessionKey: string): void {
    const adopted = this.adopted.get(sessionKey)
    if (!adopted) return
    this.adopted.delete(sessionKey)
    if (adopted.timer) clearTimeout(adopted.timer)
    this.tracker.end(adopted.handle)
    this.persist()
    this.live?.wake()
  }

  /** An ended run stays in the store a little longer: a restart ends the run before it ends the process. */
  private keep(record: RunRecord): void {
    const turn = storedOf(record)
    if (turn) this.kept.set(record.runId, { turn, endedAt: this.now() })
    this.persist()
    if (!this.keptTimer) this.schedulePrune()
  }

  /** The next prune at the oldest kept entry's expiry. */
  private schedulePrune(): void {
    let oldest = Infinity
    for (const kept of this.kept.values()) oldest = Math.min(oldest, kept.endedAt)
    if (oldest === Infinity) return
    this.keptTimer = setTimeout(() => this.pruneKept(), Math.max(0, oldest + KEEP_ENDED_MS - this.now()))
    this.keptTimer.unref?.()
  }

  private pruneKept(): void {
    this.keptTimer = null
    const cutoff = this.now() - KEEP_ENDED_MS
    for (const [runId, kept] of this.kept) if (kept.endedAt <= cutoff) this.kept.delete(runId)
    this.persist()
    this.schedulePrune()
  }

  private persist(): void {
    const store = this.wiring.store
    if (!store) return
    const turns = new Map<string, StoredTurn>()
    for (const entry of this.entries.values()) {
      if (entry.state === 'released') continue
      const turn = storedOf(entry.record)
      if (turn) turns.set(turn.runId, turn)
    }
    for (const [runId, kept] of this.kept) turns.set(runId, kept.turn)
    for (const adopted of this.adopted.values()) turns.set(adopted.stored.runId, adopted.stored)
    if (!store.write([...turns.values()])) this.wiring.logger?.debug({ file: store.file }, 'turns in flight could not be written (the restart defense is off until the next write)')
  }

  private wakeWhenFree(key: string, attempts = 300): void {
    const held = key.startsWith('conversation:') ? this.tracker.conversationRunning(key.slice('conversation:'.length)) : this.tracker.inviteRunning(key.slice('invite:'.length))
    if (!held || attempts <= 0) {
      this.live?.wake()
      return
    }
    const timer = setTimeout(() => this.wakeWhenFree(key, attempts - 1), 100)
    timer.unref?.()
  }
}

const accounts = new Map<string, AccountTurns>()

/** The account's turns, created on first use and kept for the process. */
export function accountTurns(accountId: string): AccountTurns {
  let turns = accounts.get(accountId)
  if (!turns) {
    turns = new AccountTurns()
    accounts.set(accountId, turns)
  }
  return turns
}

/** The account's turns when it has any in this process; never creates them. */
export function findAccountTurns(accountId: string): AccountTurns | undefined {
  return accounts.get(accountId)
}

/** The account's kit tracker (shared by every loop for the account). */
export function trackerFor(accountId: string): integration.TurnTracker {
  return accountTurns(accountId).tracker
}

/** Every account with turns in this process. */
export function accountsWithTurns(): string[] {
  return [...accounts.keys()]
}

/** A run started in some session (the `model_call_started` hook): every account looks whether it continues an adopted turn. */
export function observeRunStarted(runId: unknown, sessionKey: unknown): void {
  if (typeof runId !== 'string' || runId.length === 0 || typeof sessionKey !== 'string' || sessionKey.length === 0) return
  for (const turns of accounts.values()) turns.observeRun(runId, sessionKey)
}

/** The run deadline OpenClaw applies: `agents.defaults.timeoutSeconds`, its 48 h default, or none (`0`). */
export function runDeadline(cfg: unknown): { readonly seconds: number; readonly configured: boolean } {
  const value = (cfg as { agents?: { defaults?: { timeoutSeconds?: unknown } } } | undefined)?.agents?.defaults?.timeoutSeconds
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { seconds: Math.floor(value), configured: true }
  return { seconds: OPENCLAW_DEFAULT_RUN_TIMEOUT_SECONDS, configured: false }
}

function whatOf(kind: TurnKind, id: string): string {
  return kind === 'reply' ? `conversation ${id}` : kind === 'invite' ? `invite ${id}` : `the gate-off run ${id}`
}

function deadlineText(cfg: unknown): string {
  const deadline = runDeadline(cfg)
  return deadline.seconds === 0
    ? 'agents.defaults.timeoutSeconds is 0 (no deadline), so it may never end'
    : `OpenClaw ends it at its run deadline, agents.defaults.timeoutSeconds = ${deadline.seconds}${deadline.configured ? '' : " (OpenClaw's default, 48 h)"}`
}

/**
 * The operator line for a turn that has run past `TURN_OVERDUE_MS`: which
 * conversation (or invite) it holds, for how long, and what ends it.
 */
export function overdueTurnLine(turn: { readonly kind: TurnKind; readonly id: string; readonly elapsedMs: number }, cfg: unknown): string {
  const minutes = Math.round(turn.elapsedMs / 60_000)
  if (turn.kind === 'run') {
    return `${whatOf(turn.kind, turn.id)} has run ${minutes} min — no new run starts until it ends (one run reads the whole tray); ${deadlineText(cfg)}`
  }
  return `a turn for ${whatOf(turn.kind, turn.id)} has run ${minutes} min — that conversation stays held (no second reply) until the run ends; ${deadlineText(cfg)}; other conversations are not held up by it`
}

/** One line per run past the threshold (status, doctor). */
export function overdueTurnLines(runs: readonly RunRecord[], cfg: unknown, now: number = Date.now()): string[] {
  return runs.filter((run) => now - run.startedAt > TURN_OVERDUE_MS).map((run) => overdueTurnLine({ kind: run.kind, id: run.id, elapsedMs: now - run.startedAt }, cfg))
}

/** One line per conversation held after a gateway restart (status, doctor, the start log). */
export function restartHoldLines(turns: AccountTurns, now: number = Date.now()): string[] {
  return turns.restartHolds().map(({ record, until, watching }) =>
    watching || until === null
      ? `${whatOf(record.kind, record.id)} is held: OpenClaw continued its turn's session after the gateway restart (run ${watching ?? 'unknown'}) — gated again once that run ends (handed off like any turn past 30 min)`
      : `${whatOf(record.kind, record.id)} is held for ${Math.max(0, Math.ceil((until - now) / 60_000))} more min: its turn was running when the gateway restarted, and OpenClaw may continue that turn's session`,
  )
}

/**
 * Readiness while handed-off runs block the account: a gate-off run still
 * going (no new run while it lives), or too many hung turns. Why nothing is
 * gated, and what to do; null when nothing blocks.
 */
export function hungTurnsReason(turns: AccountTurns, cfg: unknown, now: number = Date.now()): string | null {
  const single = turns.hungSingleRun()
  if (single) {
    return `${whatOf('run', single.runId)} has run ${Math.floor((now - single.startedAt) / 60_000)} min and is still going in OpenClaw — no new run starts while it lives (one run reads the whole tray; a second would answer the same cards), so the cards wait on the tray; ${deadlineText(cfg)}. \`openclaw agentchat release ${single.runId} --force\` lets a new run start (the old one may still answer)`
  }
  if (turns.hungCount < MAX_HUNG_TURNS) return null
  const held = turns
    .hungRuns()
    .map((run) => `${whatOf(run.kind, run.id)} for ${Math.floor((now - run.startedAt) / 60_000)} min`)
    .join(', ')
  return `${turns.hungCount} turns are hung in OpenClaw (${held}) — no gate calls until one ends, so other cards are waiting on the tray; ${deadlineText(cfg)}. \`openclaw agentchat release <conversation_id>\` lets go of one (its run may still answer, so a second reply is possible), or restart the gateway`
}

/** Test hook only. */
export function resetRunningTurnsForTest(): void {
  accounts.clear()
}
