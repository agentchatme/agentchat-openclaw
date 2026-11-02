import { describe, expect, it } from 'vitest'

import {
  buildGateMessages,
  parseVerdicts,
  runGate,
  normalizeDecision,
  startTurn,
  countVerdicts,
  renderDeletedGroupNote,
  readGroupDeletion,
  type GateCaller,
} from '../../src/doorbell/gate.js'
import { MainLineClient, MainLineError, type Tray } from '../../src/doorbell/main-line.js'

const QUESTION = 'For each card decide: reply, dismiss or defer.'

function tray(overrides: Partial<Tray> = {}): Tray {
  return {
    you: 'alice',
    question: QUESTION,
    conversations: [
      { conversation_id: 'conv_a', type: 'direct', preview: { message_id: 'msg_a9', sender: 'bob', text: 'hi' } },
      { conversation_id: 'conv_b', type: 'group', preview: { message_id: 'msg_b3', sender: 'carol', text: 'ok' } },
    ],
    deferred: 0,
    truncated: false,
    ...overrides,
  }
}

/** A main-line client whose POSTs are recorded; `reject` makes the first N posts fail with the given status. */
function recordingMainLine(opts: { rejectStatus?: number; rejectTimes?: number } = {}) {
  const posts: Array<{ conversationId: string; body: Record<string, unknown> }> = []
  let rejectsLeft = opts.rejectTimes ?? 0
  const client = new MainLineClient({
    apiKey: 'ac_live_' + 'k'.repeat(24),
    apiBase: 'https://api.agentchat.me',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const conversationId = decodeURIComponent(url.split('/conversations/')[1]!.split('/')[0]!)
      posts.push({ conversationId, body: JSON.parse(init?.body as string) })
      if (rejectsLeft > 0 && opts.rejectStatus) {
        rejectsLeft -= 1
        return new Response(JSON.stringify({ code: 'VALIDATION_ERROR', message: 'bad field' }), { status: opts.rejectStatus })
      }
      return new Response(JSON.stringify({ decision: {} }), { status: 201 })
    }) as typeof fetch,
  })
  return { client, posts }
}

const answer = (text: string): GateCaller => async () => text

describe('buildGateMessages', () => {
  it('uses the tray question verbatim as the system prompt head, and the cards verbatim as the user content', () => {
    const t = tray()
    const m = buildGateMessages(t)
    expect(m.systemPrompt.startsWith(QUESTION)).toBe(true)
    expect(m.systemPrompt).toMatch(/Answer with ONLY a JSON object/)
    expect(m.systemPrompt).toMatch(/"reply" \| "dismiss" \| "defer"/)
    expect(m.systemPrompt).not.toMatch(/no_reply/)
    const payload = JSON.parse(m.userContent.slice(m.userContent.indexOf('\n') + 1))
    expect(payload.you).toBe('alice')
    expect(payload.conversations).toEqual(t.conversations)
  })

  it('offers categories only when the tray carries them', () => {
    expect(buildGateMessages(tray()).systemPrompt).not.toMatch(/category/)
    const withCats = buildGateMessages(tray({ categories: ['open_request', 'spam'] }))
    expect(withCats.systemPrompt).toMatch(/"category": "<one of: open_request, spam>"/)
  })

  it('prints a deleted group as a fact under the verbatim tray, so the model dismisses knowingly', () => {
    const deletedCard = {
      conversation_id: 'grp_old',
      type: 'group',
      group: { name: 'old-room', member_count: 3, deleted: { at: '2026-11-02T10:00:00Z', by: '@alice' } },
      preview: { message_id: 'msg_1', sender: 'alice', text: 'bye' },
    }
    const liveCard = { conversation_id: 'grp_live', type: 'group', group: { name: 'ops', member_count: 4, deleted: null }, preview: { message_id: 'msg_2' } }
    const olderServerCard = { conversation_id: 'grp_legacy', type: 'group', group: { name: 'legacy', member_count: 2 }, preview: { message_id: 'msg_3' } }
    const t = tray({ conversations: [deletedCard, liveCard, olderServerCard] })
    const m = buildGateMessages(t)
    // the tray itself is still verbatim JSON, with the server's field inside
    const jsonLine = m.userContent.split('\n')[1]!
    expect(JSON.parse(jsonLine).conversations).toEqual(t.conversations)
    // and exactly one note, for the deleted group only
    const notes = m.userContent.split('\n\n')[1]!.split('\n')
    expect(notes).toEqual(['Card grp_old: group "old-room" — DELETED by @alice at 2026-11-02T10:00:00Z; nothing can be sent here.'])
    expect(renderDeletedGroupNote(liveCard)).toBeNull()
    expect(renderDeletedGroupNote(olderServerCard)).toBeNull()
    expect(renderDeletedGroupNote({ conversation_id: 'conv_dm', type: 'direct', counterparty: { handle: 'bob' } })).toBeNull()
    expect(readGroupDeletion(deletedCard)).toEqual({ at: '2026-11-02T10:00:00Z', by: '@alice' })
    // a malformed deletion (missing fields) is ignored, never a crash
    expect(readGroupDeletion({ group: { deleted: { at: 1 } } })).toBeNull()
    expect(renderDeletedGroupNote({ group: { name: 'x', deleted: { at: 'now', by: '@b' } } })).toBe('Card <unknown conversation>: group "x" — DELETED by @b at now; nothing can be sent here.')
  })

  it('no notes when nothing is deleted — the user content is the tray alone', () => {
    const m = buildGateMessages(tray())
    expect(m.userContent.split('\n')).toHaveLength(2)
  })

  it('refuses a tray without a question (the gate fails closed instead of judging without it)', () => {
    expect(() => buildGateMessages(tray({ question: undefined }))).toThrow(/no gate question/)
  })
})

