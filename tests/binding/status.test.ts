import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../src/binding/sdk-client.js', () => ({
  getClient: () => ({
    getMe: async () => ({ handle: 'alice', status: 'active', paused_by_owner: 'none' }),
  }),
}))
vi.mock('../../src/doorbell/mcp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/doorbell/mcp.js')>()
  return { ...actual, probeHostedMcp: vi.fn(async () => ({ ok: true, status: 200, serverName: 'agentchat', serverVersion: '1' })) }
})

import { agentchatStatusAdapter } from '../../src/binding/status.js'
import { placeDoorbell } from '../../src/doorbell/placement.js'
import { probeHostedMcp } from '../../src/doorbell/mcp.js'
import { registerDoorbell, resetRegistryForTest } from '../../src/binding/runtime-registry.js'
import type { AgentchatChannelRuntime } from '../../src/runtime.js'

const KEY = 'ac_live_' + 's'.repeat(24)

function account(cfg: object) {
  return {
    accountId: 'default',
    enabled: true,
    configured: true,
    parseError: null,
    config: {
      apiKey: KEY,
      apiBase: 'https://api.agentchat.me',
      agentHandle: 'alice',
      reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0.2 },
      ping: { intervalMs: 45000, timeoutMs: 30000 },
      outbound: { maxInFlight: 256, sendTimeoutMs: 15000 },
      observability: { logLevel: 'info' as const, redactKeys: [] },
    },
    cfg,
  }
}

