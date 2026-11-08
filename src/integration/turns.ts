/**
 * How the kit's receive loop starts a turn on OpenClaw.
 *
 * The loop (gate-call mode) decides which conversations and invites get a
 * turn and composes the prompt from the served texts; this adapter runs it
 * as one OpenClaw agent run (`runtime.subagent.run`, `deliver: false`, a
 * fresh session, the account's lane) and reports its end in the kit's terms
 * once OpenClaw has confirmed it (`./run.ts`):
 *
 *   - `ok`                        → `completed`, with the AgentChat calls the
 *                                   run made (from its transcript; null = unknown)
 *   - `error`, `timeout`          → `failed` (the run's own deadline is a failure,
 *                                   never an elapsed wait)
 *   - the plugin runtime is gone  → `still_running` with no `next`: the loop keeps
 *                                   the conversation, nothing in this process may
 *                                   start a second turn for it
 *
 * One more rule is OpenClaw's: OpenClaw restarts an account's channel task on
 * a config change while its runs go on in the lane. The loop's own tracker
 * lives and dies with the loop, so the account's runs are also kept in a
 * per-account registry for the process (`./running.ts`). A turn asked for a
 * conversation or invite whose run — started by an earlier loop — is still
 * live is refused; when that run ends, the current loop is woken
 * (`onEarlierRunEnded`) and the card is gated again.
 */

import type { integration } from 'agentchatme'

import type { Logger } from '../log.js'
import type { TurnOutcome, TurnStarter as RuntimeTurnStarter } from './model.js'
import { RunningTurns, conversationKey, inviteKey } from './running.js'
import { integrationLane, inviteSessionKey, wakeSessionKey } from './turn.js'

export interface LoopTurnStarterOptions {
  readonly accountId: string
  /** The OpenClaw agent the account is routed to. */
  readonly agentId: string
  /** Starts one OpenClaw run and reports its confirmed end (`createRuntimeTurnStarter`). */
  readonly startRun: RuntimeTurnStarter
  /** The account's runs, shared with any later loop in this process (`runningTurnsFor`). */
  readonly running: RunningTurns
  /** Identifies the loop this starter belongs to; a run's end wakes only later loops. */
  readonly owner: string
  readonly logger: Logger
  readonly now?: () => number
}

/** The kit's `TurnStarter` for OpenClaw. */
export function createLoopTurnStarter(options: LoopTurnStarterOptions): integration.TurnStarter {
  const now = options.now ?? Date.now
  return async (request) => {
    const key = request.kind === 'reply' ? conversationKey(request.conversationId) : inviteKey(request.invite.invite_id)
    const earlier = options.running.get(key)
    if (earlier) {
      options.logger.info(
        { key, runId: earlier.runId, sessionKey: earlier.sessionKey },
        'a run started before this account restarted is still live for it — no second turn; gated again when it ends',
      )
      return { started: false, error: 'a run for it is still live' }
    }
    const sessionKey = request.kind === 'reply' ? wakeSessionKey(options.agentId, now()) : inviteSessionKey(options.agentId, request.invite.invite_id, now())
    const admission = await options.startRun({ sessionKey, prompt: request.prompt, lane: integrationLane(options.accountId) })
    if (!admission.ran) return { started: false, error: admission.error }
    options.running.add({ key, kind: request.kind, runId: admission.runId, sessionKey, startedAt: now(), owner: options.owner })
    options.logger.info(
      { kind: request.kind, sessionKey, runId: admission.runId, ...(request.kind === 'reply' ? { conversationId: request.conversationId } : { inviteId: request.invite.invite_id }) },
      request.kind === 'reply' ? 'turn start' : 'group-invite turn start',
    )
    const done = admission.done.then((outcome): integration.TurnEnd => {
      if (outcome.status === 'gone') {
        options.logger.warn({ sessionKey, runId: outcome.runId }, 'turn end not confirmed: the plugin runtime is gone — its card stays reserved')
        return { status: 'still_running', detail: 'the plugin runtime is gone' }
      }
      options.running.end(key)
      options.logger[outcome.status === 'ok' ? 'info' : 'warn'](
        {
          sessionKey,
          runId: outcome.runId,
          status: outcome.status,
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.elapsedMs !== undefined ? { elapsedMs: outcome.elapsedMs } : {}),
          agentchatCalls: outcome.agentchatCalls ?? null,
        },
        request.kind === 'reply' ? 'turn ended (final text discarded; the send is a hosted-tool call)' : 'group-invite turn ended',
      )
      return turnEndOf(outcome)
    })
    return { started: true, done }
  }
}

/** What OpenClaw reported, as the kit's D5 rule reads it. `ok` without an error is the only completed end. */
export function turnEndOf(outcome: TurnOutcome): integration.TurnEnd {
  const agentchatCalls = outcome.agentchatCalls ?? null
  if (outcome.status === 'ok' && !outcome.error) return { status: 'completed', agentchatCalls }
  return { status: 'failed', agentchatCalls, detail: outcome.error ?? `run ended: ${outcome.status ?? 'unknown'}` }
}

/** Wake `wake` when a run an earlier loop started ends (its card may be gated again). Returns the unsubscribe. */
export function onEarlierRunEnded(running: RunningTurns, owner: string, wake: () => void): () => void {
  return running.onEnded((turn) => {
    if (turn.owner !== owner) wake()
  })
}
