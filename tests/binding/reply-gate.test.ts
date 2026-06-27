import { describe, it, expect } from 'vitest'

import {
  CADENCE_WINDOW_SECONDS,
  buildDecisionMessages,
  computeConversationSignals,
  gateFallback,
  parseDecision,
  type GateRawMessage,
  type HistoryTurn,
} from '../../src/binding/reply-gate.js'

const NOW = Date.parse('2026-06-27T12:00:00.000Z')
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString()

function msg(over: Partial<GateRawMessage>): GateRawMessage {
  return { id: 'm', created_at: iso(1000), sender: 'alice', ...over }
}

describe('computeConversationSignals', () => {
  it('reports first contact when no prior messages', () => {
    const s = computeConversationSignals([], {
      ownHandle: 'me',
      triggerMessageId: 't',
      nowMs: NOW,
    })
    expect(s.firstContact).toBe(true)
    expect(s.youHaveSpoken).toBe(false)
    expect(s.messagesLastWindow).toBe(1) // the new message itself
    expect(s.secondsSincePrevious).toBeNull()
  })

  it('excludes the triggering message from prior history', () => {
    const s = computeConversationSignals(
      [msg({ id: 'trigger' })],
      { ownHandle: 'me', triggerMessageId: 'trigger', nowMs: NOW },
    )
    expect(s.firstContact).toBe(true)
  })

  it('detects youHaveSpoken via server-precomputed is_own', () => {
    const s = computeConversationSignals(
      [msg({ id: 'a', is_own: true })],
      { ownHandle: 'me', triggerMessageId: 't', nowMs: NOW },
    )
    expect(s.youHaveSpoken).toBe(true)
    expect(s.firstContact).toBe(false)
  })

  it('detects youHaveSpoken via sender handle when is_own absent', () => {
    const s = computeConversationSignals(
      [msg({ id: 'a', sender: '@ME' })],
      { ownHandle: 'me', triggerMessageId: 't', nowMs: NOW },
    )
    expect(s.youHaveSpoken).toBe(true)
  })

  it('counts only messages inside the cadence window (plus the new one)', () => {
    const inWindow = [
      msg({ id: 'a', created_at: iso(5_000) }),
      msg({ id: 'b', created_at: iso(20_000) }),
    ]
    const outOfWindow = msg({
      id: 'c',
      created_at: iso((CADENCE_WINDOW_SECONDS + 30) * 1000),
    })
    const s = computeConversationSignals([...inWindow, outOfWindow], {
      ownHandle: 'me',
      triggerMessageId: 't',
      nowMs: NOW,
    })
    expect(s.messagesLastWindow).toBe(3) // 2 in-window + the new message
  })

  it('computes seconds since the most recent prior message', () => {
    const s = computeConversationSignals(
      [msg({ id: 'a', created_at: iso(8_000) }), msg({ id: 'b', created_at: iso(3_000) })],
      { ownHandle: 'me', triggerMessageId: 't', nowMs: NOW },
    )
    expect(s.secondsSincePrevious).toBe(3) // newest prior was 3s ago
  })

  it('clamps negative gaps from clock skew to zero', () => {
    const s = computeConversationSignals(
      [msg({ id: 'a', created_at: iso(-5_000) })], // 5s in the "future"
      { ownHandle: 'me', triggerMessageId: 't', nowMs: NOW },
    )
    expect(s.secondsSincePrevious).toBe(0)
  })

  it('tolerates malformed timestamps and non-object rows', () => {
    const s = computeConversationSignals(
      [
        msg({ id: 'a', created_at: 'not-a-date' }),
        msg({ id: 'b', created_at: undefined }),
        null as unknown as GateRawMessage,
      ],
      { ownHandle: 'me', triggerMessageId: 't', nowMs: NOW },
    )
    expect(s.secondsSincePrevious).toBeNull() // no usable timestamps
    expect(s.firstContact).toBe(false) // two valid prior rows remain
  })
})

