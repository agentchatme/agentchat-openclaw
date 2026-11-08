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
 * `TURN_OVERDUE_MS` the turn is handed off: the kit's slot is released and
 * new turns move to a fresh OpenClaw lane (OpenClaw runs a lane's runs one
 * after another, so they would otherwise queue behind the hung run) — other
 * conversations get turns again — while this module keeps the conversation
 * held until OpenClaw reports that run ended. At most `MAX_HUNG_TURNS` are held
 * that way; beyond that, readiness says not-ready (no gate calls) and status
 * and doctor say why. An operator can let one go:
 * `openclaw agentchat release <conversation_id>`.
 *
 * A gateway restart ends every run with the process, and OpenClaw does not
 * resume a plugin's subagent session afterwards: restart resume skips
 * subagent session keys (`restartResumeSkipReason` → "subagent", OpenClaw
 * `src/config/sessions/session-run-lifecycle-projection.ts`), and a plugin run
 * has no requester session to be "re-instructed" by (the plugin passes no
 * `completionDelivery`). So nothing here is persisted. A plugin reload waits
 * for the runs (OpenClaw drains a plugin's admitted work first, and every
 * turn holds it until it ends).
 */

import { integration } from 'agentchatme'

/** A turn running longer than this is handed off and reported (the kit's threshold). */
export const TURN_OVERDUE_MS = 30 * 60_000

/** Hung turns held at once before the account stops gating (each holds one conversation). */
export const MAX_HUNG_TURNS = 2

/** OpenClaw's run deadline when `agents.defaults.timeoutSeconds` is unset (`src/agents/timeout.ts`: 48 h). */
export const OPENCLAW_DEFAULT_RUN_TIMEOUT_SECONDS = 2880 * 60

/** One OpenClaw run started for the account. */
export interface RunRecord {
  readonly runId: string
  readonly kind: 'reply' | 'invite'
  /** The conversation id (reply) or the invite id. */
  readonly id: string
  /** The message the gate's verdict read through (reply turns). */
  readonly anchor: string | null
  readonly sessionKey: string
  /** Local clock, ms. */
  readonly startedAt: number
  /** The loop that started it. */
  readonly owner: string
}

export type ReleaseResult =
  | { readonly released: true; readonly what: 'hung' | 'running'; readonly key: string; readonly runId: string | null }
  | { readonly released: false; readonly reason: string }

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

function trackerKey(kind: 'reply' | 'invite', id: string): string {
  return kind === 'reply' ? `conversation:${id}` : `invite:${id}`
}

function trackedTurn(record: RunRecord): integration.TrackedTurn {
  return record.kind === 'reply' ? { kind: 'reply', conversationId: record.id, anchor: record.anchor } : { kind: 'invite', inviteId: record.id }
}

