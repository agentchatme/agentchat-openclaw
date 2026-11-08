/**
 * The turns running for an account, kept for the life of the gateway
 * process — not of one invoker.
 *
 * A turn holds its conversation (or invite) until OpenClaw confirms its run
 * ended (`./run.ts`): while it runs, the card stays on the tray (nothing is
 * recorded before the turn ends), and gating it again would start a second
 * turn that answers the same message twice. OpenClaw restarts an account's
 * channel task on a config change; the run started by the old task goes on
 * in OpenClaw's lane. The registry is therefore per account and module-wide,
 * so the next invoker for the same account sees the turns the last one
 * started and leaves their cards alone until those runs end.
 *
 * A gateway restart ends the process and every run with it, so nothing here
 * is persisted.
 */

export type RunningKind = 'reply' | 'invite' | 'ungated'

export interface RunningTurn {
  /** `conv:<conversation id>`, `invite:<invite id>`, or `ungated`. */
  readonly key: string
  readonly kind: RunningKind
  readonly runId: string
  readonly sessionKey: string
  /** Local clock, ms. */
  readonly startedAt: number
}

export type RunningTurnListener = (turn: RunningTurn) => void

export class RunningTurns {
  private readonly turns = new Map<string, RunningTurn>()
  private readonly listeners = new Set<RunningTurnListener>()

  has(key: string): boolean {
    return this.turns.has(key)
  }

  get size(): number {
    return this.turns.size
  }

  list(): RunningTurn[] {
    return [...this.turns.values()]
  }

  /** The oldest running turn's start, for the status line; null when none runs. */
  oldestStartedAt(): number | null {
    let oldest: number | null = null
    for (const turn of this.turns.values()) if (oldest === null || turn.startedAt < oldest) oldest = turn.startedAt
    return oldest
  }

  add(turn: RunningTurn): void {
    this.turns.set(turn.key, turn)
  }

  /** The run behind `key` ended (OpenClaw confirmed it). Listeners hear it once. */
  end(key: string): void {
    const turn = this.turns.get(key)
    if (!turn) return
    this.turns.delete(key)
    for (const listener of this.listeners) {
      try {
        listener(turn)
      } catch {
        // a listener must not keep a turn registered
      }
    }
  }

  /** Subscribe to ends; returns the unsubscribe. */
  onEnded(listener: RunningTurnListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const conversationKey = (conversationId: string): string => `conv:${conversationId}`
export const inviteKey = (inviteId: string): string => `invite:${inviteId}`
export const UNGATED_KEY = 'ungated'

const byAccount = new Map<string, RunningTurns>()

/** The account's registry, created on first use and kept for the process. */
export function runningTurnsFor(accountId: string): RunningTurns {
  let turns = byAccount.get(accountId)
  if (!turns) {
    turns = new RunningTurns()
    byAccount.set(accountId, turns)
  }
  return turns
}

/** Test hook only. */
export function resetRunningTurnsForTest(): void {
  byAccount.clear()
}