describe('buildDecisionMessages', () => {
  const event = {
    conversationKind: 'direct' as const,
    senderHandle: 'alice',
    contentText: 'can you review the spec?',
  }
  const signals = {
    firstContact: false,
    youHaveSpoken: true,
    messagesLastWindow: 4,
    secondsSincePrevious: 12,
  }

  it('returns a system message and a user message', () => {
    const out = buildDecisionMessages({ handle: 'me', event, history: [], signals })
    expect(out).toHaveLength(2)
    expect(out[0]?.role).toBe('system')
    expect(out[1]?.role).toBe('user')
    expect(out[0]?.content).toContain('reply gate for @me')
  })

  it('includes a pace line when a previous-message gap exists', () => {
    const out = buildDecisionMessages({ handle: 'me', event, history: [], signals })
    expect(out[1]?.content).toContain('Pace: 4 message(s) in the last 60s')
    expect(out[1]?.content).toContain('12s since the previous message')
  })

  it('omits the pace line when there is no usable previous timestamp', () => {
    const out = buildDecisionMessages({
      handle: 'me',
      event,
      history: [],
      signals: { ...signals, secondsSincePrevious: null },
    })
    expect(out[1]?.content).not.toContain('Pace:')
  })

  it('flags explicit group addressing', () => {
    const out = buildDecisionMessages({
      handle: 'me',
      event: { conversationKind: 'group', senderHandle: 'bob', contentText: 'hey @me look here' },
      history: [],
      signals,
    })
    expect(out[1]?.content).toContain('Message directly addresses you: yes')
  })

  it('marks group messages not addressed to the agent', () => {
    const out = buildDecisionMessages({
      handle: 'me',
      event: { conversationKind: 'group', senderHandle: 'bob', contentText: 'anyone around?' },
      history: [],
      signals,
    })
    expect(out[1]?.content).toContain('Message directly addresses you: not explicitly')
  })

  it('omits the addressing line for direct conversations', () => {
    const out = buildDecisionMessages({ handle: 'me', event, history: [], signals })
    expect(out[1]?.content).not.toContain('Message directly addresses you')
  })

  it('renders the tail of history as you/peer lines, newest-trimmed', () => {
    const history: HistoryTurn[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]
    const out = buildDecisionMessages({ handle: 'me', event, history, signals, maxHistory: 2 })
    const content = out[1]?.content ?? ''
    expect(content).toContain('Recent conversation (oldest first):')
    expect(content).not.toContain('peer: first') // trimmed by maxHistory
    expect(content).toContain('you: second')
    expect(content).toContain('peer: third')
  })

  it('marks first contact when there is no history', () => {
    const out = buildDecisionMessages({ handle: 'me', event, history: [] })
    expect(out[1]?.content).toContain('Recent conversation: (none — this is first contact)')
  })

  it('includes the new message with the sender handle', () => {
    const out = buildDecisionMessages({ handle: 'me', event, history: [], signals })
    expect(out[1]?.content).toContain('New message from @alice: can you review the spec?')
  })
})

describe('parseDecision', () => {
  it('parses a plain JSON reply decision', () => {
    const d = parseDecision('{"decision":"reply","reason":"open question","category":"open_request"}')
    expect(d).not.toBeNull()
    expect(d?.reply).toBe(true)
    expect(d?.category).toBe('open_request')
    expect(d?.source).toBe('llm')
  })

  it('parses a fenced ```json block', () => {
    const d = parseDecision('```json\n{"decision":"no_reply","reason":"done","category":"closing"}\n```')
    expect(d?.reply).toBe(false)
    expect(d?.category).toBe('closing')
  })

  it('accepts reply/no_reply synonyms', () => {
    expect(parseDecision('{"decision":"yes"}')?.reply).toBe(true)
    expect(parseDecision('{"decision":"none"}')?.reply).toBe(false)
    expect(parseDecision('{"decision":"skip"}')?.reply).toBe(false)
  })

  it('tolerates surrounding prose around the JSON object', () => {
    const d = parseDecision('Here is my call: {"decision":"reply"} — done.')
    expect(d?.reply).toBe(true)
  })

  it('normalizes an unknown category to "other"', () => {
    const d = parseDecision('{"decision":"reply","category":"made_up"}')
    expect(d?.category).toBe('other')
  })

  it('truncates an overlong reason', () => {
    const d = parseDecision(`{"decision":"reply","reason":"${'x'.repeat(400)}"}`)
    expect(d?.reason.length).toBe(280)
  })

  it('returns null on garbage, missing decision, or non-object', () => {
    expect(parseDecision('not json at all')).toBeNull()
    expect(parseDecision('{"reason":"no decision field"}')).toBeNull()
    expect(parseDecision('{"decision":"maybe"}')).toBeNull()
    expect(parseDecision('[1,2,3]')).toBeNull()
    expect(parseDecision('')).toBeNull()
    expect(parseDecision(null)).toBeNull()
  })

  it('records the provided source and latency', () => {
    const d = parseDecision('{"decision":"reply"}', { source: 'llm', latencyMs: 42 })
    expect(d?.latencyMs).toBe(42)
  })
})

describe('gateFallback', () => {
  it('replies on fail-open', () => {
    const d = gateFallback(true, 'decision_call_error', 15)
    expect(d.reply).toBe(true)
    expect(d.source).toBe('fail_open')
    expect(d.category).toBe('fallback')
    expect(d.latencyMs).toBe(15)
  })

  it('stays silent on fail-closed', () => {
    const d = gateFallback(false, 'unparseable_decision', 9)
    expect(d.reply).toBe(false)
    expect(d.source).toBe('fail_closed')
  })
})
