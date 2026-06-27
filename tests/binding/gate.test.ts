import { describe, it, expect, vi } from 'vitest'

import { decideReply, type DecideReplyParams, type GateCaller } from '../../src/binding/gate.js'

function params(over: Partial<DecideReplyParams> = {}): DecideReplyParams {
  return {
    cfg: {} as never, // unused when a caller is injected
    agentId: 'a',
    handle: 'me',
    event: {
      conversationKind: 'direct',
      senderHandle: 'alice',
      contentText: 'can you review the spec?',
    },
    history: [],
    rawMessages: [],
    triggerMessageId: 't',
    ownHandle: 'me',
    nowMs: Date.parse('2026-06-27T12:00:00.000Z'),
    failOpen: true,
    ...over,
  }
}

describe('decideReply', () => {
  it('returns reply=true when the model decides to reply', async () => {
    const d = await decideReply(
      params({
        caller: async () => '{"decision":"reply","reason":"open question","category":"open_request"}',
      }),
    )
    expect(d.reply).toBe(true)
    expect(d.source).toBe('llm')
    expect(d.category).toBe('open_request')
  })

  it('returns reply=false when the model decides no_reply', async () => {
    const d = await decideReply(
      params({
        caller: async () => '{"decision":"no_reply","reason":"done","category":"closing"}',
      }),
    )
    expect(d.reply).toBe(false)
    expect(d.source).toBe('llm')
  })

  it('fails open (reply) when the decision call throws', async () => {
    const d = await decideReply(
      params({
        failOpen: true,
        caller: async () => {
          throw new Error('provider down')
        },
      }),
    )
    expect(d.reply).toBe(true)
    expect(d.source).toBe('fail_open')
    expect(d.reason).toBe('decision_call_error')
  })

  it('fails closed (silent) when the decision call throws and failOpen is false', async () => {
    const d = await decideReply(
      params({
        failOpen: false,
        caller: async () => {
          throw new Error('provider down')
        },
      }),
    )
    expect(d.reply).toBe(false)
    expect(d.source).toBe('fail_closed')
  })

  it('applies the fallback when the model returns unparseable output', async () => {
    const d = await decideReply(
      params({ failOpen: true, caller: async () => 'not json' }),
    )
    expect(d.reply).toBe(true)
    expect(d.source).toBe('fail_open')
    expect(d.reason).toBe('unparseable_decision')
  })

  it('hands the caller the done-ness system prompt and the new message', async () => {
    const caller = vi.fn<GateCaller>(async () => '{"decision":"reply"}')
    await decideReply(params({ caller }))
    expect(caller).toHaveBeenCalledTimes(1)
    const arg = caller.mock.calls[0]?.[0]
    expect(arg?.systemPrompt).toContain('reply gate for @me')
    expect(arg?.userContent).toContain('New message from @alice: can you review the spec?')
    expect(arg?.maxTokens).toBeGreaterThan(0)
  })
})
