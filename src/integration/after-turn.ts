/**
 * The after-turn recording for a turn the kit's loop no longer watches.
 *
 * Normally the kit's receive loop records what a turn did once its run ends
 * (contract v1, D5: `turnOutcome` / `applyOutcome` on a fresh tray). Two
 * kinds of turn end outside that watch, and this applies the same rule to
 * them:
 *
 *   - a turn handed off after 30 minutes (`AccountTurns.handOff`): the kit
 *     let go of it to free its slot, so without this an answer sent at
 *     minute 35 would record nothing and the card would be gated again;
 *   - a turn a gateway restart ended, read again on the next start, and a
 *     run OpenClaw's restart resume started in that turn's session
 *     (`AccountTurns.adopt`).
 *
 * The kit's per-anchor memory of earlier silent turns is the loop's own, so
 * a silent end here counts as the first (`silentBefore` 0): nothing is
 * recorded and the card is gated again — never a dismiss on a count this
 * side cannot know.
 */

import { integration, type AgentChatClient, type InboxCard, type InboxTray } from 'agentchatme'

import type { Logger } from '../log.js'
import type { RunRecord } from './running.js'

/** The tray read the kit's loop makes after a turn. */
const TRAY_LIMIT = 50

/** Records what a turn did, from a fresh tray. Never rejects. */
export type AfterTurnRecorder = (record: RunRecord, end: integration.TurnEnd) => Promise<void>

export type AfterTurnClient = Pick<AgentChatClient, 'inbox' | 'decisions' | 'groups'>

export function createAfterTurnRecorder(options: { client: AfterTurnClient; logger: Logger }): AfterTurnRecorder {
  const { client, logger } = options
  return async (record, end) => {
    if (end.status === 'still_running' || record.kind === 'run') return
    let fresh: InboxTray | null
    try {
      fresh = await client.inbox.tray({ waitMs: 0, limit: TRAY_LIMIT, includeInvites: true })
    } catch (err) {
      // The card stays on the tray; the server re-wakes it.
      logger.warn({ runId: record.runId, err: describe(err) }, 'after-turn tray read failed — nothing recorded; the server re-wakes the card')
      fresh = null
    }
    try {
      if (record.kind === 'reply') {
        if (!record.card) return
        const outcome = integration.turnOutcome({
          turn: end,
          turnStartedAt: record.startedAt,
          gateCard: record.card,
          category: (record.category ?? null) as integration.TurnOutcomeInput['category'],
          freshTray: fresh,
          silentBefore: 0,
        })
        const recorded = await integration.applyOutcome(client, outcome)
        logger.info({ runId: record.runId, conversationId: record.id, action: outcome.action, reason: outcome.reason, recorded }, 'after-turn rule applied (turn ended outside the loop’s watch)')
        return
      }
      if (!record.invite) return
      const outcome = integration.inviteOutcome({ turn: end, invite: record.invite, freshTray: fresh, silentBefore: 0 })
      const recorded = await integration.applyInviteOutcome(client, outcome)
      logger.info({ runId: record.runId, inviteId: record.id, action: outcome.action, reason: outcome.reason, recorded }, 'after-turn rule applied to the invite (turn ended outside the loop’s watch)')
    } catch (err) {
      logger.warn({ runId: record.runId, err: describe(err) }, 'after-turn recording failed — the card stays on the tray; the server re-wakes it')
    }
  }
}

/** The card the gate saw, rebuilt from what was stored (no message text). */
export function cardFromStored(stored: { conversation_id: string } & Record<string, unknown>): InboxCard {
  return { preview: null, ...stored } as unknown as InboxCard
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
