import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  placeApiKeyInDotEnv,
  clearApiKeyInDotEnv,
  readApiKeyFromDotEnv,
  upsertDotEnvLine,
  placeDoorbell,
  checkPlacement,
  formatPlacement,
  resolveOpenClawStateDir,
} from '../../src/doorbell/placement.js'

const KEY = 'ac_live_' + 'q'.repeat(24)

describe('placement — the key in the OpenClaw state-dir .env', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-placement-'))
  })
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  it('creates .env with the key (0600) and is idempotent', () => {
    const first = placeApiKeyInDotEnv(KEY, stateDir)
    expect(first.changed).toBe(true)
    expect(fs.readFileSync(first.path, 'utf8')).toBe(`AGENTCHAT_API_KEY=${KEY}\n`)
    if (process.platform !== 'win32') expect(fs.statSync(first.path).mode & 0o777).toBe(0o600)
    expect(placeApiKeyInDotEnv(KEY, stateDir).changed).toBe(false)
    expect(readApiKeyFromDotEnv(stateDir)).toBe(KEY)
  })

  it('replaces the line in place and keeps other lines byte for byte', () => {
    fs.writeFileSync(path.join(stateDir, '.env'), '# gateway env\nOPENAI_API_KEY=sk-x\nexport AGENTCHAT_API_KEY=old\nOTHER=1\n')
    placeApiKeyInDotEnv(KEY, stateDir)
    expect(fs.readFileSync(path.join(stateDir, '.env'), 'utf8')).toBe(`# gateway env\nOPENAI_API_KEY=sk-x\nAGENTCHAT_API_KEY=${KEY}\nOTHER=1\n`)
  })

  it('appends when absent, even without a trailing newline', () => {
    fs.writeFileSync(path.join(stateDir, '.env'), 'A=1')
    placeApiKeyInDotEnv(KEY, stateDir)
    expect(fs.readFileSync(path.join(stateDir, '.env'), 'utf8')).toBe(`A=1\nAGENTCHAT_API_KEY=${KEY}\n`)
  })

  it('clears the key line and leaves the rest', () => {
    fs.writeFileSync(path.join(stateDir, '.env'), `A=1\nAGENTCHAT_API_KEY=${KEY}\nB=2\n`)
    expect(clearApiKeyInDotEnv(stateDir).changed).toBe(true)
    expect(fs.readFileSync(path.join(stateDir, '.env'), 'utf8')).toBe('A=1\nB=2\n')
    expect(readApiKeyFromDotEnv(stateDir)).toBeUndefined()
  })

  it('rejects an empty or multi-line key', () => {
    expect(() => placeApiKeyInDotEnv('', stateDir)).toThrow(/empty/)
    expect(() => placeApiKeyInDotEnv('a\nb', stateDir)).toThrow(/line break/)
  })

  it('upsertDotEnvLine is pure and newline-stable', () => {
    expect(upsertDotEnvLine('', 'K', 'v')).toBe('K=v\n')
    expect(upsertDotEnvLine('K=old\n', 'K', 'v')).toBe('K=v\n')
    expect(upsertDotEnvLine('# K=comment\nX=1\n', 'K', 'v')).toBe('# K=comment\nX=1\nK=v\n')
  })

  it('resolveOpenClawStateDir honours OPENCLAW_STATE_DIR (set by the test setup)', () => {
    expect(resolveOpenClawStateDir()).toBe(path.resolve(process.env.OPENCLAW_STATE_DIR!))
  })
})

describe('placeDoorbell + checkPlacement', () => {
  let stateDir: string
  let workspace: string
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-placement-state-'))
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-placement-ws-'))
  })
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true })
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  const cfgFor = () => ({ agents: { defaults: { workspace } } })

  it('places key, identity line, manual and tools, and returns the config with mcp.servers.agentchat', () => {
    const result = placeDoorbell({ cfg: cfgFor(), handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir })
    expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual(['key:changed', 'anchor:ok', 'manual:ok', 'mcp:changed'])
    expect(result.mcp).toBe('added')
    expect((result.cfg as unknown as { mcp: { servers: { agentchat: { headers: { Authorization: string } } } } }).mcp.servers.agentchat.headers.Authorization).toBe('Bearer ${AGENTCHAT_API_KEY}')
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain('I am @alice on AgentChat')
    expect(readApiKeyFromDotEnv(stateDir)).toBe(KEY)
    const lines = formatPlacement(result.steps)
    expect(lines[0]).toMatch(/^✓ key: AGENTCHAT_API_KEY in .*\.env \(a gateway started before this needs a restart, or a config reload, to resolve \$\{AGENTCHAT_API_KEY\}\)/)
    expect(lines[3]).toMatch(/^✓ mcp: hosted tools registered as mcp\.servers\.agentchat/)
  })

  it('second run: everything ok, nothing changed', () => {
    const first = placeDoorbell({ cfg: cfgFor(), handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir })
    const second = placeDoorbell({ cfg: first.cfg, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir })
    expect(second.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(second.mcp).toBe('present')
  })

  it('reports a failed step instead of throwing', () => {
    const result = placeDoorbell({ cfg: cfgFor(), handle: '', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir })
    const anchor = result.steps.find((s) => s.name === 'anchor')!
    expect(anchor.status).toBe('failed')
    expect(anchor.detail).toMatch(/handle is empty/)
  })

  it('checkPlacement: before placement everything but the manual fails with a pointer to the fix', () => {
    const checks = checkPlacement({ cfg: cfgFor(), handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir, env: {} })
    expect(checks.map((c) => `${c.name}:${c.ok}`)).toEqual(['key:false', 'anchor:false', 'manual:true', 'mcp:false'])
    expect(checks[0]!.detail).toMatch(/not placed/)
    expect(checks[3]!.detail).toMatch(/openclaw doctor --fix/)
  })

  it('checkPlacement: the key check reports what THIS process sees and never claims to know the gateway\'s environment', () => {
    const placed = placeDoorbell({ cfg: cfgFor(), handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir })
    const fromDotEnv = checkPlacement({ cfg: placed.cfg, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir, env: {} })
    expect(fromDotEnv.find((c) => c.name === 'key')).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/AGENTCHAT_API_KEY in .*\.env; a gateway started before the wizard placed it needs a restart \(or a config reload\) to resolve \$\{AGENTCHAT_API_KEY\}/),
    })
    const live = checkPlacement({ cfg: placed.cfg, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir, env: { AGENTCHAT_API_KEY: KEY } })
    expect(live.every((c) => c.ok)).toBe(true)
    expect(live.find((c) => c.name === 'key')!.detail).toMatch(/present in this process; a gateway started before/)
    expect(live.find((c) => c.name === 'key')!.detail).not.toMatch(/gateway environment/)
    const stale = checkPlacement({ cfg: placed.cfg, handle: 'alice', apiKey: 'ac_live_' + 'z'.repeat(24), apiBase: 'https://api.agentchat.me', stateDir, env: { AGENTCHAT_API_KEY: KEY } })
    expect(stale.find((c) => c.name === 'key')!.detail).toMatch(/differs from the configured channel key/)
  })
})
