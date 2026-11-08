import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  restoreIdentityLine,
  refreshIdentityLine,
  placeApiKeyInDotEnv,
  clearApiKeyInDotEnv,
  readApiKeyFromDotEnv,
  upsertDotEnvLine,
  placeIntegration,
  applyIntegrationConfig,
  checkPlacement,
  formatPlacement,
  resolveOpenClawStateDir,
} from '../../src/integration/placement.js'
import { writeAgentsAnchor } from '../../src/binding/agents-anchor.js'
import { IDENTITY_LINE, identityLineFor } from '../helpers/texts.js'
import { testKey } from '../helpers/keys.js'

const KEY = testKey('q'.repeat(24))

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
    expect(clearApiKeyInDotEnv(stateDir).changed).toBe(false)
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

describe('placeIntegration + checkPlacement', () => {
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
  const base = () => ({ handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: IDENTITY_LINE, stateDir })

  it('places key, the served identity line, manual and tools, and returns the config with mcp.servers.agentchat', () => {
    const result = placeIntegration({ cfg: cfgFor(), ...base() })
    expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual(['key:changed', 'anchor:ok', 'manual:ok', 'mcp:changed'])
    expect(result.mcp).toBe('added')
    expect((result.cfg as unknown as { mcp: { servers: { agentchat: { headers: { Authorization: string } } } } }).mcp.servers.agentchat.headers.Authorization).toBe('Bearer ${AGENTCHAT_API_KEY}')
    const agents = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')
    expect(agents).toContain(IDENTITY_LINE) // the served text, as served (spelled for OpenClaw)
    expect(agents).toContain('agentchat__agentchat_inbox')
    expect(readApiKeyFromDotEnv(stateDir)).toBe(KEY)
    const lines = formatPlacement(result.steps)
    expect(lines[0]).toMatch(/^✓ key: AGENTCHAT_API_KEY in .*\.env \(a gateway started before this needs a restart, or a config reload, to resolve \$\{AGENTCHAT_API_KEY\}\)/)
    expect(lines[1]).toMatch(/^✓ anchor: identity line for @alice in /)
    expect(lines[3]).toMatch(/^✓ mcp: hosted tools registered as mcp\.servers\.agentchat/)
  })

  it('second run: everything ok, nothing changed', () => {
    const first = placeIntegration({ cfg: cfgFor(), ...base() })
    const second = placeIntegration({ cfg: first.cfg, ...base() })
    expect(second.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(second.mcp).toBe('present')
  })

  it('without the served identity line (AgentChat unreachable, nothing cached) the anchor step is skipped and says what to do; nothing is invented', () => {
    const result = placeIntegration({ cfg: cfgFor(), ...base(), identityLine: null })
    const anchor = result.steps.find((s) => s.name === 'anchor')!
    expect(anchor.status).toBe('skipped')
    expect(anchor.detail).toMatch(/not placed — AgentChat's texts were unreachable and nothing is cached; run openclaw doctor --fix/)
    expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(false)
    expect(formatPlacement(result.steps)[1]).toMatch(/^– anchor:/)
  })

  it('reports a failed step instead of throwing', () => {
    const result = placeIntegration({ cfg: cfgFor(), ...base(), handle: '' })
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

  it("checkPlacement: the key check reports what THIS process sees and never claims to know the gateway's environment", () => {
    const placed = placeIntegration({ cfg: cfgFor(), ...base() })
    const fromDotEnv = checkPlacement({ cfg: placed.cfg, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: IDENTITY_LINE, stateDir, env: {} })
    expect(fromDotEnv.find((c) => c.name === 'key')).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/AGENTCHAT_API_KEY in .*\.env; a gateway started before the wizard placed it needs a restart \(or a config reload\) to resolve \$\{AGENTCHAT_API_KEY\}/),
    })
    const live = checkPlacement({ cfg: placed.cfg, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: IDENTITY_LINE, stateDir, env: { AGENTCHAT_API_KEY: KEY } })
    expect(live.every((c) => c.ok)).toBe(true)
    expect(live.find((c) => c.name === 'key')!.detail).toMatch(/present in this process; a gateway started before/)
    expect(live.find((c) => c.name === 'key')!.detail).not.toMatch(/gateway environment/)
    const stale = checkPlacement({ cfg: placed.cfg, handle: 'alice', apiKey: testKey('z'.repeat(24)), apiBase: 'https://api.agentchat.me', stateDir, env: { AGENTCHAT_API_KEY: KEY } })
    expect(stale.find((c) => c.name === 'key')!.detail).toMatch(/differs from the configured channel key/)
  })

  it('checkPlacement: with the served line known, the anchor must hold exactly that text; without it, any of our blocks naming the handle passes', () => {
    const placed = placeIntegration({ cfg: cfgFor(), ...base() })
    const exact = checkPlacement({ cfg: placed.cfg, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: IDENTITY_LINE, stateDir, env: {} })
    expect(exact.find((c) => c.name === 'anchor')!.ok).toBe(true)
    const newer = checkPlacement({ cfg: placed.cfg, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: `${IDENTITY_LINE}\nA newer line.`, stateDir, env: {} })
    expect(newer.find((c) => c.name === 'anchor')!.ok).toBe(false)
    const relaxed = checkPlacement({ cfg: placed.cfg, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: null, stateDir, env: {} })
    expect(relaxed.find((c) => c.name === 'anchor')!.ok).toBe(true)
    const other = checkPlacement({ cfg: placed.cfg, handle: 'bob', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: null, stateDir, env: {} })
    expect(other.find((c) => c.name === 'anchor')!.ok).toBe(false)
  })

  it("checkPlacement: an enabled account's missing identity line points at doctor --fix", () => {
    const checks = checkPlacement({ cfg: { ...cfgFor(), channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } }, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir, env: {} })
    expect(checks.find((c) => c.name === 'anchor')!.detail).toMatch(/missing from .*AGENTS\.md — run openclaw doctor --fix \(or openclaw channels add agentchat\)$/)
  })

  it("checkPlacement: a disabled account's remedies name `openclaw config set channels.agentchat.enabled true`, never channels add", () => {
    const disabled = { ...cfgFor(), channels: { agentchat: { apiKey: KEY, agentHandle: 'alice', enabled: false } } }
    const checks = checkPlacement({ cfg: disabled, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', stateDir, env: {} })
    for (const name of ['key', 'anchor', 'mcp'] as const) {
      const check = checks.find((c) => c.name === name)!
      expect(check.ok).toBe(false)
      expect(check.detail).toContain('the account is disabled — re-enable it with `openclaw config set channels.agentchat.enabled true`, then run `openclaw doctor --fix`')
      expect(check.detail).not.toMatch(/run openclaw channels add/)
    }
    const named = { ...cfgFor(), channels: { agentchat: { accounts: { work: { apiKey: KEY, agentHandle: 'alice', enabled: false } } } } }
    const namedChecks = checkPlacement({ cfg: named, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', accountId: 'work', stateDir, env: {} })
    expect(namedChecks.find((c) => c.name === 'anchor')!.detail).toContain('`openclaw config set channels.agentchat.accounts.work.enabled true`')
  })
})

describe('applyIntegrationConfig — the config side of placement', () => {
  const KEY2 = testKey('c'.repeat(24))

  it('persists agentHandle, adds mcp.servers.agentchat, and reports each change once', () => {
    const first = applyIntegrationConfig({ channels: { agentchat: { apiKey: KEY2 } } }, { accountId: 'default', handle: '@alice', apiKey: KEY2, apiBase: 'https://api.agentchat.me' })
    expect(first.changes).toEqual([
      'channels.agentchat.agentHandle = alice',
      'mcp.servers.agentchat → https://api.agentchat.me/mcp (bearer template on AGENTCHAT_API_KEY)',
    ])
    const cfg = first.cfg as unknown as { channels: { agentchat: { agentHandle: string } }; mcp: { servers: Record<string, unknown> }; plugins?: unknown }
    expect(cfg.channels.agentchat.agentHandle).toBe('alice')
    expect(cfg.mcp.servers.agentchat).toBeDefined()
    expect(cfg.plugins).toBeUndefined() // default agent: no llm override opt-in
    const second = applyIntegrationConfig(first.cfg, { accountId: 'default', handle: 'alice', apiKey: KEY2, apiBase: 'https://api.agentchat.me' })
    expect(second.changes).toEqual([])
  })

  it('writes the llm override opt-in only when the account is bound to a non-default agent', () => {
    const bound = {
      channels: { agentchat: { apiKey: KEY2 } },
      agents: { entries: { main: { default: true }, ops: {} } },
      bindings: [{ agentId: 'ops', match: { channel: 'agentchat' } }],
    }
    const result = applyIntegrationConfig(bound, { accountId: 'default', handle: 'alice', apiKey: KEY2, apiBase: 'https://api.agentchat.me' })
    expect(result.changes.at(-1)).toMatch(/^plugins\.entries\.agentchat\.llm\.allowAgentIdOverride = true \(account bound to agent "ops"/)
    expect((result.cfg as unknown as { plugins: { entries: { agentchat: { llm: { allowAgentIdOverride: boolean } } } } }).plugins.entries.agentchat.llm.allowAgentIdOverride).toBe(true)
    const sameAgent = { ...bound, bindings: [{ agentId: 'main', match: { channel: 'agentchat' } }] }
    expect(applyIntegrationConfig(sameAgent, { accountId: 'default', handle: 'alice', apiKey: KEY2, apiBase: 'https://api.agentchat.me' }).changes.some((c) => c.includes('allowAgentIdOverride'))).toBe(false)
  })

  it("places the identity line in the bound agent's workspace", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-placement-bound-'))
    const opsWs = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-ops-ws-'))
    const mainWs = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-main-ws-'))
    try {
      const cfg = {
        agents: { defaults: { workspace: mainWs }, entries: { main: { default: true }, ops: { workspace: opsWs } } },
        bindings: [{ agentId: 'ops', match: { channel: 'agentchat' } }],
      }
      placeIntegration({ cfg, handle: 'alice', apiKey: KEY2, apiBase: 'https://api.agentchat.me', identityLine: IDENTITY_LINE, accountId: 'default', stateDir })
      expect(fs.existsSync(path.join(opsWs, 'AGENTS.md'))).toBe(true)
      expect(fs.existsSync(path.join(mainWs, 'AGENTS.md'))).toBe(false)
    } finally {
      for (const d of [stateDir, opsWs, mainWs]) fs.rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('restoreIdentityLine / refreshIdentityLine — the served line, placed and kept current', () => {
  let workspace: string
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-restore-ws-'))
  })
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
  })
  const cfg = () => ({ agents: { defaults: { workspace } } })

  it('places a missing line, then reports it present without rewriting the file', () => {
    expect(restoreIdentityLine(cfg(), 'default', '@alice', IDENTITY_LINE)).toEqual({ outcome: 'placed', path: path.join(workspace, 'AGENTS.md') })
    const placed = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')
    expect(placed).toContain(IDENTITY_LINE)
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), `\n\n\n${placed}\n\n`)
    expect(restoreIdentityLine(cfg(), 'default', 'alice', IDENTITY_LINE)).toEqual({ outcome: 'present', path: path.join(workspace, 'AGENTS.md') })
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toBe(`\n\n\n${placed}\n\n`)
  })

  it('a line for another handle, or an older text, is replaced by the served one', () => {
    writeAgentsAnchor({ cfg: cfg() as never, handle: 'bob', text: identityLineFor('bob') })
    expect(restoreIdentityLine(cfg(), 'default', 'alice', IDENTITY_LINE).outcome).toBe('placed')
    const content = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')
    expect(content).toContain(IDENTITY_LINE)
    expect(content).not.toContain('@bob')
    expect(restoreIdentityLine(cfg(), 'default', 'alice', `${IDENTITY_LINE}\nnewer`).outcome).toBe('placed')
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain(`${IDENTITY_LINE}\nnewer`)
  })

  it('without the served line it skips and says why; an invalid handle fails; neither writes', () => {
    const skipped = restoreIdentityLine(cfg(), 'default', 'alice', null)
    expect(skipped.outcome).toBe('skipped')
    expect(skipped.detail).toMatch(/not available .* run openclaw doctor --fix/)
    const failed = restoreIdentityLine(cfg(), 'default', 'Not A Handle', IDENTITY_LINE)
    expect(failed.outcome).toBe('failed')
    expect(failed.detail).toMatch(/not a valid AgentChat handle/)
    expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(false)
  })

  it('refreshIdentityLine rewrites a present block whose text changed, leaves an identical one alone, and never creates one', () => {
    expect(refreshIdentityLine(cfg(), 'default', 'alice', IDENTITY_LINE).outcome).toBe('absent')
    expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(false)
    writeAgentsAnchor({ cfg: cfg() as never, handle: 'alice', text: IDENTITY_LINE })
    expect(refreshIdentityLine(cfg(), 'default', 'alice', IDENTITY_LINE).outcome).toBe('unchanged')
    expect(refreshIdentityLine(cfg(), 'default', 'alice', `${IDENTITY_LINE}\nA newer served line.`).outcome).toBe('updated')
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain('A newer served line.')
  })
})
