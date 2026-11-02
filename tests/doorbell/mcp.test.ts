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
} from '../../src/doorbell/mcp.js'

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
    expect(describeMcpEntry({ mcp: { servers: { agentchat: { ...hostedMcpServerEntry(), headers: { Authorization: 'Bearer ac_live_literal' } } } } })).toBe('user_managed')
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

describe('probeHostedMcp', () => {
  const initResult = { protocolVersion: '2025-06-18', serverInfo: { name: 'agentchat', version: '0.1.1' }, instructions: 'Use agentchat_inbox first.', capabilities: {} }

  it('sends one MCP initialize with the bearer key and reads a JSON answer', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const result = await probeHostedMcp({
      apiKey: 'ac_live_' + 'k'.repeat(24),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(input), init: init ?? {} }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: initResult }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    })
    expect(seen!.url).toBe('https://api.agentchat.me/mcp')
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer ac_live_' + 'k'.repeat(24))
    expect(JSON.parse(seen!.init.body as string).method).toBe('initialize')
    expect(result).toEqual({ ok: true, status: 200, serverName: 'agentchat', serverVersion: '0.1.1', protocolVersion: '2025-06-18', hasInstructions: true })
  })

  it('reads an SSE-framed answer too', async () => {
    const result = await probeHostedMcp({
      apiKey: 'k',
      fetch: (async () => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: initResult })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch,
    })
    expect(result.ok).toBe(true)
    expect(result.serverName).toBe('agentchat')
  })

  it('reports 401 as a key that does not authenticate', async () => {
    const result = await probeHostedMcp({ apiKey: 'bad', fetch: (async () => new Response('', { status: 401 })) as typeof fetch })
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
