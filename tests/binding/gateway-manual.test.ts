/**
 * The gateway keeps the served texts — and with them the identity line and
 * the manual — on every path that gets as far as a parsed account:
 *
 *   - AGENTCHAT_WAKE=off: no socket, no turns, but the manual is placed and
 *     kept current, and a placed identity line is refreshed;
 *   - more than one account, or a key mismatch: the integration refuses to
 *     start, the manual (account-free) is still placed, the identity line is
 *     left alone (whose would it be?);
 *   - the full integration: the keeper is handed to the registry and
 *     released when the account stops.
 *
 * The registry and the SDK client are mocked (no socket, no network); the
 * abort signal is live, so each test stops the account itself.
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
    baseUrl: 'https://api.agentchat.me',
    texts: { get: vi.fn(async () => SERVED_TEXTS) },
    listGroupInvites: vi.fn(async () => []),
    inbox: { tray: vi.fn() },
    decisions: { record: vi.fn() },
  }
  return { getClient: () => client, createSdkClient: () => client }
})

import { agentchatGatewayAdapter } from '../../src/binding/gateway.js'
import { registerIntegration } from '../../src/binding/runtime-registry.js'
import { writeAgentsAnchor } from '../../src/binding/agents-anchor.js'
import { latestManualOutcome, managedManualPath, readManualRecord } from '../../src/integration/manual.js'
import { BUNDLED_MANUAL_SHA256, BUNDLED_MANUAL_VERSION, IDENTITY_LINE } from '../helpers/texts.js'

const KEY = ['ac', 'm'.repeat(24)].join('_')
const OLD_LINE = 'I am @alice on AgentChat (api.agentchat.me). Older wording.'

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

function start(cfg: object, accountId = 'default') {
  const controller = new AbortController()
  let status: Record<string, unknown> = { accountId }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const ctx = {
    cfg,
    accountId,
    account: { accountId, enabled: true, configured: true, parseError: null, config: config() },
    runtime: {},
    abortSignal: controller.signal,
    log,
    getStatus: () => status,
    setStatus: (next: Record<string, unknown>) => {
      status = next
    },
    channelRuntime: undefined,
  }
  const running = agentchatGatewayAdapter.startAccount!(ctx as never)
  return {
    log,
    status: () => status,
    lines: (level: keyof typeof log) => log[level].mock.calls.map((c) => String(c[0])),
    stop: async () => {
      controller.abort()
      await running
    },
  }
}

const placed = () => fs.existsSync(managedManualPath()) && readManualRecord()?.written?.sha256 === BUNDLED_MANUAL_SHA256

let workspace: string
const saved = { wake: process.env.AGENTCHAT_WAKE, key: process.env.AGENTCHAT_API_KEY }
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-gateway-manual-'))
  vi.mocked(registerIntegration).mockClear()
  delete process.env.AGENTCHAT_WAKE
  delete process.env.AGENTCHAT_API_KEY
})
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
  if (saved.wake === undefined) delete process.env.AGENTCHAT_WAKE
  else process.env.AGENTCHAT_WAKE = saved.wake
  if (saved.key === undefined) delete process.env.AGENTCHAT_API_KEY
  else process.env.AGENTCHAT_API_KEY = saved.key
})

describe('the manual and the identity line on every gateway path', () => {
  it('AGENTCHAT_WAKE=off: no integration, but the manual is placed (logged) and a placed identity line is refreshed', async () => {
    process.env.AGENTCHAT_WAKE = 'off'
    const cfg = { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } }
    writeAgentsAnchor({ cfg: cfg as never, handle: 'alice', text: OLD_LINE })
    const run = start(cfg)
    await vi.waitFor(() => expect(placed()).toBe(true))
    expect(registerIntegration).not.toHaveBeenCalled()
    expect(run.lines('info')[0]).toMatch(/AGENTCHAT_WAKE=off — no socket, no wakes, no turns; the hosted tools stay placed, and the manual and the identity line are kept current/)
    expect(run.lines('info')).toContain(`[agentchat] manual: ${BUNDLED_MANUAL_VERSION} placed from the bundled copy (the served version) → ${managedManualPath()}`)
    const agents = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')
    expect(agents).toContain(IDENTITY_LINE)
    expect(agents).not.toContain(OLD_LINE)
    expect(run.status()).toMatchObject({ running: false, statusState: 'disabled', lifecycle: 'stopped' })
    expect(latestManualOutcome()).toMatchObject({ kind: 'synced' })
    await run.stop()
    expect(latestManualOutcome()).toBeNull() // released with the account
    expect(run.lines('warn')).toEqual([])
    expect(run.lines('error')).toEqual([])
  })

  it('a second account configured: the integration refuses to start; the manual is still placed, the identity line is left alone', async () => {
    const cfg = { agents: { defaults: { workspace } }, channels: { agentchat: { accounts: { a: { apiKey: KEY, agentHandle: 'alice' }, b: { apiKey: KEY, agentHandle: 'bob' } } } } }
    writeAgentsAnchor({ cfg: cfg as never, handle: 'alice', text: OLD_LINE })
    const run = start(cfg, 'a')
    await vi.waitFor(() => expect(placed()).toBe(true))
    expect(registerIntegration).not.toHaveBeenCalled()
    expect(run.lines('error')).toHaveLength(1)
    expect(run.lines('error')[0]).toMatch(/integration not started — 2 AgentChat accounts are configured/)
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain(OLD_LINE)
    await run.stop()
  })

  it("a key mismatch: refused; the manual is still placed, the identity line is left alone", async () => {
    process.env.AGENTCHAT_API_KEY = ['ac', 'o'.repeat(24)].join('_')
    const cfg = { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } }
    writeAgentsAnchor({ cfg: cfg as never, handle: 'alice', text: OLD_LINE })
    const run = start(cfg)
    await vi.waitFor(() => expect(placed()).toBe(true))
    expect(registerIntegration).not.toHaveBeenCalled()
    expect(run.lines('error')).toHaveLength(1)
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain(OLD_LINE)
    await run.stop()
  })

  it('the full integration: the keeper claim goes to the registry with the texts cache, and is released when the account stops', async () => {
    const cfg = { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } }
    const run = start(cfg)
    await vi.waitFor(() => expect(registerIntegration).toHaveBeenCalledTimes(1))
    const built = vi.mocked(registerIntegration).mock.calls[0]![0].build({ realtime: null } as never)
    expect(built.manual).toEqual(expect.objectContaining({ release: expect.any(Function) }))
    expect(built.textsCache).toBeTruthy()
    await vi.waitFor(() => expect(placed()).toBe(true))
    await built.loop?.stop()
    await run.stop()
    expect(latestManualOutcome()).toBeNull()
  })

  it('a stopAccount without an abort stops a passive account’s texts and keeper too', async () => {
    process.env.AGENTCHAT_WAKE = 'off'
    const cfg = { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } }
    const run = start(cfg)
    await vi.waitFor(() => expect(placed()).toBe(true))
    expect(latestManualOutcome()).not.toBeNull()
    await agentchatGatewayAdapter.stopAccount!({ accountId: 'default', getStatus: () => ({}), setStatus: () => undefined } as never)
    expect(latestManualOutcome()).toBeNull()
    await run.stop()
  })
})
