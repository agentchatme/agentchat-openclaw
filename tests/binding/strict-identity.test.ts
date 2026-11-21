/**
 * The identity block under the SDK kit's strict rule (`integration.anchor`
 * `owner` / `decide` / `follow`): a block is this agent's when it carries a
 * handle line, or when its whole text is exactly a text AgentChat served.
 * Anything else is left alone, on every path that writes AGENTS.md:
 *
 *   - the gateway's follow on each served copy (and the served template is
 *     passed, so an unmarked block from an earlier release is recognised);
 *   - the re-enable hook and `doctor --fix` (`restoreIdentityLine`);
 *   - setup (`placeIntegration`), which may replace another agent's block
 *     (the operator just named this agent) but never a hand-edited one;
 *   - status and doctor read it the same way.
 *
 * Every write is atomic and keeps the file's line breaks, whether it ends
 * with one, and its permission bits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { integration } from 'agentchatme'

const { served } = vi.hoisted(() => ({ served: { texts: null as unknown } }))

vi.mock('../../src/binding/runtime-registry.js', () => ({
  registerIntegration: vi.fn(async () => ({})),
  unregisterIntegration: vi.fn(async () => undefined),
  getIntegration: vi.fn(() => undefined),
}))
vi.mock('../../src/binding/sdk-client.js', () => {
  const client = { baseUrl: 'https://api.agentchat.me', texts: { get: vi.fn(async () => served.texts) } }
  return { getClient: () => client, createSdkClient: () => client }
})

import { agentchatGatewayAdapter } from '../../src/binding/gateway.js'
import { inspectAgentsAnchor, placeAgentsAnchor, removeAgentsAnchor, writeAgentsAnchor } from '../../src/binding/agents-anchor.js'
import { checkPlacement, followIdentityLine, placeIntegration, restoreIdentityLine } from '../../src/integration/placement.js'
import { agentchatLifecycleAdapter, agentchatPlugin } from '../../src/channel.js'
import { IDENTITY_LINE, IDENTITY_LINE_TEMPLATE, SERVED_TEXTS, identityLineFor } from '../helpers/texts.js'
import { testKey } from '../helpers/keys.js'

const KEY = testKey('i'.repeat(24))
/** What a user may write between the markers: their own words, naming the handle, with no handle line. */
const USERS_WORDS = 'I am @alice on AgentChat, and I answer only my team; I check the inbox when I am told to.'

let workspace: string
const cfg = () => ({ agents: { defaults: { workspace } } })
const file = () => path.join(workspace, 'AGENTS.md')
const fenced = (body: string, eol = '\n') => ['<!-- agentchat:start -->', body, '<!-- agentchat:end -->'].join(eol).replace(/\n/g, eol)
const read = () => fs.readFileSync(file(), 'utf8')

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-strict-'))
  served.texts = SERVED_TEXTS
})
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

