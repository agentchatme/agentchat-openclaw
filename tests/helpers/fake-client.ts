/**
 * A fake of the SDK client surface the integration uses: the tray, verdict
 * recording, texts, the invite list. Records every verdict in wire shape so
 * tests assert what the server would have received.
 */

import type { InboxCard, InboxTray, ReplyDecision, Texts } from 'agentchatme'

import { SERVED_TEXTS } from './texts.js'

export interface RecordedVerdict {
  conversationId: string
  body: { decision: string; category?: string; through_message_id?: string }
}

export function card(id: string, messageId: string, extra: Record<string, unknown> = {}): InboxCard {
  return {
    conversation_id: id,
    type: 'direct',
    group: null,
    counterparty: { handle: '@bob', display_name: null },
    relationship: 'first_contact',
    you_owe_reply: true,
    mentioned_you: false,
    unread: 1,
    oldest_unread_at: '2026-11-04T22:58:10.000Z',
    newest_unread_at: '2026-11-04T22:58:10.000Z',
    last_sender: '@bob',
    last_message_at: '2026-11-04T22:58:10.000Z',
    your_last_message_at: null,
    pace: { last_60s: 0, last_10m: 1 },
    preview: { message_id: messageId, sender: '@bob', text: 'x', at: '2026-11-04T22:58:10.000Z' },
    your_last_decision: null,
    ...extra,
  } as InboxCard
}

export function tray(cards: InboxCard[], extra: Partial<InboxTray> = {}): InboxTray {
  return {
    you: '@alice',
    question: 'For each conversation decide ONE thing: reply, dismiss, or defer. Record dismiss and defer with agentchat_decide.',
    categories: ['open_request', 'closing', 'acknowledgement', 'other'],
    conversations: cards,
    deferred: 0,
    truncated: false,
    waited_ms: null,
    ...extra,
  }
}

export interface FakeClientOptions {
  /** Tray answers in order; the last one repeats. An Error entry rejects the read. */
  trays?: Array<InboxTray | Error>
  texts?: Texts | Error
  invites?: unknown[]
  /** Reject these verdict posts (by conversation id). */
  rejectRecords?: Set<string>
}

export function fakeClient(options: FakeClientOptions = {}) {
  const trays = [...(options.trays ?? [tray([])])]
  const posts: RecordedVerdict[] = []
  let trayCalls = 0
  const client = {
    inbox: {
      tray: async (): Promise<InboxTray> => {
        trayCalls += 1
        const next = trays.length > 1 ? trays.shift()! : trays[0]!
        if (next instanceof Error) throw next
        return next
      },
    },
    decisions: {
      record: async (conversationId: string, opts: { decision: string; category?: string; throughMessageId?: string }): Promise<ReplyDecision> => {
        if (options.rejectRecords?.has(conversationId)) throw new Error(`record refused for ${conversationId}`)
        posts.push({
          conversationId,
          body: {
            decision: opts.decision,
            ...(opts.category ? { category: opts.category } : {}),
            ...(opts.throughMessageId ? { through_message_id: opts.throughMessageId } : {}),
          },
        })
        return {
          id: `dec_${posts.length}`,
          conversation_id: conversationId,
          decision: opts.decision as ReplyDecision['decision'],
          category: (opts.category ?? null) as ReplyDecision['category'],
          through_message_id: opts.throughMessageId ?? null,
          defer_until: null,
          created_at: '2026-11-04T23:00:00.000Z',
        }
      },
    },
    texts: {
      get: async (): Promise<Texts> => {
        const t = options.texts ?? SERVED_TEXTS
        if (t instanceof Error) throw t
        return t
      },
    },
    listGroupInvites: async () => options.invites ?? [],
  }
  return { client, posts, trayCalls: () => trayCalls }
}

export type FakeClient = ReturnType<typeof fakeClient>['client']
