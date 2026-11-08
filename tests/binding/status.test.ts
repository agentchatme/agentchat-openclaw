import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../src/binding/sdk-client.js', () => ({
  getClient: () => ({
    getMe: async () => ({ handle: 'alice', status: 'active', paused_by_owner: 'none' }),
  }),
  createSdkClient: () => ({}),
}))
vi.mock('../../src/integration/mcp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integration/mcp.js')>()
  return { ...actual, probeHostedMcp: vi.fn(async () => ({ ok: true, status: 200, serverName: 'agentchat', serverVersion: '1' })) }
})

import { agentchatStatusAdapter } from '../../src/binding/status.js'
import { placeIntegration } from '../../src/integration/placement.js'
import { probeHostedMcp } from '../../src/integration/mcp.js'
import { registerIntegration, resetRegistryForTest } from '../../src/binding/runtime-registry.js'
import { createInMemoryMetrics } from '../../src/metrics.js'
import type { IntegrationSocket, SocketState } from '../../src/integration/socket.js'
import { IDENTITY_LINE } from '../helpers/texts.js'
import { testKey } from '../helpers/keys.js'

const KEY = testKey('s'.repeat(24))

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

function stubSocket(state: SocketState): IntegrationSocket {
  return {
    realtime: { disconnect() {} },
    bind() {},
    stopped() {},
    getHealth: () => ({ state, connectedAt: null, counters: { wakeFrames: 0, disconnects: 0 } }),
  } as unknown as IntegrationSocket
}

const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as never

/** A receive loop as the status probe reads it: its `status()` counters. */
function loopWith(c: { wakes: number; cycles: number; turns: number; running?: Array<Record<string, unknown>> }): never {
  return {
    loop: {
      start: async () => undefined,
      status: () => ({ coalescer: { wakes: c.wakes, cycles: c.cycles }, counters: { turnsStarted: c.turns, inviteTurnsStarted: 0, runsStarted: 0 }, turns: c.running ?? [] }),
    },
    stop: async () => undefined,
  } as never
}

