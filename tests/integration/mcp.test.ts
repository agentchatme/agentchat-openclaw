import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  hostedMcpUrl,
  hostedMcpServerEntry,
  hostedMcpSnippet,
  describeMcpEntry,
  describeMcpIdentity,
  withHostedMcpEntry,
  withoutHostedMcpEntry,
  upgradeHostedMcpEntryInPlace,
  refreshHostedMcpEntry,
  probeHostedMcp,
  AUTH_HEADER_TEMPLATE,
  CLIENT_HEADER,
  CLIENT_VERSION_HEADER,
} from '../../src/integration/mcp.js'
import { PACKAGE_VERSION } from '../../src/version.js'
import { testKey } from '../helpers/keys.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKAGE_JSON_VERSION = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
/** The entry 0.10.0 and earlier placed: the bearer template, no client headers. */
const OLD_ENTRY = { url: 'https://api.agentchat.me/mcp', transport: 'streamable-http', headers: { Authorization: 'Bearer ${AGENTCHAT_API_KEY}' } } as const

describe('hosted MCP entry', () => {
  it('is the hosted endpoint over streamable-http with a bearer TEMPLATE, never a key', () => {
    expect(hostedMcpUrl()).toBe('https://api.agentchat.me/mcp')
    expect(hostedMcpUrl('https://staging.agentchat.me/')).toBe('https://staging.agentchat.me/mcp')
    expect(hostedMcpServerEntry()).toEqual({
      url: 'https://api.agentchat.me/mcp',
      transport: 'streamable-http',
      headers: { Authorization: 'Bearer ${AGENTCHAT_API_KEY}', 'X-AgentChat-Client': 'openclaw', 'X-AgentChat-Client-Version': PACKAGE_VERSION },
    })
    expect(AUTH_HEADER_TEMPLATE).toBe('Bearer ${AGENTCHAT_API_KEY}')
    expect(hostedMcpSnippet()).toContain('transport: "streamable-http"')
    expect(hostedMcpSnippet()).toContain('Authorization: "Bearer ${AGENTCHAT_API_KEY}"')
    expect(hostedMcpSnippet()).toContain('"X-AgentChat-Client": "openclaw"')
    expect(hostedMcpSnippet()).toContain(`"X-AgentChat-Client-Version": "${PACKAGE_VERSION}"`)
  })

  it('names the client with the header names AgentChat reads, and the version header tracks the package version', () => {
    // apps/api-server lib/analytics/client-context.ts: x-agentchat-client / x-agentchat-client-version
    expect(CLIENT_HEADER.toLowerCase()).toBe('x-agentchat-client')
    expect(CLIENT_VERSION_HEADER.toLowerCase()).toBe('x-agentchat-client-version')
    expect(PACKAGE_VERSION).toBe(PACKAGE_JSON_VERSION)
    expect(hostedMcpServerEntry().headers['X-AgentChat-Client-Version']).toBe(PACKAGE_JSON_VERSION)
    // the server keeps a version only when it is a short build identifier
    expect(PACKAGE_VERSION).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/)
  })

  it('the README shows the entry exactly as the plugin writes it', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain(hostedMcpSnippet())
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
    // brought up to date, the bearer goes back as the TEMPLATE — never the key the substituted config carries
    const updated = withHostedMcpEntry(substituted, 'https://api.agentchat.me', key)
    expect(updated.outcome).toBe('updated')
    expect(updated.cfg.mcp.servers.agentchat).toEqual(hostedMcpServerEntry())
    expect(JSON.stringify(updated.cfg)).not.toContain(key)
    // a current entry, substituted, is left as it is
    const current = { mcp: { servers: { agentchat: { ...hostedMcpServerEntry(), headers: { ...hostedMcpServerEntry().headers, Authorization: `Bearer ${key}` } } } } }
    expect(withHostedMcpEntry(current, 'https://api.agentchat.me', key)).toEqual({ cfg: current, outcome: 'present' })
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

  it('an entry an earlier release wrote (bearer only) is still ours, and is brought up to date keeping what the operator added', () => {
    expect(describeMcpEntry({ mcp: { servers: { agentchat: OLD_ENTRY } } })).toBe('ours')
    expect(describeMcpIdentity({ mcp: { servers: { agentchat: OLD_ENTRY } } })).toBe('missing')
    const cfg = { mcp: { servers: { agentchat: { ...OLD_ENTRY, requestTimeoutMs: 20000, toolFilter: { deny: ['agentchat_report_agent'] }, headers: { ...OLD_ENTRY.headers, 'X-Trace': 'on' } }, other: { url: 'https://x/mcp' } } } }
    const updated = withHostedMcpEntry(cfg)
    expect(updated.outcome).toBe('updated')
    expect(updated.cfg.mcp.servers.agentchat).toEqual({
      url: 'https://api.agentchat.me/mcp',
      transport: 'streamable-http',
      requestTimeoutMs: 20000,
      toolFilter: { deny: ['agentchat_report_agent'] },
      headers: { 'X-Trace': 'on', Authorization: 'Bearer ${AGENTCHAT_API_KEY}', 'X-AgentChat-Client': 'openclaw', 'X-AgentChat-Client-Version': PACKAGE_VERSION },
    })
    expect(updated.cfg.mcp.servers.other).toEqual({ url: 'https://x/mcp' })
    expect(cfg.mcp.servers.agentchat.headers).toEqual({ ...OLD_ENTRY.headers, 'X-Trace': 'on' }) // pure: the input is not touched
    expect(describeMcpIdentity(updated.cfg)).toBe('current')
    expect(withHostedMcpEntry(updated.cfg).outcome).toBe('present')
  })

  it('an older version in our entry is outdated and is updated; header names match without regard to case', () => {
    const older = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { authorization: 'Bearer ${AGENTCHAT_API_KEY}', 'x-agentchat-client': 'openclaw', 'x-agentchat-client-version': '0.10.0' } } } } }
    expect(describeMcpIdentity(older)).toBe('outdated')
    const updated = withHostedMcpEntry(older)
    expect(updated.outcome).toBe('updated')
    // one spelling of each header, not two
    expect(updated.cfg.mcp.servers.agentchat.headers).toEqual(hostedMcpServerEntry().headers)
    const sameVersionOtherCase = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { authorization: 'Bearer ${AGENTCHAT_API_KEY}', 'x-agentchat-client': 'OpenClaw', 'x-agentchat-client-version': PACKAGE_VERSION } } } } }
    expect(describeMcpIdentity(sameVersionOtherCase)).toBe('current')
    expect(withHostedMcpEntry(sameVersionOtherCase).outcome).toBe('present')
    // another client's name is no identity of ours
    expect(describeMcpIdentity({ mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { ...OLD_ENTRY.headers, 'X-AgentChat-Client': 'hermes' } } } } })).toBe('missing')
  })

  it('a bearer template the operator spelled differently is kept as written', () => {
    const custom = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { authorization: 'Bearer  ${AGENTCHAT_API_KEY}' } } } } }
    const updated = withHostedMcpEntry(custom)
    expect(updated.outcome).toBe('updated')
    expect(updated.cfg.mcp.servers.agentchat.headers).toEqual({ Authorization: 'Bearer  ${AGENTCHAT_API_KEY}', 'X-AgentChat-Client': 'openclaw', 'X-AgentChat-Client-Version': PACKAGE_VERSION })
  })

  it('an entry of ours without an Authorization header gets the client headers and no bearer it did not have', () => {
    const bare = { mcp: { servers: { agentchat: { url: 'https://api.agentchat.me/mcp', transport: 'streamable-http', headers: { 'x-api-key': '${AGENTCHAT_API_KEY}' } } } } }
    const updated = withHostedMcpEntry(bare)
    expect(updated.outcome).toBe('updated')
    expect(updated.cfg.mcp.servers.agentchat.headers).toEqual({ 'x-api-key': '${AGENTCHAT_API_KEY}', 'X-AgentChat-Client': 'openclaw', 'X-AgentChat-Client-Version': PACKAGE_VERSION })
  })

  it('a hand-written or disabled entry is never touched, with or without the client headers', () => {
    const hand = { mcp: { servers: { agentchat: { url: 'https://proxy/mcp', transport: 'streamable-http', headers: { Authorization: 'Bearer ${AGENTCHAT_API_KEY}' } } } } }
    expect(withHostedMcpEntry(hand)).toEqual({ cfg: hand, outcome: 'user_managed' })
    expect(upgradeHostedMcpEntryInPlace(hand)).toBe(false)
    expect(hand.mcp.servers.agentchat.headers).toEqual({ Authorization: 'Bearer ${AGENTCHAT_API_KEY}' })
    const literal = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { Authorization: `Bearer ${testKey('literal')}` } } } } }
    expect(withHostedMcpEntry(literal).outcome).toBe('user_managed')
    const disabled = { mcp: { servers: { agentchat: { ...OLD_ENTRY, enabled: false } } } }
    expect(withHostedMcpEntry(disabled)).toEqual({ cfg: disabled, outcome: 'disabled' })
    expect(upgradeHostedMcpEntryInPlace(disabled)).toBe(false)
  })

  it('upgrades a draft in place only when our entry is out of date, and never adds a missing one', () => {
    const draft = { mcp: { servers: { agentchat: { ...OLD_ENTRY } } } }
    expect(upgradeHostedMcpEntryInPlace(draft)).toBe(true)
    expect(draft.mcp.servers.agentchat).toEqual(hostedMcpServerEntry())
    expect(upgradeHostedMcpEntryInPlace(draft)).toBe(false)
    const empty: { mcp?: unknown } = {}
    expect(upgradeHostedMcpEntryInPlace(empty)).toBe(false)
    expect(empty).toEqual({})
  })

  describe('refreshHostedMcpEntry — the gateway start', () => {
    function mutator(file: object, fail?: Error) {
      const calls: Array<{ afterWrite: unknown }> = []
      return {
        calls,
        config: {
          mutateConfigFile: async (params: { afterWrite: unknown; mutate: (draft: never) => unknown }) => {
            calls.push({ afterWrite: params.afterWrite })
            if (fail) throw fail
            const draft = structuredClone(file)
            await params.mutate(draft as never)
            Object.assign(file, draft)
            return { result: undefined }
          },
        },
      }
    }

    it('writes once, through mutateConfigFile with afterWrite auto, when our entry is out of date', async () => {
      const file = { mcp: { servers: { agentchat: { ...OLD_ENTRY } } } }
      const { calls, config } = mutator(file)
      expect(await refreshHostedMcpEntry({ liveCfg: structuredClone(file), config })).toEqual({ outcome: 'updated' })
      expect(calls).toEqual([{ afterWrite: { mode: 'auto' } }])
      expect(file.mcp.servers.agentchat).toEqual(hostedMcpServerEntry())
      // the next start finds it current and writes nothing
      expect(await refreshHostedMcpEntry({ liveCfg: structuredClone(file), config })).toEqual({ outcome: 'current' })
      expect(calls).toHaveLength(1)
    })

    it('reads the substituted live config with the key, and writes the template into the file', async () => {
      const key = testKey('s'.repeat(24))
      const file = { mcp: { servers: { agentchat: { ...OLD_ENTRY } } } }
      const live = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { Authorization: `Bearer ${key}` } } } } }
      const { config } = mutator(file)
      expect(await refreshHostedMcpEntry({ liveCfg: live, config, apiKey: key })).toEqual({ outcome: 'updated' })
      expect(JSON.stringify(file)).not.toContain(key)
      expect(file.mcp.servers.agentchat.headers.Authorization).toBe('Bearer ${AGENTCHAT_API_KEY}')
    })

    it('writes nothing for a missing, hand-written or disabled entry', async () => {
      for (const liveCfg of [{}, { mcp: { servers: { agentchat: { url: 'https://proxy/mcp', transport: 'streamable-http' } } } }, { mcp: { servers: { agentchat: { ...OLD_ENTRY, enabled: false } } } }]) {
        const { calls, config } = mutator(structuredClone(liveCfg))
        expect(await refreshHostedMcpEntry({ liveCfg, config })).toEqual({ outcome: 'not_ours' })
        expect(calls).toHaveLength(0)
      }
    })

    it('leaves an entry the operator took over since the live read alone', async () => {
      const file = { mcp: { servers: { agentchat: { url: 'https://proxy/mcp', transport: 'streamable-http' } } } }
      const { calls, config } = mutator(file)
      expect(await refreshHostedMcpEntry({ liveCfg: { mcp: { servers: { agentchat: { ...OLD_ENTRY } } } }, config })).toEqual({ outcome: 'not_ours' })
      expect(calls).toHaveLength(1)
      expect(file.mcp.servers.agentchat).toEqual({ url: 'https://proxy/mcp', transport: 'streamable-http' })
    })

    it('says so when the runtime cannot write config, or the write fails — and never throws', async () => {
      const liveCfg = { mcp: { servers: { agentchat: { ...OLD_ENTRY } } } }
      expect(await refreshHostedMcpEntry({ liveCfg, config: undefined })).toEqual({ outcome: 'unsupported' })
      expect(await refreshHostedMcpEntry({ liveCfg, config: {} })).toEqual({ outcome: 'unsupported' })
      const { config } = mutator(structuredClone(liveCfg), new Error('config is read-only (Nix mode)'))
      expect(await refreshHostedMcpEntry({ liveCfg, config })).toEqual({ outcome: 'failed', error: 'config is read-only (Nix mode)' })
    })
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
