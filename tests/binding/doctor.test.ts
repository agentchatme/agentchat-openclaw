import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { agentchatDoctorAdapter } from '../../src/binding/doctor.js'
import { placeDoorbell } from '../../src/doorbell/placement.js'

const KEY = 'ac_live_' + 'd'.repeat(24)

describe('doctor adapter', () => {
  let workspace: string
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-doctor-'))
  })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  const cfg = () => ({ agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } })

  it('warns about every missing placement and names the fix command for the config entry', async () => {
    const warnings = await agentchatDoctorAdapter.collectPreviewWarnings!({ cfg: cfg() as never, doctorFixCommand: 'openclaw doctor --fix', env: {} })
    expect(warnings.some((w) => w.includes('[agentchat:default] key:'))).toBe(true)
    expect(warnings.some((w) => w.includes('[agentchat:default] anchor:'))).toBe(true)
    expect(warnings.some((w) => w.includes('[agentchat:default] mcp:') && w.includes('(openclaw doctor --fix adds it)'))).toBe(true)
    expect(warnings.some((w) => w.includes('manual'))).toBe(false)
  })

  it('is quiet once everything is placed and the key is in the environment', async () => {
    const placed = placeDoorbell({ cfg: cfg(), handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir: process.env.OPENCLAW_STATE_DIR })
    const warnings = await agentchatDoctorAdapter.collectPreviewWarnings!({ cfg: placed.cfg as never, doctorFixCommand: 'fix', env: { AGENTCHAT_API_KEY: KEY } })
    expect(warnings).toEqual([])
  })

  it('repairConfig adds mcp.servers.agentchat as a bearer template and reports the change; a second run changes nothing', async () => {
    const first = await agentchatDoctorAdapter.repairConfig!({ cfg: cfg() as never, doctorFixCommand: 'fix', env: {} })
    expect(first.changes).toEqual(['added mcp.servers.agentchat → https://api.agentchat.me/mcp (bearer template on AGENTCHAT_API_KEY)'])
    const entry = (first.config as { mcp: { servers: { agentchat: { headers: { Authorization: string } } } } }).mcp.servers.agentchat
    expect(entry.headers.Authorization).toBe('Bearer ${AGENTCHAT_API_KEY}')
    const second = await agentchatDoctorAdapter.repairConfig!({ cfg: first.config, doctorFixCommand: 'fix', env: {} })
    expect(second.changes).toEqual([])
  })

  it('warns when more than one account is configured — the doorbell will not start', async () => {
    const two = { agents: { defaults: { workspace } }, channels: { agentchat: { accounts: { a: { apiKey: KEY }, b: { apiKey: KEY } } } } }
    const warnings = await agentchatDoctorAdapter.collectPreviewWarnings!({ cfg: two as never, doctorFixCommand: 'fix', env: {} })
    expect(warnings[0]).toMatch(/^\[agentchat\] doorbell will not start — 2 AgentChat accounts are configured \(a, b\)/)
  })

  it('repairConfig does nothing when no account is configured', async () => {
    const result = await agentchatDoctorAdapter.repairConfig!({ cfg: {} as never, doctorFixCommand: 'fix', env: {} })
    expect(result.changes).toEqual([])
    expect((result.config as { mcp?: unknown }).mcp).toBeUndefined()
  })
})

describe('doctor adapter — the llm override opt-in for a non-default bound agent', () => {
  const KEY2 = 'ac_live_' + 'e'.repeat(24)
  const bound = {
    channels: { agentchat: { apiKey: KEY2, agentHandle: 'alice' } },
    agents: { entries: { main: { default: true }, ops: {} } },
    bindings: [{ agentId: 'ops', match: { channel: 'agentchat' } }],
  }

  it('warns when the opt-in is missing and names the fix', async () => {
    const warnings = await agentchatDoctorAdapter.collectPreviewWarnings!({ cfg: bound as never, doctorFixCommand: 'openclaw doctor --fix', env: {} })
    expect(warnings.some((w) => w.includes('gate: this account is bound to agent "ops"') && w.includes('allowAgentIdOverride') && w.includes('(openclaw doctor --fix writes it)'))).toBe(true)
  })

  it('repairConfig writes the opt-in, and only for a non-default bound agent', async () => {
    const fixed = await agentchatDoctorAdapter.repairConfig!({ cfg: bound as never, doctorFixCommand: 'fix', env: {} })
    expect(fixed.changes.some((c) => c.startsWith('set plugins.entries.agentchat.llm.allowAgentIdOverride = true'))).toBe(true)
    expect((fixed.config as unknown as { plugins: { entries: { agentchat: { llm: { allowAgentIdOverride: boolean } } } } }).plugins.entries.agentchat.llm.allowAgentIdOverride).toBe(true)
    const plain = await agentchatDoctorAdapter.repairConfig!({ cfg: { channels: { agentchat: { apiKey: KEY2 } } } as never, doctorFixCommand: 'fix', env: {} })
    expect(plain.changes.some((c) => c.includes('allowAgentIdOverride'))).toBe(false)
  })

  it('classifies the env-substituted entry as ours (no spurious "managed by hand" warning)', async () => {
    const substituted = {
      ...bound,
      bindings: [],
      mcp: { servers: { agentchat: { url: 'https://api.agentchat.me/mcp', transport: 'streamable-http', headers: { Authorization: `Bearer ${KEY2}` } } } },
    }
    const warnings = await agentchatDoctorAdapter.collectPreviewWarnings!({ cfg: substituted as never, doctorFixCommand: 'fix', env: {} })
    expect(warnings.some((w) => w.includes('mcp:'))).toBe(false)
    const fixed = await agentchatDoctorAdapter.repairConfig!({ cfg: substituted as never, doctorFixCommand: 'fix', env: {} })
    expect(fixed.changes.some((c) => c.includes('mcp.servers'))).toBe(false)
  })
})