export class AccountTurns {
  /** The kit's tracker for the account, shared by every loop for it. */
  readonly tracker: integration.TurnTracker
  private readonly runs = new Map<string, RunRecord>()
  private readonly hung = new Map<string, { readonly record: RunRecord; readonly handle: integration.TurnHandle; readonly since: number }>()
  private live: LiveLoop | null = null
  /** Which OpenClaw lane new turns go to; moves on at every hand-off (a hung run blocks its lane). */
  private lane = 0
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    this.tracker = new integration.TurnTracker({ now: this.now })
  }

  /** The loop now receiving for the account; a held run that ends wakes it. `run` = the loop's own async context (default: as called). */
  setLive(owner: string, wake: () => void, run: <T>(fn: () => T) => T = (fn) => fn()): void {
    this.live = { owner, wake, run }
  }

  clearLive(owner: string): void {
    if (this.live?.owner === owner) this.live = null
  }

  started(record: RunRecord): void {
    this.runs.set(record.runId, record)
  }

  run(runId: string): RunRecord | undefined {
    return this.runs.get(runId)
  }

  /** Every run OpenClaw has not reported ended, oldest first. */
  runningRuns(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  hungRuns(): RunRecord[] {
    return [...this.hung.values()].map((entry) => entry.record)
  }

  get hungCount(): number {
    return this.hung.size
  }

  /** The lane generation new turns start on (`integrationLane(accountId, laneGeneration)`). */
  get laneGeneration(): number {
    return this.lane
  }

  /**
   * OpenClaw reported the run ended (or it was let go of). A hung hold is
   * dropped; then the live loop is woken once the card is free — at once for
   * a hung hold, after the starting loop recorded its outcome otherwise — but
   * only when the run held a card the live loop cannot know about (hung, or
   * started by an earlier loop).
   */
  ended(runId: string): void {
    const record = this.runs.get(runId)
    this.runs.delete(runId)
    const hung = this.hung.get(runId)
    if (hung) {
      this.hung.delete(runId)
      this.tracker.end(hung.handle)
      this.live?.wake()
      return
    }
    if (!record || !this.live || this.live.owner === record.owner) return
    this.wakeWhenFree(trackerKey(record.kind, record.id))
  }

  /**
   * Hand a long run off: release the kit's slot (its loop records nothing for
   * it and may start other turns) and hold the conversation here until the
   * run ends. Returns the record when it was handed off now.
   */
  handOff(runId: string): RunRecord | null {
    const record = this.runs.get(runId)
    if (!record || this.hung.has(runId)) return null
    const key = trackerKey(record.kind, record.id)
    // OpenClaw serializes a lane: the next turn must not queue behind this
    // run. Moved first — the release below can admit a waiting turn at once.
    this.lane += 1
    this.tracker.release(key)
    const handle = this.tracker.begin(trackedTurn(record))
    if (!handle) return null
    this.hung.set(runId, { record, handle, since: this.now() })
    this.live?.wake()
    return record
  }

  /**
   * An operator lets go of a conversation's (or invite's) turn: a hung hold,
   * or a turn the kit still holds. Its run may still be live and answer — a
   * second reply is then possible; the operator's call.
   */
  release(id: string): ReleaseResult {
    const live = this.live
    return live ? live.run(() => this.releaseNow(id)) : this.releaseNow(id)
  }

  private releaseNow(id: string): ReleaseResult {
    for (const [runId, entry] of this.hung) {
      if (entry.record.id !== id) continue
      this.hung.delete(runId)
      this.tracker.end(entry.handle)
      this.live?.wake()
      return { released: true, what: 'hung', key: trackerKey(entry.record.kind, id), runId }
    }
    for (const kind of ['reply', 'invite'] as const) {
      const key = trackerKey(kind, id)
      if (this.tracker.release(key)) {
        const runId = [...this.runs.values()].find((r) => r.kind === kind && r.id === id)?.runId ?? null
        this.live?.wake()
        return { released: true, what: 'running', key, runId }
      }
    }
    return { released: false, reason: `no turn holds ${id}` }
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

/** The account's kit tracker (shared by every loop for the account). */
export function trackerFor(accountId: string): integration.TurnTracker {
  return accountTurns(accountId).tracker
}

/** Every account with turns in this process. */
export function accountsWithTurns(): string[] {
  return [...accounts.keys()]
}

/** The run deadline OpenClaw applies: `agents.defaults.timeoutSeconds`, its 48 h default, or none (`0`). */
export function runDeadline(cfg: unknown): { readonly seconds: number; readonly configured: boolean } {
  const value = (cfg as { agents?: { defaults?: { timeoutSeconds?: unknown } } } | undefined)?.agents?.defaults?.timeoutSeconds
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { seconds: Math.floor(value), configured: true }
  return { seconds: OPENCLAW_DEFAULT_RUN_TIMEOUT_SECONDS, configured: false }
}

function whatOf(kind: 'reply' | 'invite', id: string): string {
  return kind === 'reply' ? `conversation ${id}` : `invite ${id}`
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
export function overdueTurnLine(turn: { readonly kind: 'reply' | 'invite'; readonly id: string; readonly elapsedMs: number }, cfg: unknown): string {
  const minutes = Math.floor(turn.elapsedMs / 60_000)
  return `a turn for ${whatOf(turn.kind, turn.id)} has run ${minutes} min — that conversation stays held (no second reply) until the run ends; ${deadlineText(cfg)}; other conversations are not held up by it`
}

/** One line per run past the threshold (status, doctor). */
export function overdueTurnLines(runs: readonly RunRecord[], cfg: unknown, now: number = Date.now()): string[] {
  return runs.filter((run) => now - run.startedAt > TURN_OVERDUE_MS).map((run) => overdueTurnLine({ kind: run.kind, id: run.id, elapsedMs: now - run.startedAt }, cfg))
}

/** Readiness while too many turns are hung: why nothing is gated, and what to do. Null while under the cap. */
export function hungTurnsReason(turns: AccountTurns, cfg: unknown, now: number = Date.now()): string | null {
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
