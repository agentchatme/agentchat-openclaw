/**
 * The gateway adapter: what `startAccount` does before any socket opens, and
 * how the SDK socket's events map onto OpenClaw's status snapshot.
 *
 *   - more than one configured account → the integration refuses to start
 *     (one error line, status says so), nothing is registered;
 *   - AGENTCHAT_WAKE=off (or the old AGENTCHAT_DOORBELL=off) → nothing is
 *     registered, status says so;
 *   - otherwise one integration is registered for the account, after the
 *     served texts were fetched;
 *   - a rejected key is ONE error line and ONE steady `blocked` status until
 *     a HELLO is accepted again, whatever the SDK reports meanwhile.
 *
 * The registry and the SDK client are mocked; the abort signal is
 * pre-aborted so `startAccount` returns at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../src/binding/runtime-registry.js', () => ({
  registerIntegration: vi.fn(async () => ({})),
  unregisterIntegration: vi.fn(async () => undefined),
  getIntegration: vi.fn(() => undefined),
}))

vi.mock('../../src/binding/sdk-client.js', async () => {
  const { SERVED_TEXTS } = await import('../helpers/texts.js')
  const client = {
    texts: { get: vi.fn(async () => SERVED_TEXTS) },
    listGroupInvites: vi.fn(async () => []),
    inbox: { tray: vi.fn() },
    decisions: { record: vi.fn() },
  }
  return { getClient: () => client, createSdkClient: () => client }
})

import { agentchatGatewayAdapter, statusStateFor, waitUntilAbort } from '../../src/binding/gateway.js'
import { registerIntegration } from '../../src/binding/runtime-registry.js'
import { writeAgentsAnchor } from '../../src/binding/agents-anchor.js'
import { IDENTITY_LINE } from '../helpers/texts.js'

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

const ENV_KEYS = ['AGENTCHAT_WAKE', 'AGENTCHAT_DOORBELL', 'AGENTCHAT_REPLY_GATE_FAIL_OPEN'] as const
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
  vi.mocked(registerIntegration).mockClear()
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('gateway.startAccount', () => {
  it('refuses to start when more than one account is configured: one error line, status not running, nothing registered', async () => {
    const cfg = { channels: { agentchat: { accounts: { a: { apiKey: KEY }, b: { apiKey: KEY } } } } }
    const { ctx, log, status } = ctxFor(cfg, 'a')
    await agentchatGatewayAdapter.startAccount!(ctx as never)
    expect(registerIntegration).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(String(log.error.mock.calls[0]![0])).toMatch(/integration not started — 2 AgentChat accounts are configured \(a, b\); this release runs one account per gateway/)
    expect(status()).toMatchObject({ running: false, connected: false, lifecycle: 'blocked' })
    expect((status().lastDisconnect as { error: string }).error).toMatch(/one account per gateway/)
  })

  it('AGENTCHAT_WAKE=off: no socket, no wakes, no turns; tools and manual stay placed', async () => {
    process.env.AGENTCHAT_WAKE = 'off'
    const { ctx, log, status } = ctxFor({ channels: { agentchat: { apiKey: KEY } } })
    await agentchatGatewayAdapter.startAccount!(ctx as never)
    expect(registerIntegration).not.toHaveBeenCalled()
    expect(String(log.info.mock.calls[0]![0])).toMatch(/AGENTCHAT_WAKE=off — no socket, no wakes, no turns/)
    expect(status()).toMatchObject({ running: false, connected: false, linked: true, lifecycle: 'stopped' })
  })

  it('the old spelling AGENTCHAT_DOORBELL=off still switches it off and names the new variable', async () => {
    process.env.AGENTCHAT_DOORBELL = 'off'
    const { ctx, log, status } = ctxFor({ channels: { agentchat: { apiKey: KEY } } })
    await agentchatGatewayAdapter.startAccount!(ctx as never)
    expect(registerIntegration).not.toHaveBeenCalled()
    expect(String(log.info.mock.calls[0]![0])).toMatch(/AGENTCHAT_DOORBELL=off .*AGENTCHAT_DOORBELL is the old spelling; AGENTCHAT_WAKE is the new one/)
    expect(status().lifecycle).toBe('stopped')
  })

  it('the new variable wins over the old one', async () => {
    process.env.AGENTCHAT_DOORBELL = 'off'
    process.env.AGENTCHAT_WAKE = 'on'
    const { ctx } = ctxFor({ channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } })
    await agentchatGatewayAdapter.startAccount!(ctx as never)
    expect(registerIntegration).toHaveBeenCalledTimes(1)
  })

  it('one configured account: fetches the texts, registers one integration for it and never touches process.env', async () => {
    const before = process.env.AGENTCHAT_API_KEY
    delete process.env.AGENTCHAT_API_KEY
    try {
      const { ctx, log } = ctxFor({ channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } })
      await agentchatGatewayAdapter.startAccount!(ctx as never)
      expect(registerIntegration).toHaveBeenCalledTimes(1)
      expect(vi.mocked(registerIntegration).mock.calls[0]![0]).toMatchObject({ accountId: 'default' })
      expect(process.env.AGENTCHAT_API_KEY).toBeUndefined()
      expect(log.error).not.toHaveBeenCalled()
      expect(log.warn).not.toHaveBeenCalled()
    } finally {
      if (before !== undefined) process.env.AGENTCHAT_API_KEY = before
    }
  })

  it('the first served copy refreshes a placed identity line that differs (an install upgraded from a release that bundled the line)', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-gateway-ws-'))
    try {
      const cfg = { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } }
      const bundled = 'I am @alice on AgentChat (api.agentchat.me). On any AgentChat wake I call agentchat_inbox first and decide per card.'
      writeAgentsAnchor({ cfg: cfg as never, handle: 'alice', text: bundled })
      const { ctx, log } = ctxFor(cfg)
      await agentchatGatewayAdapter.startAccount!(ctx as never)
      const content = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')
      expect(content).toContain(IDENTITY_LINE)
      expect(content).not.toContain(bundled)
      expect(log.info.mock.calls.some((c) => /identity line refreshed from the served texts/.test(String(c[0])))).toBe(true)
      // A second start with the same served copy leaves the file alone.
      const before = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')
      await agentchatGatewayAdapter.startAccount!(ctxFor(cfg).ctx as never)
      expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toBe(before)
      for (const call of vi.mocked(registerIntegration).mock.calls) {
        const built = call[0].build({} as never)
        built.texts?.stop()
        built.invoker?.stop()
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('AGENTCHAT_REPLY_GATE_FAIL_OPEN is no longer honoured: one warning, the integration still starts', async () => {
    process.env.AGENTCHAT_REPLY_GATE_FAIL_OPEN = '1'
    const { ctx, log } = ctxFor({ channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } })
    await agentchatGatewayAdapter.startAccount!(ctx as never)
    expect(registerIntegration).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/AGENTCHAT_REPLY_GATE_FAIL_OPEN is set but no longer honoured/)])
  })

  it('skips disabled and unconfigured accounts', async () => {
    const { ctx } = ctxFor({ channels: { agentchat: { apiKey: KEY } } })
    await agentchatGatewayAdapter.startAccount!({ ...ctx, account: { ...ctx.account, enabled: false } } as never)
    await agentchatGatewayAdapter.startAccount!({ ...ctx, account: { ...ctx.account, configured: false, config: null } } as never)
    expect(registerIntegration).not.toHaveBeenCalled()
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

  it("statusStateFor maps the SDK's states onto OpenClaw's vocabulary", () => {
    expect(statusStateFor('ready')).toBe('linked')
    expect(statusStateFor('blocked')).toBe('not-linked')
    expect(statusStateFor('stopped')).toBe('configured')
    expect(statusStateFor('idle')).toBe('configured')
    expect(statusStateFor('connecting')).toBe('unstable')
    expect(statusStateFor('backoff')).toBe('unstable')
  })
})

describe('gateway.startAccount — lifecycle and the gate agent', () => {
  async function built(cfg: object = { channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } }) {
    const harness = ctxFor(cfg)
    let setStatusCalls = 0
    const original = harness.ctx.setStatus
    harness.ctx.setStatus = (next: Record<string, unknown>) => {
      setStatusCalls += 1
      original(next)
    }
    await agentchatGatewayAdapter.startAccount!(harness.ctx as never)
    const build = vi.mocked(registerIntegration).mock.calls.at(-1)![0].build
    const result = build({} as never)
    return { ...harness, h: result.handlers, invoker: result.invoker, texts: result.texts, setStatusCalls: () => setStatusCalls }
  }

  it("reports lifecycle starting → ready → recovering → ready → stopped from the SDK's states", async () => {
    const { h, status, invoker, texts } = await built()
    expect(status().lifecycle).toBe('starting')
    h.onStateChanged!('connecting', 'idle')
    expect(status().lifecycle).toBe('starting')
    h.onStateChanged!('ready', 'connecting')
    h.onConnected!(123)
    expect(status()).toMatchObject({ running: true, connected: true, linked: true, statusState: 'linked', lifecycle: 'ready', lastConnectedAt: 123 })
    // The gateway does not read closes; the state the SDK moves to after one is what it reports.
    expect(h.onDisconnected).toBeUndefined()
    h.onStateChanged!('backoff', 'ready')
    expect(status()).toMatchObject({ running: true, connected: false, statusState: 'unstable', lifecycle: 'recovering' })
    h.onStateChanged!('connecting', 'backoff')
    expect(status().lifecycle).toBe('recovering')
    h.onStateChanged!('ready', 'connecting')
    h.onConnected!(456)
    expect(status().lifecycle).toBe('ready')
    h.onStateChanged!('stopped', 'ready')
    expect(status()).toMatchObject({ running: false, connected: false, lifecycle: 'stopped' })
    invoker?.stop()
    texts?.stop()
  })

  it("a rejected key is one error line and one steady blocked status across the SDK's 10–15 min retries; an accepted HELLO clears it", async () => {
    const { h, log, status, invoker, texts, setStatusCalls } = await built()
    const errorLines = () => log.error.mock.calls.map((c) => String(c[0]))
    const warnLines = () => log.warn.mock.calls.map((c) => String(c[0]))
    const debugLines = () => log.debug.mock.calls.map((c) => String(c[0]))

    // The SDK's order for a rejected key: the close (not read here), the state `blocked`, then `blocked` with the code, the reason and the delay.
    h.onStateChanged!('blocked', 'connecting')
    h.onBlocked!({ code: 1008, reason: 'Invalid token', retryInMs: 720_000 })
    expect(errorLines()).toHaveLength(1)
    expect(errorLines()[0]).toMatch(
      /key rejected \(close 1008 Invalid token\) — the server refused the key; the SDK retries a fresh HELLO every 10–15 min until it is accepted \(next HELLO in about 12 min\); rotate the key with openclaw channels add agentchat/,
    )
    expect(status()).toMatchObject({ running: false, connected: false, statusState: 'not-linked', lifecycle: 'blocked' })
    expect((status().lastDisconnect as { error: string }).error).toBe('key rejected: close 1008 Invalid token')
    const after = setStatusCalls()

    // Two retries rejected again, then one that fails on the network instead: debug lines only, the status does not move.
    for (const retry of [1, 2]) {
      h.onStateChanged!('connecting', 'blocked')
      h.onStateChanged!('blocked', 'connecting')
      h.onBlocked!({ code: 1008, reason: 'Invalid token', retryInMs: 600_000 + retry })
    }
    h.onStateChanged!('connecting', 'blocked')
    h.onStateChanged!('backoff', 'connecting')
    h.onError!(new Error('WebSocket error'))
    expect(errorLines()).toHaveLength(1)
    expect(warnLines()).toHaveLength(0)
    expect(setStatusCalls()).toBe(after)
    expect(status().lifecycle).toBe('blocked')
    expect(debugLines().filter((l) => /still blocked \(close 1008 Invalid token; next HELLO in about 10 min\)/.test(l))).toHaveLength(2)
    expect(debugLines().some((l) => /socket in backoff while blocked/.test(l))).toBe(true)
    expect(debugLines().some((l) => /socket error: WebSocket error/.test(l))).toBe(true)

    // The key is accepted again (rotated back, or the account reinstated): ready, one info line, latch cleared.
    h.onStateChanged!('connecting', 'backoff')
    h.onStateChanged!('ready', 'connecting')
    h.onConnected!(5)
    expect(status()).toMatchObject({ running: true, connected: true, statusState: 'linked', lifecycle: 'ready' })
    expect(log.info.mock.calls.some((c) => /key accepted again — blocked cleared/.test(String(c[0])))).toBe(true)
    h.onError!(new Error('handshake timeout: no hello.ok within 15000ms'))
    expect(warnLines()).toEqual([expect.stringMatching(/socket error: handshake timeout/)])

    // A rejection after that is a new situation: one more error line, one more blocked status.
    h.onStateChanged!('backoff', 'ready')
    expect(status().lifecycle).toBe('recovering')
    h.onStateChanged!('connecting', 'backoff')
    h.onStateChanged!('blocked', 'connecting')
    h.onBlocked!({ code: 4401, reason: '', retryInMs: 900_000 })
    expect(errorLines()).toHaveLength(2)
    expect(errorLines()[1]).toMatch(/key rejected \(close 4401\) — /)
    expect(status().lifecycle).toBe('blocked')

    h.onStateChanged!('stopped', 'blocked')
    expect(status()).toMatchObject({ running: false, connected: false, lifecycle: 'stopped' })
    invoker?.stop()
    texts?.stop()
  })

  it('refusal and off report lifecycle blocked / stopped', async () => {
    const two = ctxFor({ channels: { agentchat: { accounts: { a: { apiKey: KEY }, b: { apiKey: KEY } } } } }, 'a')
    await agentchatGatewayAdapter.startAccount!(two.ctx as never)
    expect(two.status().lifecycle).toBe('blocked')
    process.env.AGENTCHAT_WAKE = 'off'
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
    const h = ctxFor(bound)
    h.ctx.channelRuntime = { routing: { resolveAgentRoute: () => ({ agentId: 'ops', sessionKey: 'agent:ops:agentchat:direct:wake' }) } } as never
    await agentchatGatewayAdapter.startAccount!(h.ctx as never)
    expect(h.log.warn.mock.calls.some((c) => String(c[0]).includes('plugins.entries.agentchat.llm.allowAgentIdOverride'))).toBe(true)

    const optedIn = ctxFor({ ...bound, plugins: { entries: { agentchat: { llm: { allowAgentIdOverride: true } } } } })
    optedIn.ctx.channelRuntime = h.ctx.channelRuntime
    await agentchatGatewayAdapter.startAccount!(optedIn.ctx as never)
    expect(optedIn.log.warn.mock.calls.some((c) => String(c[0]).includes('allowAgentIdOverride'))).toBe(false)

    const plain = ctxFor({ channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } })
    await agentchatGatewayAdapter.startAccount!(plain.ctx as never)
    expect(plain.log.warn.mock.calls.length).toBe(0)
  })
})
