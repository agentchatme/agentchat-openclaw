/**
 * The gateway adapter: what `startAccount` does before any socket opens.
 *
 *   - more than one configured account → the doorbell refuses to start (one
 *     error line, status says so), nothing is registered;
 *   - AGENTCHAT_DOORBELL=off → nothing is registered, status says so;
 *   - otherwise one doorbell is registered for the account.
 *
 * The registry is mocked; the abort signal is pre-aborted so `startAccount`
 * returns at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/binding/runtime-registry.js', () => ({
  registerDoorbell: vi.fn(async () => ({})),
  unregisterDoorbell: vi.fn(async () => undefined),
  getDoorbell: vi.fn(() => undefined),
}))

import { agentchatGatewayAdapter, waitUntilAbort } from '../../src/binding/gateway.js'
import { registerDoorbell } from '../../src/binding/runtime-registry.js'

const KEY = 'ac_live_' + 'g'.repeat(24)

function config() {
  return {
    apiKey: KEY,
    apiBase: 'https://api.agentchat.me',
    agentHandle: 'alice',
    reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0.2 },
    ping: { intervalMs: 45000, timeoutMs: 30000 },
    outbound: { maxInFlight: 256, sendTimeoutMs: 15000 },
    observability: { logLevel: 'info' as const, redactKeys: [] },
  }
}

function ctxFor(cfg: object, accountId = 'default') {
  const aborted = new AbortController()
  aborted.abort()
  let status: Record<string, unknown> = { accountId }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return {
    ctx: {
      cfg,
      accountId,
      account: { accountId, enabled: true, configured: true, parseError: null, config: config() },
      runtime: {},
      abortSignal: aborted.signal,
      log,
      getStatus: () => status,
      setStatus: (next: Record<string, unknown>) => {
        status = next
      },
      channelRuntime: undefined,
    },
    log,
    status: () => status,
  }
}

describe('gateway.startAccount', () => {
  const savedMode = process.env.AGENTCHAT_DOORBELL
  beforeEach(() => {
    vi.mocked(registerDoorbell).mockClear()
    delete process.env.AGENTCHAT_DOORBELL
  })
  afterEach(() => {
    if (savedMode === undefined) delete process.env.AGENTCHAT_DOORBELL
    else process.env.AGENTCHAT_DOORBELL = savedMode
  })

  it('refuses to start when more than one account is configured: one error line, status not running, nothing registered', async () => {
    const cfg = { channels: { agentchat: { accounts: { a: { apiKey: KEY }, b: { apiKey: KEY } } } } }
    const { ctx, log, status } = ctxFor(cfg, 'a')
    await agentchatGatewayAdapter.startAccount!(ctx as never)
    expect(registerDoorbell).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(String(log.error.mock.calls[0]![0])).toMatch(/doorbell not started — 2 AgentChat accounts are configured \(a, b\); this release runs one account per gateway/)
    expect(status()).toMatchObject({ running: false, connected: false })
    expect((status().lastDisconnect as { error: string }).error).toMatch(/one account per gateway/)
  })

  it('AGENTCHAT_DOORBELL=off: no socket, no knocks, no turns; tools and manual stay placed', async () => {
    process.env.AGENTCHAT_DOORBELL = 'off'
    const { ctx, log, status } = ctxFor({ channels: { agentchat: { apiKey: KEY } } })
    await agentchatGatewayAdapter.startAccount!(ctx as never)
    expect(registerDoorbell).not.toHaveBeenCalled()
    expect(String(log.info.mock.calls[0]![0])).toMatch(/AGENTCHAT_DOORBELL=off/)
    expect(status()).toMatchObject({ running: false, connected: false, linked: true })
  })

  it('one configured account: registers one doorbell for it and never touches process.env', async () => {
    const before = process.env.AGENTCHAT_API_KEY
    delete process.env.AGENTCHAT_API_KEY
    try {
      const { ctx } = ctxFor({ channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } })
      await agentchatGatewayAdapter.startAccount!(ctx as never)
      expect(registerDoorbell).toHaveBeenCalledTimes(1)
      expect(vi.mocked(registerDoorbell).mock.calls[0]![0]).toMatchObject({ accountId: 'default' })
      expect(process.env.AGENTCHAT_API_KEY).toBeUndefined()
    } finally {
      if (before !== undefined) process.env.AGENTCHAT_API_KEY = before
    }
  })

  it('skips disabled and unconfigured accounts', async () => {
    const { ctx } = ctxFor({ channels: { agentchat: { apiKey: KEY } } })
    await agentchatGatewayAdapter.startAccount!({ ...ctx, account: { ...ctx.account, enabled: false } } as never)
    await agentchatGatewayAdapter.startAccount!({ ...ctx, account: { ...ctx.account, configured: false, config: null } } as never)
    expect(registerDoorbell).not.toHaveBeenCalled()
  })

  it('waitUntilAbort runs the cleanup before resolving', async () => {
    const controller = new AbortController()
    const order: string[] = []
    const waiting = waitUntilAbort(controller.signal, async () => {
      order.push('cleanup')
    }).then(() => order.push('resolved'))
    controller.abort()
    await waiting
    expect(order).toEqual(['cleanup', 'resolved'])
  })
})

describe('gateway.startAccount — lifecycle and the gate agent', () => {
  beforeEach(() => {
    vi.mocked(registerDoorbell).mockClear()
    delete process.env.AGENTCHAT_DOORBELL
  })

  it('reports lifecycle starting → (build) → ready/recovering/stopped through the status snapshot', async () => {
    const { ctx, status } = ctxFor({ channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } })
    const seen: unknown[] = []
    const original = ctx.setStatus
    ctx.setStatus = (next: Record<string, unknown>) => {
      seen.push(next.lifecycle)
      original(next)
    }
    await agentchatGatewayAdapter.startAccount!(ctx as never)
    expect(seen[0]).toBe('starting')
    const build = vi.mocked(registerDoorbell).mock.calls[0]![0].build
    const fakeRuntime = { getHealth: () => ({ state: { kind: 'READY' }, authenticated: true, ackNegotiated: true, counters: { frames: 0, selfFiltered: 0, knocks: 1, invites: 0 } }) }
    const built = build(fakeRuntime as never)
    built.handlers.onAuthenticated!(123)
    expect(status().lifecycle).toBe('ready')
    built.handlers.onStateChanged!({ kind: 'CONNECTING', attempt: 2, startedAt: 1 } as never, { kind: 'DISCONNECTED' } as never)
    expect(status().lifecycle).toBe('recovering')
    built.handlers.onStateChanged!({ kind: 'AUTH_FAIL', reason: 'x' } as never, { kind: 'CONNECTING' } as never)
    expect(status().lifecycle).toBe('blocked')
    built.handlers.onStateChanged!({ kind: 'CLOSED' } as never, { kind: 'DRAINING' } as never)
    expect(status().lifecycle).toBe('stopped')
    built.invoker?.stop()
  })

  it('refusal and off report lifecycle blocked / stopped', async () => {
    const two = ctxFor({ channels: { agentchat: { accounts: { a: { apiKey: KEY }, b: { apiKey: KEY } } } } }, 'a')
    await agentchatGatewayAdapter.startAccount!(two.ctx as never)
    expect(two.status().lifecycle).toBe('blocked')
    process.env.AGENTCHAT_DOORBELL = 'off'
    const off = ctxFor({ channels: { agentchat: { apiKey: KEY } } })
    await agentchatGatewayAdapter.startAccount!(off.ctx as never)
    expect(off.status().lifecycle).toBe('stopped')
  })

  it('warns when the account is bound to a non-default agent and the llm override opt-in is missing; silent otherwise', async () => {
    const bound = {
      channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } },
      agents: { entries: { main: { default: true }, ops: {} } },
      bindings: [{ agentId: 'ops', match: { channel: 'agentchat' } }],
    }
    const routed = { ctx: ctxFor(bound).ctx, log: null as unknown as ReturnType<typeof ctxFor>['log'] }
    const h = ctxFor(bound)
    h.ctx.channelRuntime = { routing: { resolveAgentRoute: () => ({ agentId: 'ops', sessionKey: 'agent:ops:agentchat:direct:doorbell' }) } } as never
    await agentchatGatewayAdapter.startAccount!(h.ctx as never)
    expect(h.log.warn.mock.calls.some((c) => String(c[0]).includes('plugins.entries.agentchat.llm.allowAgentIdOverride'))).toBe(true)
    void routed

    const optedIn = ctxFor({ ...bound, plugins: { entries: { agentchat: { llm: { allowAgentIdOverride: true } } } } })
    optedIn.ctx.channelRuntime = h.ctx.channelRuntime
    await agentchatGatewayAdapter.startAccount!(optedIn.ctx as never)
    expect(optedIn.log.warn.mock.calls.some((c) => String(c[0]).includes('allowAgentIdOverride'))).toBe(false)

    const plain = ctxFor({ channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } })
    await agentchatGatewayAdapter.startAccount!(plain.ctx as never)
    expect(plain.log.warn.mock.calls.length).toBe(0)
  })
})
