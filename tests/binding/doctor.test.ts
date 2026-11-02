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

  it('repairConfig does nothing when no account is configured', async () => {
    const result = await agentchatDoctorAdapter.repairConfig!({ cfg: {} as never, doctorFixCommand: 'fix', env: {} })
    expect(result.changes).toEqual([])
    expect((result.config as { mcp?: unknown }).mcp).toBeUndefined()
  })
})
