/**
 * The account's running turns, kept for the life of the gateway process —
 * not of one receive loop.
 *
 * A turn holds its conversation (or invite) until OpenClaw confirms its run
 * ended (`./run.ts`): while it runs, the card stays on the tray (nothing is
 * recorded before the turn ends), and gating it again would start a second
 * turn that answers the same message twice. The kit's `TurnTracker` is what
 * holds it. OpenClaw restarts an account's channel task on a config change
 * while the run started under the old loop goes on in OpenClaw's lane, so
 * the tracker is per account and module-wide and handed to every loop for
 * the account: the next loop leaves that card alone until the run ends (and
 * the old loop still records what the run did).
 *
 * A gateway restart ends the process and every run with it, so nothing here
 * is persisted. A plugin reload waits for the runs (OpenClaw drains the
 * plugin's admitted work first, and every turn holds it until it ends).
 *
 * Also here: which OpenClaw run belongs to which conversation or invite,
 * for the log line and the status warning about a turn that runs long.
 */

import { integration } from 'agentchatme'

const trackers = new Map<string, integration.TurnTracker>()

/** The account's tracker, created on first use and kept for the process. */
export function trackerFor(accountId: string): integration.TurnTracker {
  let tracker = trackers.get(accountId)
  if (!tracker) {
    tracker = new integration.TurnTracker()
    trackers.set(accountId, tracker)
  }
  return tracker
}

/** What a run is about: `conversation conv_…` or `invite gri_…`. */
export interface RunLabel {
  readonly kind: 'reply' | 'invite'
  readonly id: string
  readonly sessionKey: string
}

const labels = new Map<string, RunLabel>()

export function labelRun(runId: string, label: RunLabel): void {
  labels.set(runId, label)
}

export function runLabel(runId: string): RunLabel | undefined {
  return labels.get(runId)
}

export function forgetRun(runId: string): void {
  labels.delete(runId)
}

/** A turn running longer than this is reported (status, doctor, the log): the kit's threshold. */
export const TURN_OVERDUE_MS = 30 * 60_000

/** OpenClaw's run deadline when `agents.defaults.timeoutSeconds` is unset (`src/agents/timeout.ts`: 48 h). */
export const OPENCLAW_DEFAULT_RUN_TIMEOUT_SECONDS = 2880 * 60

/** The run deadline OpenClaw applies: `agents.defaults.timeoutSeconds`, its 48 h default, or none (`0`). */
export function runDeadline(cfg: unknown): { readonly seconds: number; readonly configured: boolean } {
  const value = (cfg as { agents?: { defaults?: { timeoutSeconds?: unknown } } } | undefined)?.agents?.defaults?.timeoutSeconds
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { seconds: Math.floor(value), configured: true }
  return { seconds: OPENCLAW_DEFAULT_RUN_TIMEOUT_SECONDS, configured: false }
}

/**
 * The operator line for a turn that has run past `TURN_OVERDUE_MS`: which
 * conversation (or invite) it holds, for how long, and what ends it.
 */
export function overdueTurnLine(turn: { readonly kind: 'reply' | 'invite'; readonly id: string; readonly elapsedMs: number }, cfg: unknown): string {
  const minutes = Math.floor(turn.elapsedMs / 60_000)
  const what = turn.kind === 'reply' ? `conversation ${turn.id}` : `invite ${turn.id}`
  const deadline = runDeadline(cfg)
  const ends =
    deadline.seconds === 0
      ? 'agents.defaults.timeoutSeconds is 0 (no deadline), so it may never end — restart the gateway to end it'
      : `OpenClaw ends it at its run deadline, agents.defaults.timeoutSeconds = ${deadline.seconds}${deadline.configured ? '' : " (OpenClaw's default, 48 h)"}`
  return `a turn for ${what} has run ${minutes} min — its card stays held (no second reply) until the run ends; ${ends}`
}

/** One line per turn the loop holds past the threshold (status, doctor). */
export function overdueTurnLines(turns: ReadonlyArray<{ readonly kind: 'reply' | 'invite'; readonly conversationId?: string; readonly inviteId?: string; readonly startedAt: number }>, cfg: unknown, now: number = Date.now()): string[] {
  return turns
    .filter((turn) => now - turn.startedAt > TURN_OVERDUE_MS)
    .map((turn) => overdueTurnLine({ kind: turn.kind, id: (turn.kind === 'reply' ? turn.conversationId : turn.inviteId) ?? '?', elapsedMs: now - turn.startedAt }, cfg))
}

/** Test hook only. */
export function resetRunningTurnsForTest(): void {
  trackers.clear()
  labels.clear()
}