describe('parseVerdicts', () => {
  const known = ['conv_a', 'conv_b']

  it('reads the strict shape', () => {
    const v = parseVerdicts('{"decisions":[{"conversation_id":"conv_a","decision":"reply"},{"conversation_id":"conv_b","decision":"dismiss"}]}', { knownIds: known })
    expect(v).toEqual([
      { conversationId: 'conv_a', decision: 'reply' },
      { conversationId: 'conv_b', decision: 'dismiss' },
    ])
  })

  it('tolerates fences, prose, a bare list, and spelling — no_reply becomes dismiss', () => {
    const v = parseVerdicts('Sure!\n```json\n[{"conversation_id":"conv_a","decision":"No Reply"},{"conversation_id":"conv_b","decision":"Later","defer_seconds":600}]\n```', { knownIds: known })
    expect(v).toEqual([
      { conversationId: 'conv_a', decision: 'dismiss' },
      { conversationId: 'conv_b', decision: 'defer', deferSeconds: 600 },
    ])
  })

  it('drops unknown conversations, unknown decisions, duplicates, and categories not offered', () => {
    const v = parseVerdicts(
      JSON.stringify({
        decisions: [
          { conversation_id: 'conv_zzz', decision: 'reply' },
          { conversation_id: 'conv_a', decision: 'maybe' },
          { conversation_id: 'conv_b', decision: 'dismiss', category: 'spam' },
          { conversation_id: 'conv_b', decision: 'reply' },
        ],
      }),
      { knownIds: known, categories: ['open_request'] },
    )
    expect(v).toEqual([{ conversationId: 'conv_b', decision: 'dismiss' }])
  })

  it('keeps a category the tray offered and drops defer_seconds unless deferring', () => {
    const v = parseVerdicts(
      JSON.stringify({ decisions: [{ conversation_id: 'conv_a', decision: 'dismiss', category: 'Acknowledgement', defer_seconds: 900 }] }),
      { knownIds: known, categories: ['acknowledgement'] },
    )
    expect(v).toEqual([{ conversationId: 'conv_a', decision: 'dismiss', category: 'acknowledgement' }])
  })

  it('returns null when there is no JSON at all', () => {
    expect(parseVerdicts('I cannot decide.', { knownIds: known })).toBeNull()
    expect(parseVerdicts('', { knownIds: known })).toBeNull()
    expect(parseVerdicts(undefined, { knownIds: known })).toBeNull()
  })

  it('normalizeDecision maps the vocabulary', () => {
    expect(normalizeDecision('reply')).toBe('reply')
    expect(normalizeDecision('DISMISS')).toBe('dismiss')
    expect(normalizeDecision('no_reply')).toBe('dismiss')
    expect(normalizeDecision('defer')).toBe('defer')
    expect(normalizeDecision('shrug')).toBeNull()
  })
})

