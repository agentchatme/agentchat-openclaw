/**
 * `channels add agentchat --token <key>` (non-interactive): `applyAccountConfig`
 * is synchronous, so the handle the key authenticates as is learnt in
 * `afterAccountConfigWritten` and persisted — with the hosted tools entry —
 * through OpenClaw's own `runtime.config.mutateConfigFile`.
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
import { agentchatPlugin } from '../src/channel.js'
import { setPluginRuntime, resetPluginRuntimeForTest } from '../src/doorbell/runtime-holder.js'

const KEY = 'ac_live_' + 'n'.repeat(24)

describe('setup.afterAccountConfigWritten (non-interactive path)', () => {
  let workspace: string
  const logger = { info: vi.fn(), warn: vi.fn() }
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-setup-hook-'))
    logger.info.mockClear()
    logger.warn.mockClear()
    vi.mocked(validateApiKey).mockReset()
    resetPluginRuntimeForTest()
  })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
    resetPluginRuntimeForTest()
  })

  it('persists agentHandle and mcp.servers.agentchat through runtime.config.mutateConfigFile, and places key + identity line', async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({ ok: true, agent: { handle: 'alice', email: 'a@x', displayName: null, createdAt: 'now' } } as never)
    let written: Record<string, unknown> | null = null
    const mutateConfigFile = vi.fn(async (params: { mutate: (draft: Record<string, unknown>) => unknown; afterWrite: unknown }) => {
      const draft: Record<string, unknown> = { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY } } }
      const result = await params.mutate(draft)
      written = draft
      return { result }
    })
    setPluginRuntime({ config: { mutateConfigFile } } as never)

    const cfg = { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY } } }
    await agentchatPlugin.setup!.afterAccountConfigWritten!({ previousCfg: {} as never, cfg: cfg as never, accountId: 'default', input: { token: KEY }, runtime: { logger } as never })

    expect(mutateConfigFile).toHaveBeenCalledTimes(1)
    expect(mutateConfigFile.mock.calls[0]![0].afterWrite).toEqual({ mode: 'auto' })
    const w = written! as { channels: { agentchat: { agentHandle: string } }; mcp: { servers: { agentchat: { headers: { Authorization: string } } } } }
    expect(w.channels.agentchat.agentHandle).toBe('alice')
    expect(w.mcp.servers.agentchat.headers.Authorization).toBe('Bearer ${AGENTCHAT_API_KEY}')
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain('I am @alice on AgentChat')
    expect(fs.readFileSync(path.join(process.env.OPENCLAW_STATE_DIR!, '.env'), 'utf8')).toContain(`AGENTCHAT_API_KEY=${KEY}`)
    expect(logger.info.mock.calls.some((c) => String(c[0]).includes('config: channels.agentchat.agentHandle = alice; mcp.servers.agentchat'))).toBe(true)
  })

  it('without the plugin runtime it says what doctor --fix will persist', async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({ ok: true, agent: { handle: 'alice', email: 'a@x', displayName: null, createdAt: 'now' } } as never)
    const cfg = { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY } } }
    await agentchatPlugin.setup!.afterAccountConfigWritten!({ previousCfg: {} as never, cfg: cfg as never, accountId: 'default', input: { token: KEY }, runtime: { logger } as never })
    expect(logger.warn.mock.calls.some((c) => String(c[0]).includes('openclaw doctor --fix') && String(c[0]).includes('agentHandle=alice'))).toBe(true)
  })

  it('a key that fails the live check writes nothing', async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({ ok: false, reason: 'unauthorized', message: 'bad key' } as never)
    const mutateConfigFile = vi.fn()
    setPluginRuntime({ config: { mutateConfigFile } } as never)
    await agentchatPlugin.setup!.afterAccountConfigWritten!({ previousCfg: {} as never, cfg: { channels: { agentchat: { apiKey: KEY } } } as never, accountId: 'default', input: { token: KEY }, runtime: { logger } as never })
    expect(mutateConfigFile).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(false)
  })
})