describe('the kit rule on every path that writes AGENTS.md', () => {
  it("the lab repro: a user's own words naming @handle, without a handle line, are left alone by the gateway, re-enable and doctor --fix", async () => {
    const before = `# My agent\n\n${fenced(USERS_WORDS)}\n\nhouse rules\n`
    fs.writeFileSync(file(), before)
    const followed = await followIdentityLine(cfg(), 'default', 'alice', IDENTITY_LINE, IDENTITY_LINE_TEMPLATE)
    expect(followed.outcome).toBe('hand_edited')
    const restored = await restoreIdentityLine(cfg(), 'default', 'alice', IDENTITY_LINE, IDENTITY_LINE_TEMPLATE)
    expect(restored.outcome).toBe('left')
    expect(restored.detail).toMatch(/has no handle line and is not a text AgentChat served: edited by hand, left as it is — the agent reads those words\. To have the served line again: delete that block \(from <!-- agentchat:start --> to <!-- agentchat:end -->\), then run `openclaw doctor --fix`/)
    expect(read()).toBe(before)
    const anchor = checkPlacement({ cfg: cfg(), handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: IDENTITY_LINE, identityTemplate: IDENTITY_LINE_TEMPLATE, env: {} }).find((c) => c.name === 'anchor')!
    expect(anchor).toMatchObject({ ok: true, notice: true })
    expect(anchor.detail).toMatch(/edited by hand, left as it is — the agent reads those words/)
  })

  it('an exact text AgentChat served before (no handle line) is reshaped to the served block; one changed word makes it hand-edited', async () => {
    const earlier = integration.anchor.EARLIER_IDENTITY_LINES[1]!.split('<handle>').join('alice') // the bare-tool-name line releases carried
    fs.writeFileSync(file(), `# Top\n\n${fenced(earlier)}\n`)
    expect((await followIdentityLine(cfg(), 'default', 'alice', IDENTITY_LINE, IDENTITY_LINE_TEMPLATE)).outcome).toBe('updated')
    expect(read()).toBe(`# Top\n\n${['<!-- agentchat:start -->', '<!-- agentchat:handle alice -->', IDENTITY_LINE, '<!-- agentchat:end -->'].join('\n')}\n`)
    const oneWord = earlier.replace('Peers reach me there', 'Peers find me there')
    fs.writeFileSync(file(), `# Top\n\n${fenced(oneWord)}\n`)
    expect((await followIdentityLine(cfg(), 'default', 'alice', IDENTITY_LINE, IDENTITY_LINE_TEMPLATE)).outcome).toBe('hand_edited')
    expect(read()).toContain('Peers find me there')
  })

  it("the served template recognises an unmarked block written from it; without the template it is not provably this agent's", async () => {
    // A template no release has served before (so not among the kit's EARLIER_IDENTITY_LINES): only the template passed in recognises it.
    const template = 'I am @<handle> on AgentChat (api.agentchat.me). A wording only this template has: call agentchat__agentchat_inbox first.'
    const fromTemplate = template.split('<handle>').join('alice')
    const newer = 'I am @alice on AgentChat (api.agentchat.me). The newer served wording: call agentchat__agentchat_inbox first.'
    fs.writeFileSync(file(), fenced(fromTemplate) + '\n')
    expect((await followIdentityLine(cfg(), 'default', 'alice', newer, null)).outcome).toBe('hand_edited')
    expect(read()).toContain(fromTemplate)
    expect((await followIdentityLine(cfg(), 'default', 'alice', newer, template)).outcome).toBe('updated')
    expect(read()).toContain(newer)
  })

  it("another agent's block is left alone by the gateway, with a warning naming the possible key mix-up", async () => {
    process.env.AGENTCHAT_WAKE = 'off'
    try {
      await writeAgentsAnchor({ cfg: cfg() as never, handle: 'bob', text: identityLineFor('bob') })
      const before = read()
      const controller = new AbortController()
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
      const config = {
        apiKey: KEY,
        apiBase: 'https://api.agentchat.me',
        agentHandle: 'alice',
        reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0.2 },
        ping: { intervalMs: 45000, timeoutMs: 30000 },
        outbound: { maxInFlight: 256, sendTimeoutMs: 15000 },
        observability: { logLevel: 'info' as const, redactKeys: [] },
      }
      let status: Record<string, unknown> = {}
      const running = agentchatGatewayAdapter.startAccount!({
        cfg: { ...cfg(), channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } },
        accountId: 'default',
        account: { accountId: 'default', enabled: true, configured: true, parseError: null, config },
        runtime: {},
        abortSignal: controller.signal,
        log,
        getStatus: () => status,
        setStatus: (next: Record<string, unknown>) => {
          status = next
        },
        channelRuntime: undefined,
      } as never)
      await vi.waitFor(() => expect(log.warn.mock.calls.some((c) => /identity line left as it is/.test(String(c[0])))).toBe(true), { timeout: 5_000 })
      const line = String(log.warn.mock.calls.find((c) => /identity line left as it is/.test(String(c[0])))![0])
      expect(line).toMatch(/is @bob's, not @alice's; left as it is — if this agent is @alice, delete that block .*; if it is @bob, the key configured for this account is another agent's/)
      expect(read()).toBe(before)
      controller.abort()
      await running
    } finally {
      delete process.env.AGENTCHAT_WAKE
    }
  })

  it('re-enable over a hand-edited block: left as it is, and the hook says how to restore it', async () => {
    const before = `${fenced(USERS_WORDS)}\n`
    fs.writeFileSync(file(), before)
    const lines: string[] = []
    const runtime = { log: (...a: unknown[]) => lines.push(a.map(String).join(' ')), error: (...a: unknown[]) => lines.push(a.map(String).join(' ')), exit: () => undefined }
    const prevCfg = { ...cfg(), channels: { agentchat: { apiKey: KEY, agentHandle: 'alice', enabled: false } } }
    const nextCfg = agentchatPlugin.config.setAccountEnabled!({ cfg: prevCfg as never, accountId: 'default', enabled: true })
    await agentchatLifecycleAdapter.onAccountConfigChanged!({ prevCfg: prevCfg as never, nextCfg, accountId: 'default', runtime } as never)
    expect(read()).toBe(before)
    expect(lines).toContainEqual(expect.stringMatching(/^\[agentchat:default\] identity line for @alice left as it is: .*edited by hand, left as it is — the agent reads those words\. To have the served line again: delete that block/))
  })

  it("setup replaces another agent's block (the operator just named this agent) and says so; a hand-edited block it leaves", async () => {
    await writeAgentsAnchor({ cfg: cfg() as never, handle: 'bob', text: identityLineFor('bob') })
    const placed = await placeIntegration({ cfg: cfg(), handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: IDENTITY_LINE, identityTemplate: IDENTITY_LINE_TEMPLATE, placeKey: false })
    expect(placed.steps.find((s) => s.name === 'anchor')).toMatchObject({ status: 'changed', detail: expect.stringMatching(/^replaced @bob's identity line in .* with @alice's \(the block named another agent\)$/) })
    expect(read()).toContain(IDENTITY_LINE)
    expect(read()).not.toContain('@bob')
    fs.writeFileSync(file(), `${fenced(USERS_WORDS)}\n`)
    const again = await placeIntegration({ cfg: cfg(), handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: IDENTITY_LINE, identityTemplate: IDENTITY_LINE_TEMPLATE, placeKey: false })
    expect(again.steps.find((s) => s.name === 'anchor')).toMatchObject({ status: 'warned', detail: expect.stringMatching(/edited by hand, left as it is/) })
    expect(read()).toContain(USERS_WORDS)
  })

  it('several AgentChat blocks: nothing written, and status says to keep one', async () => {
    const before = `${fenced(USERS_WORDS)}\n\n${fenced(IDENTITY_LINE)}\n`
    fs.writeFileSync(file(), before)
    expect((await followIdentityLine(cfg(), 'default', 'alice', IDENTITY_LINE, IDENTITY_LINE_TEMPLATE)).outcome).toBe('several_blocks')
    expect((await restoreIdentityLine(cfg(), 'default', 'alice', IDENTITY_LINE)).outcome).toBe('left')
    expect(read()).toBe(before)
    const anchor = checkPlacement({ cfg: cfg(), handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: IDENTITY_LINE, env: {} }).find((c) => c.name === 'anchor')!
    expect(anchor.ok).toBe(false)
    expect(anchor.detail).toMatch(/more than one AgentChat block.* — keep one AgentChat block \(delete the others\), then run `openclaw doctor --fix`/)
  })
})

