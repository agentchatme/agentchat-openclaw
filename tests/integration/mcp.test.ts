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
      headers: { Authorization: 'Bearer ${AGENTCHAT_API_KEY}', 'X-AgentChat-Client': 'openclaw' },
    })
    expect(AUTH_HEADER_TEMPLATE).toBe('Bearer ${AGENTCHAT_API_KEY}')
    expect(hostedMcpSnippet()).toContain('transport: "streamable-http"')
    expect(hostedMcpSnippet()).toContain('Authorization: "Bearer ${AGENTCHAT_API_KEY}"')
    expect(hostedMcpSnippet()).toContain('"X-AgentChat-Client": "openclaw"')
    expect(hostedMcpSnippet()).not.toContain('Version')
  })

  it('names the client with the header AgentChat reads, and is the same entry in every release (no version in it)', () => {
    // AgentChat reads this header (any case) to name the client
    expect(CLIENT_HEADER.toLowerCase()).toBe('x-agentchat-client')
    // static: nothing in the entry or the snippet depends on the package version, so an upgrade never rewrites it
    expect(JSON.stringify(hostedMcpServerEntry())).not.toContain(PACKAGE_VERSION)
    expect(hostedMcpSnippet()).not.toContain(PACKAGE_JSON_VERSION)
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
    // brought up to date, the bearer stays exactly as it was (OpenClaw restores the file's ${VAR} on an unchanged path)
    const updated = withHostedMcpEntry(substituted, 'https://api.agentchat.me', key)
    expect(updated.outcome).toBe('updated')
    expect(updated.cfg.mcp.servers.agentchat.headers).toEqual({ Authorization: `Bearer ${key}`, 'X-AgentChat-Client': 'openclaw' })
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
    const cfg = { mcp: { servers: { agentchat: { ...OLD_ENTRY, requestTimeoutMs: 20000, toolFilter: { exclude: ['agentchat_report_agent'] }, headers: { ...OLD_ENTRY.headers, 'X-Trace': 'on' } }, other: { url: 'https://x/mcp' } } } }
    const updated = withHostedMcpEntry(cfg)
    expect(updated.outcome).toBe('updated')
    expect(updated.cfg.mcp.servers.agentchat).toEqual({
      url: 'https://api.agentchat.me/mcp',
      transport: 'streamable-http',
      requestTimeoutMs: 20000,
      toolFilter: { exclude: ['agentchat_report_agent'] },
      headers: { 'X-Trace': 'on', Authorization: 'Bearer ${AGENTCHAT_API_KEY}', 'X-AgentChat-Client': 'openclaw' },
    })
    expect(updated.cfg.mcp.servers.other).toEqual({ url: 'https://x/mcp' })
    expect(cfg.mcp.servers.agentchat.headers).toEqual({ ...OLD_ENTRY.headers, 'X-Trace': 'on' }) // pure: the input is not touched
    expect(describeMcpIdentity(updated.cfg)).toBe('current')
    expect(withHostedMcpEntry(updated.cfg).outcome).toBe('present')
  })

  it('a version header in an entry is harmless: it is ours, current when it names the client, and never rewritten to drop it; names match in any case', () => {
    const withVersion = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { authorization: 'Bearer ${AGENTCHAT_API_KEY}', 'x-agentchat-client': 'OpenClaw', 'x-agentchat-client-version': '0.10.0' } } } } }
    expect(describeMcpEntry(withVersion)).toBe('ours')
    expect(describeMcpIdentity(withVersion)).toBe('current')
    expect(withHostedMcpEntry(withVersion)).toEqual({ cfg: withVersion, outcome: 'present' })
    expect(upgradeHostedMcpEntryInPlace(withVersion)).toBe(false)
    // without the client name it gains the header; the version header stays as it was
    const versionOnly = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { Authorization: 'Bearer ${AGENTCHAT_API_KEY}', 'X-AgentChat-Client-Version': '0.10.0' } } } } }
    expect(describeMcpIdentity(versionOnly)).toBe('missing')
    const updated = withHostedMcpEntry(versionOnly)
    expect(updated.outcome).toBe('updated')
    expect(updated.cfg.mcp.servers.agentchat.headers).toEqual({ Authorization: 'Bearer ${AGENTCHAT_API_KEY}', 'X-AgentChat-Client-Version': '0.10.0', 'X-AgentChat-Client': 'openclaw' })
    // another client's name is no identity of ours
    expect(describeMcpIdentity({ mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { ...OLD_ENTRY.headers, 'X-AgentChat-Client': 'hermes' } } } } })).toBe('missing')
  })

  it('the bearer is never rewritten: a literal key, or the configured key under another variable, is kept as it is', () => {
    const key = testKey('c'.repeat(24))
    // channels.agentchat.apiKey: "${MY_KEY}" with a hand-written `Bearer ${MY_KEY}`, as the plugin sees it: substituted
    const custom = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { Authorization: `Bearer ${key}` } } } } }
    const updated = withHostedMcpEntry(custom, 'https://api.agentchat.me', key)
    expect(updated.outcome).toBe('updated')
    expect(updated.cfg.mcp.servers.agentchat.headers.Authorization).toBe(`Bearer ${key}`)
    expect(updated.cfg.mcp.servers.agentchat.headers).not.toHaveProperty('authorization')
  })

  it('a second spelling of a header is not ours to guess: two Authorization headers are hand-written, two client headers name no client', () => {
    const twoBearers = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { Authorization: 'Bearer ${AGENTCHAT_API_KEY}', AUTHORIZATION: `Bearer ${testKey('o'.repeat(24))}` } } } } }
    expect(describeMcpEntry(twoBearers)).toBe('user_managed')
    expect(withHostedMcpEntry(twoBearers).outcome).toBe('user_managed')
    // an upper-case bearer with somebody else's key is read too, and is not ours
    const upper = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { AUTHORIZATION: `Bearer ${testKey('o'.repeat(24))}` } } } } }
    expect(describeMcpEntry(upper, 'https://api.agentchat.me', testKey('m'.repeat(24)))).toBe('user_managed')
    // "openclaw, openclaw" names no client the server knows
    const twoClients = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { ...hostedMcpServerEntry().headers, 'x-agentchat-client': 'openclaw' } } } } }
    expect(describeMcpIdentity(twoClients)).toBe('missing')
    const upgraded = withHostedMcpEntry(twoClients)
    expect(upgraded.outcome).toBe('updated')
    expect(upgraded.cfg.mcp.servers.agentchat.headers).toEqual(hostedMcpServerEntry().headers)
  })

  it('a bearer template the operator spelled differently is kept as written', () => {
    const custom = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { authorization: 'Bearer  ${AGENTCHAT_API_KEY}' } } } } }
    const updated = withHostedMcpEntry(custom)
    expect(updated.outcome).toBe('updated')
    expect(updated.cfg.mcp.servers.agentchat.headers).toEqual({ authorization: 'Bearer  ${AGENTCHAT_API_KEY}', 'X-AgentChat-Client': 'openclaw' })
  })

  it('an entry of ours without an Authorization header gets the client headers and no bearer it did not have', () => {
    const bare = { mcp: { servers: { agentchat: { url: 'https://api.agentchat.me/mcp', transport: 'streamable-http', headers: { 'x-api-key': '${AGENTCHAT_API_KEY}' } } } } }
    const updated = withHostedMcpEntry(bare)
    expect(updated.outcome).toBe('updated')
    expect(updated.cfg.mcp.servers.agentchat.headers).toEqual({ 'x-api-key': '${AGENTCHAT_API_KEY}', 'X-AgentChat-Client': 'openclaw' })
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
    /** OpenClaw's mutateConfigFile as it behaves: the callback edits a draft, and whatever it leaves is committed unless it throws. */
    function mutator(file: object, options: { fail?: Error; substitute?: (draft: object) => object } = {}) {
      const calls: Array<{ afterWrite: unknown }> = []
      const writes: object[] = []
      return {
        calls,
        writes,
        config: {
          mutateConfigFile: async (params: { afterWrite: unknown; mutate: (draft: never) => unknown }) => {
            calls.push({ afterWrite: params.afterWrite })
            if (options.fail) throw options.fail
            const draft = options.substitute ? options.substitute(structuredClone(file)) : structuredClone(file)
            await params.mutate(draft as never)
            writes.push(draft)
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

    it('a file already current (another process got there first) aborts the write instead of rewriting it', async () => {
      const file = { mcp: { servers: { agentchat: hostedMcpServerEntry() } } }
      const { calls, writes, config } = mutator(file)
      expect(await refreshHostedMcpEntry({ liveCfg: { mcp: { servers: { agentchat: { ...OLD_ENTRY } } } }, config })).toEqual({ outcome: 'current' })
      expect(calls).toHaveLength(1)
      expect(writes).toHaveLength(0)
    })

    it('works on a substituted draft (the key, not the template) when given the key, and leaves the bearer as it is', async () => {
      const key = testKey('s'.repeat(24))
      const live = { mcp: { servers: { agentchat: { ...OLD_ENTRY, headers: { Authorization: `Bearer ${key}` } } } } }
      const substitute = (draft: object) => JSON.parse(JSON.stringify(draft).split('${AGENTCHAT_API_KEY}').join(key)) as object
      const file = { mcp: { servers: { agentchat: { ...OLD_ENTRY } } } }
      const { writes, config } = mutator(file, { substitute })
      expect(await refreshHostedMcpEntry({ liveCfg: live, config, apiKey: key })).toEqual({ outcome: 'updated' })
      // the bearer path is unchanged, value for value — what OpenClaw needs to put the file's ${AGENTCHAT_API_KEY} back
      expect((writes[0] as typeof live).mcp.servers.agentchat.headers.Authorization).toBe(`Bearer ${key}`)
      // without the key, a substituted bearer is not recognisably ours: nothing is written
      const again = mutator({ mcp: { servers: { agentchat: { ...OLD_ENTRY } } } }, { substitute })
      expect(await refreshHostedMcpEntry({ liveCfg: { mcp: { servers: { agentchat: { ...OLD_ENTRY } } } }, config: again.config })).toEqual({ outcome: 'not_ours' })
      expect(again.writes).toHaveLength(0)
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
      const { calls, writes, config } = mutator(file)
      expect(await refreshHostedMcpEntry({ liveCfg: { mcp: { servers: { agentchat: { ...OLD_ENTRY } } } }, config })).toEqual({ outcome: 'not_ours' })
      expect(calls).toHaveLength(1)
      expect(writes).toHaveLength(0)
      expect(file.mcp.servers.agentchat).toEqual({ url: 'https://proxy/mcp', transport: 'streamable-http' })
    })

    it('says so when the runtime cannot write config, or the write fails — and never throws', async () => {
      const liveCfg = { mcp: { servers: { agentchat: { ...OLD_ENTRY } } } }
      expect(await refreshHostedMcpEntry({ liveCfg, config: undefined })).toEqual({ outcome: 'unsupported' })
      expect(await refreshHostedMcpEntry({ liveCfg, config: {} })).toEqual({ outcome: 'unsupported' })
      const { config } = mutator(structuredClone(liveCfg), { fail: new Error('disk full') })
      expect(await refreshHostedMcpEntry({ liveCfg, config })).toEqual({ outcome: 'failed', error: 'disk full' })
      const nix = Object.assign(new Error('config is immutable in Nix mode'), { code: 'OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE' })
      const readOnly = mutator(structuredClone(liveCfg), { fail: nix })
      expect(await refreshHostedMcpEntry({ liveCfg, config: readOnly.config })).toEqual({ outcome: 'failed', error: 'config is immutable in Nix mode', code: 'OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE' })
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