describe('status adapter — the doctor-style probe', () => {
  let workspace: string
  const savedEnv = process.env.AGENTCHAT_API_KEY
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-status-'))
    delete process.env.AGENTCHAT_API_KEY
    delete process.env.AGENTCHAT_WAKE
  })
  afterEach(async () => {
    fs.rmSync(workspace, { recursive: true, force: true })
    if (savedEnv === undefined) delete process.env.AGENTCHAT_API_KEY
    else process.env.AGENTCHAT_API_KEY = savedEnv
    await resetRegistryForTest()
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
    expect(lines.some((l) => l.text.includes('integration not running in this process'))).toBe(true)
  })

  it('is ok once placed with the key in the environment', async () => {
    const placed = placeIntegration({ cfg: { agents: { defaults: { workspace } } }, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: IDENTITY_LINE, stateDir: process.env.OPENCLAW_STATE_DIR })
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
    expect(lines.find((l) => l.text.startsWith('integration not started —'))?.tone).toBe('error')
  })

  it('a running integration reports the socket state, the counters and where the texts came from', async () => {
    await registerIntegration({
      accountId: 'default',
      config: account({}).config as never,
      logger: silent,
      createSocket: () => stubSocket('ready'),
      build: () => ({ loop: loopWith({ wakes: 3, cycles: 2, turns: 1 }), texts: { source: 'cache' } as never, handlers: {} }),
    })
    const cfg = { agents: { defaults: { workspace } } }
    const probe = await agentchatStatusAdapter.probeAccount!({ account: account(cfg) as never, timeoutMs: 2000, cfg: cfg as never } as never)
    expect(probe.integration).toEqual({ mode: 'on', state: 'ready', wakes: 3, cycles: 2, turns: 1, texts: 'cache' })
    const lines = agentchatStatusAdapter.formatCapabilitiesProbe!({ probe } as never)
    expect(lines.find((l) => l.text.startsWith('integration ready'))).toEqual({ text: 'integration ready — wakes 3, cycles 2, turns 1', tone: 'success' })
    expect(lines.find((l) => l.text.startsWith('served texts from the cached copy'))?.tone).toBe('warn')
  })

  it('a turn running past 30 minutes is a warn line naming the conversation and the run deadline that ends it (the card stays held)', async () => {
    const started = Date.now() - 45 * 60_000
    await registerIntegration({
      accountId: 'default',
      config: account({}).config as never,
      logger: silent,
      createSocket: () => stubSocket('ready'),
      build: () => ({
        loop: loopWith({ wakes: 1, cycles: 1, turns: 1, running: [{ kind: 'reply', conversationId: 'conv_slow', anchor: 'msg_1', startedAt: started, waitTimedOutAt: null, overdue: true }] }),
        texts: { source: 'server' } as never,
        handlers: {},
      }),
    })
    const cfg = { agents: { defaults: { workspace, timeoutSeconds: 7200 } } }
    const probe = await agentchatStatusAdapter.probeAccount!({ account: account(cfg) as never, timeoutMs: 2000, cfg: cfg as never } as never)
    expect(probe.integration?.overdue).toHaveLength(1)
    const lines = agentchatStatusAdapter.formatCapabilitiesProbe!({ probe } as never)
    const line = lines.find((l) => l.text.startsWith('a turn for conversation conv_slow'))
    expect(line?.tone).toBe('warn')
    expect(line?.text).toMatch(/has run 4[45] min — its card stays held \(no second reply\) until the run ends; OpenClaw ends it at its run deadline, agents\.defaults\.timeoutSeconds = 7200$/)
  })

  it('a running integration with the gateway recorder shows the socket counters: wakes by source, closes by code/initiator, notices by class', async () => {
    const metrics = createInMemoryMetrics()
    metrics.setConnectionState('ready')
    metrics.incWake({ source: 'connect' })
    metrics.incWake({ source: 'message' })
    metrics.incWake({ source: 'message' })
    metrics.incDisconnect({ code: '4000', initiator: 'client' })
    metrics.incError({ errorClass: 'transport' })
    await registerIntegration({
      accountId: 'default',
      config: account({}).config as never,
      logger: silent,
      createSocket: () => stubSocket('ready'),
      socketOptions: { metrics },
      build: () => ({ loop: loopWith({ wakes: 3, cycles: 1, turns: 0 }), texts: { source: 'server' } as never, handlers: {} }),
    })
    const probe = await agentchatStatusAdapter.probeAccount!({ account: account({}) as never, timeoutMs: 2000, cfg: {} as never } as never)
    expect(probe.integration?.socket).toEqual({ state: 'ready', wakes: { connect: 1, message: 2 }, disconnects: { '4000/client': 1 }, errors: { transport: 1 } })
    const lines = agentchatStatusAdapter.formatCapabilitiesProbe!({ probe } as never)
    expect(lines.find((l) => l.text.startsWith('socket — '))).toEqual({
      text: 'socket — wakes: connect 1, message 2 · closes: 4000/client 1 · notices: transport 1',
      tone: 'muted',
    })
  })

  it('a blocked integration without texts is a warn line and an error line', async () => {
    await registerIntegration({
      accountId: 'default',
      config: account({}).config as never,
      logger: silent,
      createSocket: () => stubSocket('blocked'),
      build: () => ({ loop: null, texts: { source: 'none' } as never, handlers: {} }),
    })
    const probe = await agentchatStatusAdapter.probeAccount!({ account: account({}) as never, timeoutMs: 2000, cfg: {} as never } as never)
    expect(probe.integration).toEqual({ mode: 'on', state: 'blocked', texts: 'missing' })
    const lines = agentchatStatusAdapter.formatCapabilitiesProbe!({ probe } as never)
    expect(lines.find((l) => l.text.startsWith('integration blocked'))?.tone).toBe('warn')
    expect(lines.find((l) => l.text.startsWith('served texts not available yet'))?.tone).toBe('error')
  })

  it('AGENTCHAT_WAKE=off is a warn line', async () => {
    process.env.AGENTCHAT_WAKE = 'off'
    const probe = await agentchatStatusAdapter.probeAccount!({ account: account({}) as never, timeoutMs: 2000, cfg: {} as never } as never)
    expect(probe.integration?.mode).toBe('off')
    const lines = agentchatStatusAdapter.formatCapabilitiesProbe!({ probe } as never)
    expect(lines.find((l) => l.text.startsWith('integration off'))?.tone).toBe('warn')
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
