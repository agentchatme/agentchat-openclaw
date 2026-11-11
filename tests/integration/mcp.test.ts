import { describe, expect, it } from 'vitest'

import {
  hostedMcpUrl,
  hostedMcpServerEntry,
  hostedMcpSnippet,
  describeMcpEntry,
  withHostedMcpEntry,
  withoutHostedMcpEntry,
  probeHostedMcp,
  AUTH_HEADER_TEMPLATE,
} from '../../src/integration/mcp.js'
import { testKey } from '../helpers/keys.js'

describe('hosted MCP entry', () => {
  it('is the hosted endpoint over streamable-http with a bearer TEMPLATE, never a key', () => {
    expect(hostedMcpUrl()).toBe('https://api.agentchat.me/mcp')
    expect(hostedMcpUrl('https://staging.agentchat.me/')).toBe('https://staging.agentchat.me/mcp')
    expect(hostedMcpServerEntry()).toEqual({
      url: 'https://api.agentchat.me/mcp',
      transport: 'streamable-http',
      headers: { Authorization: 'Bearer ${AGENTCHAT_API_KEY}' },
    })
    expect(AUTH_HEADER_TEMPLATE).toBe('Bearer ${AGENTCHAT_API_KEY}')
    expect(hostedMcpSnippet()).toContain('transport: "streamable-http"')
    expect(hostedMcpSnippet()).toContain('Authorization: "Bearer ${AGENTCHAT_API_KEY}"')
  })

  it('classifies the config entry', () => {
    expect(describeMcpEntry(undefined)).toBe('missing')
    expect(describeMcpEntry({})).toBe('missing')
    expect(describeMcpEntry({ mcp: { servers: { agentchat: hostedMcpServerEntry() } } })).toBe('ours')
    expect(describeMcpEntry({ mcp: { servers: { agentchat: { ...hostedMcpServerEntry(), requestTimeoutMs: 20000 } } } })).toBe('ours')
    expect(describeMcpEntry({ mcp: { servers: { agentchat: { ...hostedMcpServerEntry(), enabled: false } } } })).toBe('disabled')
    expect(describeMcpEntry({ mcp: { servers: { agentchat: { url: 'https://proxy/mcp', transport: 'streamable-http' } } } })).toBe('user_managed')
    expect(describeMcpEntry({ mcp: { servers: { agentchat: { ...hostedMcpServerEntry(), headers: { Authorization: `Bearer ${testKey('literal')}` } } } } })).toBe('user_managed')
  })

  it('recognises our entry after OpenClaw substituted the template (the config a plugin sees carries the key)', () => {
    const key = testKey('m'.repeat(24))
    const substituted = { mcp: { servers: { agentchat: { url: 'https://api.agentchat.me/mcp', transport: 'streamable-http', headers: { Authorization: `Bearer ${key}` } } } } }
    expect(describeMcpEntry(substituted, 'https://api.agentchat.me', key)).toBe('ours')
    // without the configured key to compare against, a literal bearer is the user's
    expect(describeMcpEntry(substituted)).toBe('user_managed')
    // a different key is somebody else's credential
    expect(describeMcpEntry(substituted, 'https://api.agentchat.me', testKey('z'.repeat(24)))).toBe('user_managed')
    // no headers at all: ours by URL + transport
    expect(describeMcpEntry({ mcp: { servers: { agentchat: { url: 'https://api.agentchat.me/mcp', transport: 'streamable-http' } } } })).toBe('ours')
    // wrong transport: not ours
    expect(describeMcpEntry({ mcp: { servers: { agentchat: { url: 'https://api.agentchat.me/mcp', transport: 'sse' } } } })).toBe('user_managed')
    // and channels remove strips the substituted entry
    expect(withoutHostedMcpEntry(substituted, 'https://api.agentchat.me', key).removed).toBe(true)
    expect(withHostedMcpEntry(substituted, 'https://api.agentchat.me', key).outcome).toBe('present')
  })

  it('adds the entry when missing and never modifies a hand-written one', () => {
    const added = withHostedMcpEntry({ channels: {} })
    expect(added.outcome).toBe('added')
    expect(describeMcpEntry(added.cfg)).toBe('ours')
    expect(withHostedMcpEntry(added.cfg).outcome).toBe('present')

    const hand = { mcp: { servers: { agentchat: { url: 'https://proxy/mcp', transport: 'streamable-http' } } } }
    const kept = withHostedMcpEntry(hand)
    expect(kept.outcome).toBe('user_managed')
    expect(kept.cfg).toBe(hand)

    const disabled = { mcp: { servers: { agentchat: { ...hostedMcpServerEntry(), enabled: false } } } }
    expect(withHostedMcpEntry(disabled).outcome).toBe('disabled')
  })

  it('removes only our entry', () => {
    const ours = withHostedMcpEntry({ mcp: { servers: { other: { url: 'https://x/mcp' } } } }).cfg
    const removed = withoutHostedMcpEntry(ours)
    expect(removed.removed).toBe(true)
    expect((removed.cfg as { mcp: { servers: Record<string, unknown> } }).mcp.servers).toEqual({ other: { url: 'https://x/mcp' } })
    const hand = { mcp: { servers: { agentchat: { url: 'https://proxy/mcp' } } } }
    expect(withoutHostedMcpEntry(hand).removed).toBe(false)
  })
})

