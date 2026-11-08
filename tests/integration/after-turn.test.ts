/**
 * The after-turn rule for a turn the kit's loop no longer watches (handed
 * off after 30 minutes, or ended by a gateway restart): the kit's D5 rule on
 * a fresh tray, the one recording call it asks for. A silent end counts as
 * the first (nothing recorded); a failed tray read records nothing.
 */

import { describe, expect, it } from 'vitest'
import type { InboxCard, TrayInvite } from 'agentchatme'

import { cardFromStored, createAfterTurnRecorder } from '../../src/integration/after-turn.js'
import type { RunRecord } from '../../src/integration/running.js'
import { storedCard } from '../../src/integration/turn-store.js'
import { card, invite, tray } from '../helpers/fake-client.js'
import { capturingLogger } from '../helpers/logger.js'

function server(cards: InboxCard[], invites: TrayInvite[] = [], opts: { trayFails?: boolean } = {}) {
  const posts: string[] = []
  const dismissed: string[] = []
  const client = {
    inbox: {
      tray: async () => {
        if (opts.trayFails) throw new Error('503')
        return tray(cards, { invites })
      },
    },
    decisions: {
      record: async (conversationId: string, o: { decision: string; throughMessageId?: string }) => {
        posts.push(`${conversationId}:${o.decision}:${o.throughMessageId ?? '-'}`)
        return {} as never
      },
    },
    groups: { dismissInvite: async (id: string) => (dismissed.push(id), { dismissed: true }) },
  }
  return { client: client as never, posts, dismissed }
}

const gateCard = card('conv_a', 'msg_1', { you_owe_reply: true, your_last_message_at: null })
const turn = (extra: Partial<RunRecord> = {}): RunRecord => ({ runId: 'run_1', kind: 'reply', id: 'conv_a', anchor: 'msg_1', sessionKey: 's', startedAt: 0, owner: 'loop#1', card: gateCard, category: null, ...extra })

describe('a reply turn', () => {
  it('an answer sent at minute 35 records reply through the anchor the gate saw', async () => {
    const s = server([card('conv_a', 'msg_1', { you_owe_reply: false, your_last_message_at: '2026-11-08T00:35:00.000Z' })])
    await createAfterTurnRecorder({ client: s.client, logger: capturingLogger() })(turn(), { status: 'completed', agentchatCalls: { made: 3, failed: 0 } })
    expect(s.posts).toEqual(['conv_a:reply:msg_1'])
  })

  it('also when the run ended in failure (a restart) after the send', async () => {
    const s = server([card('conv_a', 'msg_1', { you_owe_reply: false, your_last_message_at: '2026-11-08T00:35:00.000Z' })])
    await createAfterTurnRecorder({ client: s.client, logger: capturingLogger() })(turn(), { status: 'failed', agentchatCalls: null, detail: 'the gateway restarted during the turn' })
    expect(s.posts).toEqual(['conv_a:reply:msg_1'])
  })

  it('a silent end is the first silent look: nothing recorded; a failed run without a send: nothing', async () => {
    const s = server([gateCard])
    const record = createAfterTurnRecorder({ client: s.client, logger: capturingLogger() })
    await record(turn(), { status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    await record(turn(), { status: 'failed', agentchatCalls: null })
    expect(s.posts).toEqual([])
  })

  it('a tray that cannot be read records nothing (the server re-wakes the card)', async () => {
    const s = server([], [], { trayFails: true })
    const logger = capturingLogger()
    await createAfterTurnRecorder({ client: s.client, logger })(turn(), { status: 'completed', agentchatCalls: { made: 1, failed: 0 } })
    expect(s.posts).toEqual([])
    expect(logger.at('warn').some((l) => /after-turn tray read failed/.test(l.msg ?? ''))).toBe(true)
  })

  it('works from a card restored after a restart (no message text kept)', async () => {
    const s = server([card('conv_a', 'msg_1', { you_owe_reply: false, your_last_message_at: '2026-11-08T00:35:00.000Z' })])
    const restored = cardFromStored(storedCard(gateCard, 'msg_1') as never)
    await createAfterTurnRecorder({ client: s.client, logger: capturingLogger() })(turn({ card: restored }), { status: 'failed', agentchatCalls: null })
    expect(s.posts).toEqual(['conv_a:reply:msg_1'])
  })
})

describe('an invite turn', () => {
  it('answered or failed: nothing to record (an invite is dismissed only after a second silent look the loop counts)', async () => {
    const s = server([], [invite('inv_1')])
    const record = createAfterTurnRecorder({ client: s.client, logger: capturingLogger() })
    const inviteTurn = turn({ kind: 'invite', id: 'inv_1', anchor: null, invite: invite('inv_1') })
    await record(inviteTurn, { status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    await record(inviteTurn, { status: 'failed', agentchatCalls: null })
    expect(s.dismissed).toEqual([])
  })
})
