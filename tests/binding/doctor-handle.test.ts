/**
 * `openclaw doctor --fix` persists the one config field only the server
 * knows — `agentHandle` — by validating the configured key once, when the
 * field is missing. Present → no network. Unreachable → a warning, not a
 * failure.
 */
import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { IDENTITY_LINE } = vi.hoisted(() => ({
  IDENTITY_LINE: 'I am @alice on AgentChat (api.agentchat.me). On any AgentChat wake I call agentchat__agentchat_inbox first.',
}))

vi.mock('../../src/setup-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/setup-client.js')>()
  return { ...actual, validateApiKey: vi.fn() }
})
vi.mock('../../src/integration/texts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integration/texts.js')>()
  return { ...actual, loadIdentityLine: vi.fn(async () => IDENTITY_LINE) }
})

import { validateApiKey } from '../../src/setup-client.js'
import { agentchatDoctorAdapter } from '../../src/binding/doctor.js'
import { testKey } from '../helpers/keys.js'

const KEY = testKey('h'.repeat(24))

describe('doctor --fix persists agentHandle', () => {
  it('learns the handle from the key when the field is missing and reports the change', async () => {
    vi.mocked(validateApiKey).mockReset().mockResolvedValueOnce({ ok: true, agent: { handle: 'alice', email: 'a@x', displayName: null, createdAt: 'now' } } as never)
    const result = await agentchatDoctorAdapter.repairConfig!({ cfg: { channels: { agentchat: { apiKey: KEY } } } as never, doctorFixCommand: 'fix', env: {} })
    expect(vi.mocked(validateApiKey)).toHaveBeenCalledWith(KEY, { apiBase: 'https://api.agentchat.me' })
    expect((result.config as unknown as { channels: { agentchat: { agentHandle: string } } }).channels.agentchat.agentHandle).toBe('alice')
    expect(result.changes).toContain('set channels.agentchat.agentHandle = alice')
    expect(result.changes.some((c) => c.startsWith('added mcp.servers.agentchat'))).toBe(true)
  })

  it('places the served identity line for the handle it just learnt, in the same run', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-doctor-handle-'))
    try {
      vi.mocked(validateApiKey).mockReset().mockResolvedValueOnce({ ok: true, agent: { handle: 'alice', email: 'a@x', displayName: null, createdAt: 'now' } } as never)
      const result = await agentchatDoctorAdapter.repairConfig!({ cfg: { agents: { defaults: { workspace } }, channels: { agentchat: { apiKey: KEY } } } as never, doctorFixCommand: 'fix', env: {} })
      expect(result.changes).toContain(`placed the identity line for @alice in ${path.join(workspace, 'AGENTS.md')}`)
      expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain(IDENTITY_LINE)
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('does not call the server for the handle when it is already configured', async () => {
    vi.mocked(validateApiKey).mockReset()
    const result = await agentchatDoctorAdapter.repairConfig!({ cfg: { channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } } as never, doctorFixCommand: 'fix', env: {} })
    expect(vi.mocked(validateApiKey)).not.toHaveBeenCalled()
    expect(result.changes.some((c) => c.includes('agentHandle'))).toBe(false)
  })

  it('an unreachable server or a bad key is a warning; the rest of the repair still happens', async () => {
    vi.mocked(validateApiKey).mockReset().mockRejectedValueOnce(new Error('ENOTFOUND'))
    const unreachable = await agentchatDoctorAdapter.repairConfig!({ cfg: { channels: { agentchat: { apiKey: KEY } } } as never, doctorFixCommand: 'fix', env: {} })
    expect(unreachable.warnings?.[0]).toMatch(/agentHandle not set and AgentChat was not reachable to learn it: ENOTFOUND/)
    expect(unreachable.changes.some((c) => c.startsWith('added mcp.servers.agentchat'))).toBe(true)
    vi.mocked(validateApiKey).mockReset().mockResolvedValueOnce({ ok: false, reason: 'unauthorized', message: 'bad key' } as never)
    const bad = await agentchatDoctorAdapter.repairConfig!({ cfg: { channels: { agentchat: { apiKey: KEY } } } as never, doctorFixCommand: 'fix', env: {} })
    expect(bad.warnings?.[0]).toMatch(/did not pass the live check \(unauthorized\): bad key/)
  })
})