describe('probeHostedMcp — the kit probe with the plugin identity', () => {
  const initResult = { protocolVersion: '2025-06-18', serverInfo: { name: 'agentchat', version: '0.1.1' }, capabilities: {} }
  const toolsResult = { tools: [{ name: 'agentchat_inbox' }, { name: 'agentchat_decide' }, { name: 'agentchat_send_message' }] }
  const key = ['ac', 'k'.repeat(24)].join('_')

  function server(answers: { tools?: unknown; status?: number; sse?: boolean } = {}) {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} })
      if (answers.status) return new Response('', { status: answers.status })
      const body = JSON.parse(String(init?.body)) as { id: number; method: string }
      const result = body.method === 'initialize' ? initResult : (answers.tools ?? toolsResult)
      const json = JSON.stringify({ jsonrpc: '2.0', id: body.id, result })
      return answers.sse
        ? new Response(`event: message\ndata: ${json}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        : new Response(json, { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' } })
    }) as typeof fetch
    return { seen, fetchImpl }
  }

  it('initialize then tools/list with the bearer key and the OpenClaw identity; ok when the tools a turn needs are listed', async () => {
    const { seen, fetchImpl } = server()
    const result = await probeHostedMcp({ apiKey: key, fetch: fetchImpl })
    expect(seen.map((s) => JSON.parse(String(s.init.body)).method)).toEqual(['initialize', 'tools/list'])
    expect(seen[0]!.url).toBe('https://api.agentchat.me/mcp')
    const headers = seen[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${key}`)
    expect(headers['X-AgentChat-Client'] ?? headers['x-agentchat-client']).toBe('openclaw')
    expect(result).toMatchObject({ ok: true, status: 200, serverName: 'agentchat', serverVersion: '0.1.1', protocolVersion: '2025-06-18' })
    expect(result.tools).toContain('agentchat_inbox')
  })

  it('reads SSE-framed answers too', async () => {
    const { fetchImpl } = server({ sse: true })
    const result = await probeHostedMcp({ apiKey: 'k', fetch: fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.serverName).toBe('agentchat')
  })

  it('a list without the tools a turn needs is not ok, and says which', async () => {
    const { fetchImpl } = server({ tools: { tools: [{ name: 'agentchat_send_message' }] } })
    const result = await probeHostedMcp({ apiKey: 'k', fetch: fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['agentchat_inbox', 'agentchat_decide'])
    expect(result.error).toMatch(/agentchat_inbox/)
  })

  it('reports 401 as a key that does not authenticate', async () => {
    const { fetchImpl } = server({ status: 401 })
    const result = await probeHostedMcp({ apiKey: 'bad', fetch: fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error).toMatch(/does not authenticate/)
  })

  it('reports a transport failure', async () => {
    const result = await probeHostedMcp({
      apiKey: 'k',
      fetch: (async () => {
        throw new Error('ENOTFOUND')
      }) as typeof fetch,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/ENOTFOUND/)
  })
})