describe('status adapter — the doctor-style probe', () => {
  let workspace: string
  const savedEnv = process.env.AGENTCHAT_API_KEY
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-status-'))
    delete process.env.AGENTCHAT_API_KEY
  })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
    if (savedEnv === undefined) delete process.env.AGENTCHAT_API_KEY
    else process.env.AGENTCHAT_API_KEY = savedEnv
  })

  it('reports key, hosted MCP reachability and placement; not ok until everything is placed', async () => {
    const cfg = { agents: { defaults: { workspace } } }
    const a = account(cfg)
    const probe = await agentchatStatusAdapter.probeAccount!({ account: a as never, timeoutMs: 2000, cfg: cfg as never } as never)
    expect(probe.handle).toBe('alice')
    expect(probe.mcp?.ok).toBe(true)
    expect(probe.ok).toBe(false) // placement incomplete
    expect(probe.placement?.find((c) => c.name === 'mcp')?.ok).toBe(false)
    const lines = agentchatStatusAdapter.formatCapabilitiesProbe!({ probe } as never)
    expect(lines[0]).toEqual({ text: 'authenticated as @alice', tone: 'success' })
    expect(lines.some((l) => l.text.startsWith('hosted MCP server reachable'))).toBe(true)
    expect(lines.some((l) => l.text.includes('doorbell not running in this process'))).toBe(true)
  })

  it('is ok once placed with the key in the environment', async () => {
    const placed = placeDoorbell({ cfg: { agents: { defaults: { workspace } } }, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir: process.env.OPENCLAW_STATE_DIR })
    process.env.AGENTCHAT_API_KEY = KEY
    const probe = await agentchatStatusAdapter.probeAccount!({ account: account(placed.cfg) as never, timeoutMs: 2000, cfg: placed.cfg as never } as never)
    expect(probe.ok).toBe(true)
    expect(probe.placement?.every((c) => c.ok)).toBe(true)
  })

  it('an unreachable hosted MCP server is an error line', async () => {
    vi.mocked(probeHostedMcp).mockResolvedValueOnce({ ok: false, status: 401, error: 'the key does not authenticate against the hosted MCP server' })
    const cfg = { agents: { defaults: { workspace } } }
    const probe = await agentchatStatusAdapter.probeAccount!({ account: account(cfg) as never, timeoutMs: 2000, cfg: cfg as never } as never)
    expect(probe.ok).toBe(false)
    const lines = agentchatStatusAdapter.formatCapabilitiesProbe!({ probe } as never)
    expect(lines.find((l) => l.text.startsWith('hosted MCP server not reachable'))?.tone).toBe('error')
  })

  it('refuses two accounts: not ok, one error line naming the limit', async () => {
    const cfg = { agents: { defaults: { workspace } }, channels: { agentchat: { accounts: { a: { apiKey: KEY }, b: { apiKey: KEY } } } } }
    const probe = await agentchatStatusAdapter.probeAccount!({ account: account(cfg) as never, timeoutMs: 2000, cfg: cfg as never } as never)
    expect(probe.ok).toBe(false)
    expect(probe.refusal).toMatch(/2 AgentChat accounts are configured \(a, b\); this release runs one account per gateway/)
    const lines = agentchatStatusAdapter.formatCapabilitiesProbe!({ probe } as never)
    expect(lines.find((l) => l.text.startsWith('doorbell not started —'))?.tone).toBe('error')
  })

  it('a legacy server (no ack negotiated) is an error line: envelopes are marked delivered on push', async () => {
    await resetRegistryForTest()
    const stub = {
      start() {},
      async stop() {},
      getHealth: () => ({ state: { kind: 'READY' }, authenticated: true, ackNegotiated: false, counters: { frames: 0, selfFiltered: 0, knocks: 1, invites: 0 } }),
    }
    await registerDoorbell({
      accountId: 'default',
      config: account({}).config as never,
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as never,
      createRuntime: () => stub as unknown as AgentchatChannelRuntime,
      build: () => ({ invoker: null, handlers: {} }),
    })
    try {
      const placed = placeDoorbell({ cfg: { agents: { defaults: { workspace } } }, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir: process.env.OPENCLAW_STATE_DIR })
      process.env.AGENTCHAT_API_KEY = KEY
      const probe = await agentchatStatusAdapter.probeAccount!({ account: account(placed.cfg) as never, timeoutMs: 2000, cfg: placed.cfg as never } as never)
      expect(probe.doorbell?.ackNegotiated).toBe(false)
      expect(probe.ok).toBe(false)
      const lines = agentchatStatusAdapter.formatCapabilitiesProbe!({ probe } as never)
      const legacy = lines.find((l) => l.text.startsWith('server did not negotiate the ack capability'))
      expect(legacy?.tone).toBe('error')
    } finally {
      await resetRegistryForTest()
    }
  })

  it('a disabled account: not ok, and the capabilities lines name `config set … enabled true`, never channels add', async () => {
    const cfg = { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY, agentHandle: 'alice', enabled: false } } }
    const a = { ...account(cfg), enabled: false }
    const probe = await agentchatStatusAdapter.probeAccount!({ account: a as never, timeoutMs: 2000, cfg: cfg as never } as never)
    expect(probe.ok).toBe(false)
    expect(probe.disabled).toMatch(/^the account is disabled — re-enable it with `openclaw config set channels\.agentchat\.enabled true`, then run `openclaw doctor --fix`/)
    const lines = agentchatStatusAdapter.formatCapabilitiesProbe!({ probe } as never)
    expect(lines[1]).toEqual({ text: probe.disabled, tone: 'warn' })
    const anchor = lines.find((l) => l.text.startsWith('anchor:'))!
    expect(anchor.text).toContain('`openclaw config set channels.agentchat.enabled true`')
    expect(lines.some((l) => /run openclaw channels add/.test(l.text))).toBe(false)
  })

  it('an enabled account carries no disabled line', async () => {
    const cfg = { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } }
    const probe = await agentchatStatusAdapter.probeAccount!({ account: account(cfg) as never, timeoutMs: 2000, cfg: cfg as never } as never)
    expect(probe.disabled).toBeUndefined()
    expect(probe.placement?.find((c) => c.name === 'anchor')?.detail).toMatch(/run openclaw doctor --fix/)
  })

  it('resolveAccountState', () => {
    expect(agentchatStatusAdapter.resolveAccountState!({ account: { configured: true }, configured: true, enabled: true } as never)).toBe('linked')
    expect(agentchatStatusAdapter.resolveAccountState!({ account: {}, configured: false, enabled: true } as never)).toBe('not configured')
    expect(agentchatStatusAdapter.resolveAccountState!({ account: {}, configured: true, enabled: false } as never)).toBe('disabled')
  })
})
