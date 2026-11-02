/**
 * `channels add agentchat --token <key>` (non-interactive). OpenClaw 2026.10.x
 * runs `prepareAccountConfigInput` (async) first, persists exactly what the
 * synchronous `applyAccountConfig` returns, then calls
 * `afterAccountConfigWritten` with its CLI `RuntimeEnv` ({ log, error, exit })
 * — and, in that "setup-only" registration mode, hands the plugin a runtime
 * Proxy that throws on any property access. The adapter must persist the
 * handle and the hosted tools in the config write, place the files, report
 * through `runtime.log`, and never touch the plugin runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../src/setup-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/setup-client.js')>()
  return { ...actual, validateApiKey: vi.fn() }
})

import { validateApiKey } from '../src/setup-client.js'
import { agentchatPlugin, agentchatSetupAdapter } from '../src/channel.js'
import { getPluginRuntime, setPluginRuntime, isUsablePluginRuntime, resetPluginRuntimeForTest } from '../src/doorbell/runtime-holder.js'

const KEY = 'ac_live_' + 'n'.repeat(24)
const liveAgent = { handle: 'alice', email: 'a@x', displayName: null, createdAt: 'now' }

/** OpenClaw's setup-only runtime: a Proxy that throws on ANY property access. */
function throwingRuntimeProxy(): unknown {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('Plugin runtime is unavailable during setup-only registration')
      },
      has() {
        throw new Error('unavailable')
      },
    },
  )
}

function cliRuntime() {
  const lines: Array<{ level: 'log' | 'error'; line: string }> = []
  return {
    runtime: {
      log: (...args: unknown[]) => lines.push({ level: 'log', line: args.map(String).join(' ') }),
      error: (...args: unknown[]) => lines.push({ level: 'error', line: args.map(String).join(' ') }),
      exit: (_code: number) => undefined,
    },
    lines,
  }
}

describe('non-interactive setup — prepare → apply → after', () => {
  let workspace: string
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-setup-hook-'))
    vi.mocked(validateApiKey).mockReset()
    resetPluginRuntimeForTest()
  })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
    resetPluginRuntimeForTest()
  })

  it('prepareAccountConfigInput learns the handle from the key and reports through RuntimeEnv.log', async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({ ok: true, agent: liveAgent } as never)
    const { runtime, lines } = cliRuntime()
    const prepared = await agentchatSetupAdapter.prepareAccountConfigInput!({ cfg: {} as never, accountId: 'default', input: { token: KEY }, runtime })
    expect(prepared).toEqual({ token: KEY, agentHandle: 'alice' })
    expect(lines).toEqual([{ level: 'log', line: '[agentchat:default] authenticated as @alice (a@x)' }])
  })

  it('a key that fails the live check leaves the input untouched and says so on RuntimeEnv.error', async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({ ok: false, reason: 'unauthorized', message: 'bad key' } as never)
    const { runtime, lines } = cliRuntime()
    const prepared = await agentchatSetupAdapter.prepareAccountConfigInput!({ cfg: {} as never, accountId: 'default', input: { token: KEY }, runtime })
    expect(prepared).toEqual({ token: KEY })
    expect(lines[0]).toEqual({ level: 'error', line: '[agentchat:default] api key did not pass live check (unauthorized): bad key' })
  })

  it('applyAccountConfig (synchronous, the one persisted write) carries apiKey, agentHandle and mcp.servers.agentchat', () => {
    const next = agentchatPlugin.setup!.applyAccountConfig({ cfg: { channels: {} } as never, accountId: 'default', input: { token: KEY, agentHandle: '@alice' } as never }) as unknown as {
      channels: { agentchat: { apiKey: string; agentHandle: string } }
      mcp: { servers: { agentchat: { url: string; transport: string; headers: { Authorization: string } } } }
      plugins?: unknown
    }
    expect(next.channels.agentchat.apiKey).toBe(KEY)
    expect(next.channels.agentchat.agentHandle).toBe('alice')
    expect(next.mcp.servers.agentchat).toEqual({ url: 'https://api.agentchat.me/mcp', transport: 'streamable-http', headers: { Authorization: 'Bearer ${AGENTCHAT_API_KEY}' } })
    expect(next.plugins).toBeUndefined()
  })

  it('applyAccountConfig without a learnt handle (older OpenClaw) still registers the hosted tools', () => {
    const next = agentchatPlugin.setup!.applyAccountConfig({ cfg: { channels: {} } as never, accountId: 'default', input: { token: KEY } }) as unknown as {
      channels: { agentchat: { apiKey: string; agentHandle?: string } }
      mcp: { servers: Record<string, unknown> }
    }
    expect(next.channels.agentchat.agentHandle).toBeUndefined()
    expect(next.mcp.servers.agentchat).toBeDefined()
  })

  it('afterAccountConfigWritten places the key and the identity line, logs through RuntimeEnv.log, and never needs the plugin runtime', async () => {
    setPluginRuntime(throwingRuntimeProxy() as never)
    expect(getPluginRuntime()).toBeNull()
    const { runtime, lines } = cliRuntime()
    const cfg = agentchatPlugin.setup!.applyAccountConfig({ cfg: { agents: { defaults: { workspace } } } as never, accountId: 'default', input: { token: KEY, agentHandle: 'alice' } as never })
    await agentchatPlugin.setup!.afterAccountConfigWritten!({ previousCfg: {} as never, cfg, accountId: 'default', input: { token: KEY, agentHandle: 'alice' } as never, runtime })
    expect(validateApiKey).not.toHaveBeenCalled() // the handle was already in the input
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain('I am @alice on AgentChat')
    expect(fs.readFileSync(path.join(process.env.OPENCLAW_STATE_DIR!, '.env'), 'utf8')).toContain(`AGENTCHAT_API_KEY=${KEY}`)
    expect(lines.every((l) => l.level === 'log')).toBe(true)
    expect(lines.map((l) => l.line).join('\n')).toMatch(/✓ key: AGENTCHAT_API_KEY in .*\.env/)
    expect(lines.map((l) => l.line).join('\n')).toMatch(/✓ anchor: identity line for @alice/)
    expect(lines.map((l) => l.line).join('\n')).toMatch(/✓ config: agentHandle and mcp\.servers\.agentchat written with the account/)
  })

  it('on an OpenClaw without prepareAccountConfigInput the after-hook learns the handle for the identity line and points at doctor --fix for the config', async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({ ok: true, agent: liveAgent } as never)
    const { runtime, lines } = cliRuntime()
    const cfg = { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY } } }
    await agentchatPlugin.setup!.afterAccountConfigWritten!({ previousCfg: {} as never, cfg: cfg as never, accountId: 'default', input: { token: KEY }, runtime })
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain('I am @alice on AgentChat')
    expect(lines.some((l) => l.line.includes('run `openclaw doctor --fix` to persist channels.agentchat.agentHandle'))).toBe(true)
  })

  it('a key that fails the live check writes no files', async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({ ok: false, reason: 'unauthorized', message: 'bad key' } as never)
    const { runtime, lines } = cliRuntime()
    await agentchatPlugin.setup!.afterAccountConfigWritten!({ previousCfg: {} as never, cfg: { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY } } } as never, accountId: 'default', input: { token: KEY }, runtime })
    expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(false)
    expect(lines[0]!.level).toBe('error')
  })
})