describe('the file is kept as it was around the block', () => {
  it('CRLF and a missing final newline are kept by an update, a placement and a removal; the permission bits too', async () => {
    const crlf = `# Notes\r\n\r\nline one\r\n\r\n${fenced('I am @alice on AgentChat (older wording).', '\r\n').replace('<!-- agentchat:start -->', '<!-- agentchat:start -->\r\n<!-- agentchat:handle alice -->')}\r\n\r\ntail without a final newline`
    fs.writeFileSync(file(), crlf)
    fs.chmodSync(file(), 0o640)
    expect((await followIdentityLine(cfg(), 'default', 'alice', IDENTITY_LINE, IDENTITY_LINE_TEMPLATE)).outcome).toBe('updated')
    const updated = read()
    expect(updated.replace(/\r\n/g, '')).not.toMatch(/\n/) // every line break still CRLF
    expect(updated.endsWith('tail without a final newline')).toBe(true)
    expect(updated).toContain(IDENTITY_LINE.split('\n').join('\r\n'))
    if (process.platform !== 'win32') expect(fs.statSync(file()).mode & 0o777).toBe(0o640)

    // removal keeps the style too
    expect((await removeAgentsAnchor({ cfg: cfg() as never })).removed).toBe(true)
    const removed = read()
    expect(removed).toBe('# Notes\r\n\r\nline one\r\n\r\ntail without a final newline')

    // and a placement into that file
    expect((await placeAgentsAnchor({ cfg: cfg() as never, handle: 'alice', identityLine: IDENTITY_LINE })).outcome).toBe('placed')
    const placed = read()
    expect(placed.replace(/\r\n/g, '')).not.toMatch(/\n/)
    expect(placed.startsWith('# Notes\r\n\r\nline one\r\n\r\ntail without a final newline\r\n\r\n<!-- agentchat:start -->\r\n<!-- agentchat:handle alice -->\r\n')).toBe(true)
    if (process.platform !== 'win32') expect(fs.statSync(file()).mode & 0o777).toBe(0o640)
  })

  it('a file that is not UTF-8 is neither read nor written; through a symlink, the file it points to is the one replaced', async () => {
    const latin1 = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from(`\n\n${fenced(IDENTITY_LINE)}\n`)])
    fs.writeFileSync(file(), latin1)
    expect((await followIdentityLine(cfg(), 'default', 'alice', `${IDENTITY_LINE}\nnewer`, null)).outcome).toBe('failed')
    expect((await placeAgentsAnchor({ cfg: cfg() as never, handle: 'alice', identityLine: IDENTITY_LINE })).outcome).toBe('failed')
    expect(fs.readFileSync(file()).equals(latin1)).toBe(true)
    expect(inspectAgentsAnchor({ cfg: cfg() as never, handle: 'alice', identityLine: IDENTITY_LINE }).outcome).toBe('failed')

    if (process.platform === 'win32') return
    const real = path.join(workspace, 'real-agents.md')
    fs.rmSync(file())
    fs.writeFileSync(real, `${fenced('I am @alice on AgentChat (older wording).').replace('<!-- agentchat:start -->', '<!-- agentchat:start -->\n<!-- agentchat:handle alice -->')}\n`)
    fs.symlinkSync(real, file())
    expect((await followIdentityLine(cfg(), 'default', 'alice', IDENTITY_LINE, null)).outcome).toBe('updated')
    expect(fs.lstatSync(file()).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf8')).toContain(IDENTITY_LINE)
  })
})

describe('status reads the block strictly', () => {
  it('a block whose words mention @alice but are not a served text is not "present" for @alice; another agent\'s is not ok', async () => {
    fs.writeFileSync(file(), `${fenced(`Notes: ask @alice before anything.`)}\n`)
    const loose = checkPlacement({ cfg: cfg(), handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: null, env: {} }).find((c) => c.name === 'anchor')!
    expect(loose).toMatchObject({ ok: true, notice: true })
    expect(loose.detail).toMatch(/edited by hand/)
    await writeAgentsAnchor({ cfg: cfg() as never, handle: 'bob', text: identityLineFor('bob') })
    const other = checkPlacement({ cfg: cfg(), handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.me', identityLine: IDENTITY_LINE, env: {} }).find((c) => c.name === 'anchor')!
    expect(other.ok).toBe(false)
    expect(other.detail).toMatch(/is @bob's, not @alice's/)
  })
})

