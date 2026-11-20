/**
 * Could not process, as the operator sees it.
 *
 * When the agent's AI fails on one conversation (a provider refusal, a crash
 * on an attachment, a run past its time limit) while the runtime otherwise
 * works, the SDK kit's receive loop reports it to AgentChat and follows the
 * server's answer: `retry` and `hidden` (the new messages are hidden from
 * this agent only and shown as a note) run that conversation again; `paused`
 * mutes it for 24 h. The kit counts all of it (`status().processingFailures`)
 * and emits one `processing_failure` event per report. This module keeps the
 * pauses those events announce, and when a report last failed or the gate's
 * split last stopped, and turns them and the counts into the status and
 * doctor lines. It decides nothing: the counts are the kit's, the pause is
 * the server's, and it ends on its own.
 *
 * Kept per account at module scope, so a loop rebuilt by an account restart
 * (a config change) still shows them; a gateway restart forgets them (the
 * mute stays on the server and still ends on its own).
 */

import type { integration } from 'agentchatme'

/** The kit's could-not-process counters. */
export type ProcessingFailureCounts = integration.ReceiveLoopStatus['processingFailures']

/** One conversation the server paused for this agent. */
export interface PausedConversation {
  readonly conversationId: string
  /** When the pause (a mute with source `could_not_process`) ends, ISO 8601. */
  readonly until: string
}

/** The most pauses kept per account; the oldest go first. */
const MAX_PAUSED = 50

/** A failed report or a stopped split this recent makes the counts a warning (doctor); older ones are history. */
export const RECENT_TROUBLE_MS = 60 * 60_000

const pausedByAccount = new Map<string, Map<string, string>>()

/** When a report last failed and the gate's split last stopped, per account (ms). */
const troubleByAccount = new Map<string, { reportErrorAt?: number; splitStoppedAt?: number }>()

/**
 * Take one loop event: a `paused` answer records the conversation's pause; any
 * other answer for it (the pause ended and the conversation went again) drops
 * it; a report that failed, and a stopped split, are noted with their time.
 * Every other event is ignored.
 */
export function noteCouldNotProcess(accountId: string, event: integration.ReceiveLoopEvent, now: number = Date.now()): void {
  if (event.type === 'split_stopped') {
    troubleByAccount.set(accountId, { ...troubleByAccount.get(accountId), splitStoppedAt: now })
    return
  }
  if (event.type !== 'processing_failure') return
  if (event.result === null) {
    troubleByAccount.set(accountId, { ...troubleByAccount.get(accountId), reportErrorAt: now })
    return
  }
  let paused = pausedByAccount.get(accountId)
  if (event.result.action === 'paused' && typeof event.result.paused_until === 'string') {
    if (!paused) {
      paused = new Map()
      pausedByAccount.set(accountId, paused)
    }
    paused.delete(event.conversationId)
    paused.set(event.conversationId, event.result.paused_until)
    while (paused.size > MAX_PAUSED) {
      const oldest = paused.keys().next().value
      if (oldest === undefined) break
      paused.delete(oldest)
    }
    return
  }
  paused?.delete(event.conversationId)
}

/** The account's paused conversations whose pause has not ended yet, soonest end first. */
export function pausedConversations(accountId: string, now: number = Date.now()): PausedConversation[] {
  const paused = pausedByAccount.get(accountId)
  if (!paused) return []
  const live: PausedConversation[] = []
  for (const [conversationId, until] of paused) {
    const end = Date.parse(until)
    if (Number.isFinite(end) && end <= now) {
      paused.delete(conversationId)
      continue
    }
    live.push({ conversationId, until })
  }
  return live.sort((a, b) => Date.parse(a.until) - Date.parse(b.until))
}

/** When the account's last report failed and its gate split last stopped (ms), if ever. */
export function recentTrouble(accountId: string): { readonly reportErrorAt?: number; readonly splitStoppedAt?: number } {
  return { ...troubleByAccount.get(accountId) }
}

/** Tests only. */
export function resetCouldNotProcessForTest(): void {
  pausedByAccount.clear()
  troubleByAccount.clear()
}

export interface CouldNotProcessView {
  /** One line with the kit's counts since the loop started. */
  readonly summary: string
  /** The summary needs a look: within the last hour a report failed or the gate's split stopped, or the last runtime check failed. */
  readonly attention: boolean
  /** One line per paused conversation. */
  readonly paused: readonly string[]
}

/**
 * The status and doctor lines, from the kit's counters and the pauses:
 *
 *   could not process — reported 2 (retry 1, hidden 1) · re-runs 1 · runtime checks: ok 1
 *   conversation conv_1 paused until 2026-11-20T10:00:00.000Z — could not process; the mute ends on its own
 */
export function couldNotProcessView(
  counts: ProcessingFailureCounts | undefined,
  paused: readonly PausedConversation[],
  trouble: { readonly reportErrorAt?: number; readonly splitStoppedAt?: number } = {},
  now: number = Date.now(),
): CouldNotProcessView {
  const parts: string[] = []
  let attention = false
  if (counts) {
    const answers = nonZero({ retry: counts.retry, hidden: counts.hidden, paused: counts.paused, none: counts.none })
    if (counts.reported > 0) parts.push(`reported ${counts.reported}${answers ? ` (${answers})` : ''}`)
    if (counts.reportErrors > 0) parts.push(`report errors ${counts.reportErrors}`)
    if (counts.reruns > 0) parts.push(`re-runs ${counts.reruns}${counts.rerunsCapped > 0 ? ` (${counts.rerunsCapped} past the cap)` : ''}`)
    else if (counts.rerunsCapped > 0) parts.push(`re-runs past the cap ${counts.rerunsCapped}`)
    if (counts.awaitingEvidence > 0) parts.push(`waiting for evidence ${counts.awaitingEvidence}`)
    const checks = nonZero({ ok: counts.runtimeChecksOk, failed: counts.runtimeChecksFailed })
    if (checks) parts.push(`runtime checks: ${checks}`)
    if (counts.splitsStopped > 0) parts.push(`gate split stopped ${counts.splitsStopped}×`)
    const last = counts.lastRuntimeCheck
    if (last?.ok === false) parts.push(`last runtime check failed${last.detail ? `: ${last.detail}` : ''}`)
    const recent = (at: number | undefined): boolean => at !== undefined && now - at <= RECENT_TROUBLE_MS
    attention = recent(trouble.reportErrorAt) || recent(trouble.splitStoppedAt) || last?.ok === false
  }
  return {
    summary: `could not process — ${parts.length > 0 ? parts.join(' · ') : 'nothing reported'}`,
    attention,
    paused: paused.map((p) => `conversation ${p.conversationId} paused until ${p.until} — could not process; the mute ends on its own`),
  }
}

/** `{ retry: 1, hidden: 0 }` → `retry 1`; all zero → ''. */
function nonZero(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}`)
    .join(', ')
}
