import { describe, expect, it } from 'vitest'

import { MainLineClient, MainLineError, INBOX_PATH } from '../../src/doorbell/main-line.js'

const KEY = 'ac_live_' + 'k'.repeat(24)

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init: init ?? {} })
    return handler(url, init ?? {})
  }) as unknown as typeof fetch & { calls: typeof calls }
  f.calls = calls
  return f
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('MainLineClient.inbox', () => {
  it('GETs /v1/inbox with wait_ms=0 and limit=50 by default, bearer + client headers, and returns the tray verbatim', async () => {
    const tray = { you: 'alice', question: 'Q?', categories: ['open_request'], conversations: [{ conversation_id: 'conv_1' }], deferred: 0, truncated: false, extra: { newer: true } }
    const f = fakeFetch(() => json(200, tray))
    const client = new MainLineClient({ apiKey: KEY, apiBase: 'https://api.agentchat.me/', fetch: f })
    const got = await client.inbox()
    expect(got).toEqual(tray)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe(`https://api.agentchat.me${INBOX_PATH}?wait_ms=0&limit=50`)
    const headers = f.calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${KEY}`)
    expect(headers['X-AgentChat-Client']).toBe('openclaw')
    expect(f.calls[0]!.init.method).toBe('GET')
  })

  it('rejects out-of-range wait_ms / limit before any request', async () => {
    const f = fakeFetch(() => json(200, {}))
    const client = new MainLineClient({ apiKey: KEY, apiBase: 'https://api.agentchat.me', fetch: f })
    await expect(client.inbox({ waitMs: 60_000 })).rejects.toThrow(RangeError)
    await expect(client.inbox({ limit: 0 })).rejects.toThrow(RangeError)
    expect(f.calls).toHaveLength(0)
  })

  it('raises MainLineError with status and server code on a non-2xx answer', async () => {
    const f = fakeFetch(() => json(429, { code: 'RATE_LIMITED', message: 'slow down' }))
    const client = new MainLineClient({ apiKey: KEY, apiBase: 'https://api.agentchat.me', fetch: f })
    const err = await client.inbox().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MainLineError)
    expect((err as MainLineError).status).toBe(429)
    expect((err as MainLineError).code).toBe('RATE_LIMITED')
    expect((err as MainLineError).message).toMatch(/slow down/)
  })

  it('raises MainLineError (no status) on a transport failure', async () => {
    const f = fakeFetch(() => {
      throw new Error('ECONNRESET')
    })
    const client = new MainLineClient({ apiKey: KEY, apiBase: 'https://api.agentchat.me', fetch: f })
    const err = await client.inbox().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MainLineError)
    expect((err as MainLineError).status).toBeUndefined()
  })

  it('rejects a non-object tray', async () => {
    const f = fakeFetch(() => json(200, [1, 2]))
    const client = new MainLineClient({ apiKey: KEY, apiBase: 'https://api.agentchat.me', fetch: f })
    await expect(client.inbox()).rejects.toBeInstanceOf(MainLineError)
  })
})

describe('MainLineClient.recordDecision', () => {
  it('POSTs the verdict body exactly, omitting absent optional fields', async () => {
    const f = fakeFetch(() => json(201, { decision: { id: 'dec_1' } }))
    const client = new MainLineClient({ apiKey: KEY, apiBase: 'https://api.agentchat.me', fetch: f })
    await client.recordDecision('conv_1', { decision: 'dismiss', throughMessageId: 'msg_9' })
    expect(f.calls[0]!.url).toBe('https://api.agentchat.me/v1/conversations/conv_1/decisions')
    expect(f.calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ decision: 'dismiss', through_message_id: 'msg_9' })
  })

  it('passes category and defer_seconds through untouched', async () => {
    const f = fakeFetch(() => json(201, {}))
    const client = new MainLineClient({ apiKey: KEY, apiBase: 'https://api.agentchat.me', fetch: f })
    await client.recordDecision('conv_1', { decision: 'defer', category: 'goal_followup', deferSeconds: 900 })
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ decision: 'defer', category: 'goal_followup', defer_seconds: 900 })
  })

  it('surfaces a 400 VALIDATION_ERROR so the gate can retry bare', async () => {
    const f = fakeFetch(() => json(400, { code: 'VALIDATION_ERROR', message: 'category' }))
    const client = new MainLineClient({ apiKey: KEY, apiBase: 'https://api.agentchat.me', fetch: f })
    const err = await client.recordDecision('conv_1', { decision: 'dismiss', category: 'nope' }).catch((e: unknown) => e)
    expect((err as MainLineError).status).toBe(400)
    expect((err as MainLineError).code).toBe('VALIDATION_ERROR')
  })

  it('requires a conversation id', async () => {
    const client = new MainLineClient({ apiKey: KEY, apiBase: 'https://api.agentchat.me', fetch: fakeFetch(() => json(201, {})) })
    await expect(client.recordDecision('', { decision: 'dismiss' })).rejects.toThrow(RangeError)
  })
})