describe('runtime holder — the setup-only proxy is not a runtime', () => {
  afterEach(() => resetPluginRuntimeForTest())

  it('rejects a Proxy that throws on property access and keeps a real runtime', () => {
    expect(isUsablePluginRuntime(throwingRuntimeProxy())).toBe(false)
    setPluginRuntime(throwingRuntimeProxy() as never)
    expect(getPluginRuntime()).toBeNull()
    const real = { config: {}, llm: { complete: async () => ({ text: '' }) }, subagent: {} }
    expect(isUsablePluginRuntime(real)).toBe(true)
    setPluginRuntime(real as never)
    expect(getPluginRuntime()).toBe(real)
    expect(isUsablePluginRuntime(null)).toBe(false)
    expect(isUsablePluginRuntime({})).toBe(false)
  })
})

describe('config.setAccountEnabled / config.deleteAccount (what `channels remove` calls)', () => {
  let workspace: string
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-remove-'))
  })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  /** The config as OpenClaw hands it to the plugin: env-substituted, so our entry carries the key. */
  const substituted = () => ({
    agents: { defaults: { workspace } },
    channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } },
    mcp: {
      servers: {
        agentchat: { url: 'https://api.agentchat.me/mcp', transport: 'streamable-http', headers: { Authorization: `Bearer ${KEY}` } },
        other: { url: 'https://example.invalid/mcp', transport: 'streamable-http' },
      },
    },
  })

  it('setAccountEnabled(false) disables the account, strips our MCP entry and the identity line, keeps the key', () => {
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# me\n\n<!-- agentchat:start -->\nI am @alice on AgentChat (api.agentchat.me).\n<!-- agentchat:end -->\n')
    const next = agentchatPlugin.config.setAccountEnabled!({ cfg: substituted() as never, accountId: 'default', enabled: false }) as unknown as {
      channels: { agentchat: { enabled: boolean; apiKey: string } }
      mcp: { servers: Record<string, unknown> }
    }
    expect(next.channels.agentchat.enabled).toBe(false)
    expect(next.channels.agentchat.apiKey).toBe(KEY)
    expect(next.mcp.servers.agentchat).toBeUndefined()
    expect(next.mcp.servers.other).toBeDefined()
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).not.toContain('agentchat:start')
  })

  it('setAccountEnabled(true) only re-enables', () => {
    const disabled = { channels: { agentchat: { apiKey: KEY, enabled: false } } }
    const next = agentchatPlugin.config.setAccountEnabled!({ cfg: disabled as never, accountId: 'default', enabled: true }) as unknown as { channels: { agentchat: { enabled?: boolean } } }
    expect(next.channels.agentchat.enabled ?? true).toBe(true)
  })

  it('deleteAccount drops channels.agentchat, our MCP entry, the identity line and the .env key line', () => {
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '<!-- agentchat:start -->\nI am @alice on AgentChat (api.agentchat.me).\n<!-- agentchat:end -->\n')
    const dotenv = path.join(process.env.OPENCLAW_STATE_DIR!, '.env')
    fs.writeFileSync(dotenv, `OTHER=1\nAGENTCHAT_API_KEY=${KEY}\n`)
    const next = agentchatPlugin.config.deleteAccount!({ cfg: substituted() as never, accountId: 'default' }) as unknown as {
      channels?: { agentchat?: unknown }
      mcp: { servers: Record<string, unknown> }
    }
    expect(next.channels?.agentchat).toBeUndefined()
    expect(next.mcp.servers.agentchat).toBeUndefined()
    expect(next.mcp.servers.other).toBeDefined()
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).not.toContain('agentchat:start')
    expect(fs.readFileSync(dotenv, 'utf8')).toBe('OTHER=1\n')
  })
})
