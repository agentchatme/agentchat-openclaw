/**
 * How the kit's receive loop starts a turn on OpenClaw.
 *
 * The loop (gate-call mode) decides which conversations and invites get a
 * turn, composes the prompt from the served texts, and holds the card in
 * its tracker while the turn runs; this adapter runs the turn as one
 * OpenClaw agent run (`runtime.subagent.run`, `deliver: false`, a fresh
 * session, the account's lane) and reports its end in the kit's terms once
 * OpenClaw has confirmed it (`./run.ts`):
 *
 *   - `ok`                        → `completed`, with the AgentChat calls the
 *                                   run made (from its transcript; null = unknown)
 *   - `error`, `timeout`          → `failed` (the run's own deadline is a failure,
 *                                   never an elapsed wait)
 *   - the plugin runtime is gone  → `still_running` with no `next`: the tracker
 *                                   keeps the conversation, nothing in this process
 *                                   starts a second turn for it
 *
 * A run that never ends keeps holding its card: the loop cannot end a turn,
 * and the plugin runtime offers no abort for a subagent run. OpenClaw's own
 * run deadline (`agents.defaults.timeoutSeconds`) is what ends it; status and
 * the log say so once a turn has run for 30 minutes.
 */

import type { integration } from 'agentchatme'

import type { Logger } from '../log.js'
import type { TurnOutcome, TurnStarter as RuntimeTurnStarter } from './model.js'
import { forgetRun, labelRun } from './running.js'
import { integrationLane, inviteSessionKey, wakeSessionKey } from './turn.js'

export interface LoopTurnStarterOptions {
  readonly accountId: string
  /** The OpenClaw agent the account is routed to. */
  readonly agentId: string
  /** Starts one OpenClaw run and reports its confirmed end (`createRuntimeTurnStarter`). */
  readonly startRun: RuntimeTurnStarter
  readonly logger: Logger
  readonly now?: () => number
}

/** The kit's `TurnStarter` for OpenClaw. */
export function createLoopTurnStarter(options: LoopTurnStarterOptions): integration.TurnStarter {
  const now = options.now ?? Date.now
  return async (request) => {
    const id = request.kind === 'reply' ? request.conversationId : request.invite.invite_id
    const sessionKey = request.kind === 'reply' ? wakeSessionKey(options.agentId, now()) : inviteSessionKey(options.agentId, id, now())
    const admission = await options.startRun({ sessionKey, prompt: request.prompt, lane: integrationLane(options.accountId) })
    if (!admission.ran) return { started: false, error: admission.error }
    labelRun(admission.runId, { kind: request.kind, id, sessionKey })
    options.logger.info(
      { kind: request.kind, sessionKey, runId: admission.runId, ...(request.kind === 'reply' ? { conversationId: id } : { inviteId: id }) },
      request.kind === 'reply' ? 'turn start' : 'group-invite turn start',
    )
    const done = admission.done.then((outcome): integration.TurnEnd => {
      if (outcome.status === 'gone') {
        options.logger.warn({ sessionKey, runId: outcome.runId }, 'turn end not confirmed: the plugin runtime is gone — its card stays held')
        return { status: 'still_running', detail: 'the plugin runtime is gone' }
      }
      forgetRun(admission.runId)
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