describe('runGate', () => {
  it('posts dismiss/defer with through_message_id from the card preview and never posts reply', async () => {
    const { client, posts } = recordingMainLine()
    const result = await runGate({
      tray: tray(),
      mainLine: client,
      caller: answer('{"decisions":[{"conversation_id":"conv_a","decision":"reply"},{"conversation_id":"conv_b","decision":"defer","defer_seconds":300}]}'),
      failOpen: false,
      timeoutMs: 1000,
    })
    expect(result.source).toBe('llm')
    expect(result.replyConversations).toEqual(['conv_a'])
    expect(result.posted).toBe(1)
    expect(posts).toEqual([{ conversationId: 'conv_b', body: { decision: 'defer', through_message_id: 'msg_b3', defer_seconds: 300 } }])
    expect(startTurn(result)).toBe(true)
    expect(countVerdicts(result)).toEqual({ reply: 1, dismiss: 0, defer: 1 })
  })

  it('posts no_reply spelled by the model as dismiss', async () => {
    const { client, posts } = recordingMainLine()
    const result = await runGate({
      tray: tray(),
      mainLine: client,
      caller: answer('{"decisions":[{"conversation_id":"conv_a","decision":"no_reply"},{"conversation_id":"conv_b","decision":"no_reply"}]}'),
      failOpen: false,
      timeoutMs: 1000,
    })
    expect(posts.map((p) => p.body.decision)).toEqual(['dismiss', 'dismiss'])
    expect(result.replyConversations).toEqual([])
    expect(startTurn(result)).toBe(false)
  })

  it('retries a 400 on optional fields with the bare verdict', async () => {
    const { client, posts } = recordingMainLine({ rejectStatus: 400, rejectTimes: 1 })
    const result = await runGate({
      tray: tray({ categories: ['spam'] }),
      mainLine: client,
      caller: answer('{"decisions":[{"conversation_id":"conv_a","decision":"dismiss","category":"spam"},{"conversation_id":"conv_b","decision":"reply"}]}'),
      failOpen: false,
      timeoutMs: 1000,
    })
    expect(posts).toHaveLength(2)
    expect(posts[0]!.body).toEqual({ decision: 'dismiss', category: 'spam', through_message_id: 'msg_a9' })
    expect(posts[1]!.body).toEqual({ decision: 'dismiss', through_message_id: 'msg_a9' })
    expect(result.posted).toBe(1)
    expect(result.postFailures).toBe(0)
  })

  it('counts a verdict the server refuses outright as a post failure', async () => {
    const { client } = recordingMainLine({ rejectStatus: 404, rejectTimes: 5 })
    const result = await runGate({
      tray: tray(),
      mainLine: client,
      caller: answer('{"decisions":[{"conversation_id":"conv_a","decision":"dismiss"},{"conversation_id":"conv_b","decision":"dismiss"}]}'),
      failOpen: false,
      timeoutMs: 1000,
    })
    expect(result.postFailures).toBe(2)
    expect(result.posted).toBe(0)
  })

  it('fails closed when the model call throws: nothing posted, no turn', async () => {
    const { client, posts } = recordingMainLine()
    const result = await runGate({
      tray: tray(),
      mainLine: client,
      caller: async () => {
        throw new Error('provider down')
      },
      failOpen: false,
      timeoutMs: 1000,
    })
    expect(result.source).toBe('fail_closed')
    expect(result.failure).toMatch(/provider down/)
    expect(result.undecided).toEqual(['conv_a', 'conv_b'])
    expect(posts).toHaveLength(0)
    expect(startTurn(result)).toBe(false)
  })

  it('fails open when configured: the turn starts with every card, nothing posted', async () => {
    const { client, posts } = recordingMainLine()
    const result = await runGate({ tray: tray(), mainLine: client, caller: answer('nonsense'), failOpen: true, timeoutMs: 1000 })
    expect(result.source).toBe('fail_open')
    expect(result.replyConversations).toEqual(['conv_a', 'conv_b'])
    expect(posts).toHaveLength(0)
    expect(startTurn(result)).toBe(true)
  })

  it('fails closed on a tray without a question', async () => {
    const { client } = recordingMainLine()
    const result = await runGate({ tray: tray({ question: '' }), mainLine: client, caller: answer('{}'), failOpen: false, timeoutMs: 1000 })
    expect(result.source).toBe('fail_closed')
    expect(result.failure).toMatch(/no gate question/)
  })

  it('reports cards the model skipped as undecided', async () => {
    const { client } = recordingMainLine()
    const result = await runGate({
      tray: tray(),
      mainLine: client,
      caller: answer('{"decisions":[{"conversation_id":"conv_a","decision":"reply"}]}'),
      failOpen: false,
      timeoutMs: 1000,
    })
    expect(result.undecided).toEqual(['conv_b'])
    expect(result.replyConversations).toEqual(['conv_a'])
  })

  it('an empty tray is empty, not a failure', async () => {
    const { client } = recordingMainLine()
    const result = await runGate({ tray: tray({ conversations: [] }), mainLine: client, caller: answer('{}'), failOpen: false, timeoutMs: 1000 })
    expect(result.source).toBe('empty')
    expect(startTurn(result)).toBe(false)
  })

  it('MainLineError is what a rejected verdict looks like', () => {
    const err = new MainLineError('x', { status: 400, code: 'VALIDATION_ERROR' })
    expect(err.status).toBe(400)
  })
})
