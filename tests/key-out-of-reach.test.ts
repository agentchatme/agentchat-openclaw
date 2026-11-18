/**
 * The API key out of reach (lab round 1: T6-F09, T6-F04, T6-F10, T6-F15).
 *
 * The key is the agent's password on AgentChat. These tests pin where it
 * may be and where it may not:
 *
 *   - never in `openclaw.json`: the config holds the path of an owner-only
 *     key file (`channels.agentchat.apiKeyFile`), written by setup, by the
 *     wizard and by `openclaw doctor --fix` (T6-F09: a peer-woken turn read
 *     openclaw.json and the whole key went to the model provider);
 *   - never on a command line we document or print: `channels add
 *     agentchat --token-file <path>` (OpenClaw's own option) reads the key
 *     from a file or standard input (T6-F04);
 *   - an `AGENTCHAT_API_KEY` that is not the account's key never silently
 *     wins: the gateway refuses to start the integration (T6-F10);
 *   - `--delete` says where the key still is: the key file it keeps (the
 *     only copy; OpenClaw may still refuse that write) and OpenClaw's own
 *     config copies that hold it (T6-F15);
 *   - an install from before the key file keeps working (the plain-text
 *     `apiKey` is read as a fallback) and is moved on the next setup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { IDENTITY_LINE } = vi.hoisted(() => ({
  IDENTITY_LINE: 'I am @alice on AgentChat (api.agentchat.me). Peers reach me there.',
}))

vi.mock('../src/setup-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/setup-client.js')>()
  return { ...actual, checkApiKey: vi.fn() }
})
vi.mock('../src/integration/texts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/integration/texts.js')>()
  return { ...actual, loadIdentityLine: vi.fn(async () => IDENTITY_LINE) }
})

import { WizardCancelledError } from 'openclaw/plugin-sdk/setup'

import { checkApiKey } from '../src/setup-client.js'
import { agentchatLifecycleAdapter, agentchatPlugin, agentchatSetupAdapter, resolveAgentchatAccount } from '../src/channel.js'
import { readAgentchatApiKey, resolveConfiguredApiKey } from '../src/channel-key.js'
import { parseChannelConfig } from '../src/config-schema.js'
import {
  apiKeyFilePathFor,
  listAccountKeyFiles,
  readApiKeyFile,
  readTokenFile,
  removeAccountKeyFiles,
  resetTokenFileReadsForTest,
  writeApiKeyFile,
} from '../src/credentials/key-file.js'
import { testKey } from './helpers/keys.js'

const KEY = testKey('k'.repeat(40))
const OTHER = testKey('o'.repeat(40))
const stateDir = () => process.env.OPENCLAW_STATE_DIR!
const dotenv = () => path.join(stateDir(), '.env')
const posix = process.platform !== 'win32'

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

/** Every string anywhere in a config object (keys and values). */
function configText(cfg: unknown): string {
  return JSON.stringify(cfg)
}

let scratch: string
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-key-'))
  removeAccountKeyFiles('default')
  fs.rmSync(dotenv(), { force: true })
  resetTokenFileReadsForTest()
  vi.mocked(checkApiKey).mockReset()
})
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the key file', () => {
  it('is owner-only (0600) in an owner-only directory (0700), named from the key’s hash — never the key', () => {
    const stored = writeApiKeyFile('default', KEY)
    expect(stored.created).toBe(true)
    expect(stored.path).toBe(apiKeyFilePathFor('default', KEY))
    expect(path.basename(stored.path)).toMatch(/^key-[0-9a-f]{16}$/)
    expect(stored.path).not.toContain(KEY.slice(3))
    expect(fs.readFileSync(stored.path, 'utf8')).toBe(`${KEY}\n`)
    if (posix) {
      expect(fs.statSync(stored.path).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(stored.path)).mode & 0o777).toBe(0o700)
    }
    expect(writeApiKeyFile('default', KEY).created).toBe(false)
  })

  it('a new key is a new file: the file an unchanged config names is never rewritten, so a cancelled setup loses nothing', () => {
    const first = writeApiKeyFile('default', KEY)
    const second = writeApiKeyFile('default', OTHER)
    expect(second.path).not.toBe(first.path)
    expect(fs.readFileSync(first.path, 'utf8').trim()).toBe(KEY)
    expect(listAccountKeyFiles('default').sort()).toEqual([first.path, second.path].sort())
  })

  it('is refused when it is a symbolic link, not a regular file, too large, or not one key — and the reason never holds the key', () => {
    const real = path.join(scratch, 'real')
    fs.writeFileSync(real, KEY)
    const link = path.join(scratch, 'link')
    fs.symlinkSync(real, link)
    expect(readApiKeyFile(link)).toMatchObject({ ok: false, reason: expect.stringMatching(/symbolic link/) })
    expect(readApiKeyFile(scratch)).toMatchObject({ ok: false, reason: 'it is not a regular file' })
    const big = path.join(scratch, 'big')
    fs.writeFileSync(big, 'x'.repeat(5000))
    expect(readApiKeyFile(big)).toMatchObject({ ok: false, reason: expect.stringMatching(/larger than 4096 bytes/) })
    const two = path.join(scratch, 'two')
    fs.writeFileSync(two, `AGENTCHAT_API_KEY = ${KEY}\n`)
    const refused = readApiKeyFile(two)
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/more than the key/) })
    expect(JSON.stringify(refused)).not.toContain(KEY)
    expect(readApiKeyFile(path.join(scratch, 'absent'))).toMatchObject({ ok: false, reason: 'the file does not exist' })
  })

  it('a group- or world-readable key file is read, and reported so doctor can tighten it', () => {
    if (!posix) return
    const stored = writeApiKeyFile('default', KEY)
    fs.chmodSync(stored.path, 0o644)
    expect(readApiKeyFile(stored.path)).toMatchObject({ ok: true, apiKey: KEY, loosePermissions: true })
  })
})

describe('which key an account runs with', () => {
  it('apiKeyFile names the key; parseChannelConfig resolves it (source: file)', () => {
    const stored = writeApiKeyFile('default', KEY)
    const config = parseChannelConfig({ apiKeyFile: stored.path, agentHandle: 'alice' })
    expect(config.apiKey).toBe(KEY)
    expect(config.apiKeySource).toBe('file')
    expect(resolveAgentchatAccount({ channels: { agentchat: { apiKeyFile: stored.path, agentHandle: 'alice' } } } as never, 'default')).toMatchObject({ configured: true, parseError: null })
  })

  it('an install from before the key file keeps working: the plain-text apiKey is the fallback (source: config)', () => {
    const config = parseChannelConfig({ apiKey: KEY })
    expect(config.apiKey).toBe(KEY)
    expect(config.apiKeySource).toBe('config')
  })

  it('both set to the same key (a migration in progress): the file is used; two different keys are refused plainly, never one picked silently', () => {
    const stored = writeApiKeyFile('default', KEY)
    expect(resolveConfiguredApiKey({ apiKeyFile: stored.path, apiKey: KEY })).toMatchObject({ ok: true, source: 'file' })
    const differ = resolveConfiguredApiKey({ apiKeyFile: stored.path, apiKey: OTHER })
    expect(differ).toMatchObject({ ok: false, reason: expect.stringMatching(/channels\.agentchat\.apiKey and the key in channels\.agentchat\.apiKeyFile .* are different keys — keep one/) })
    expect(JSON.stringify(differ)).not.toContain(KEY)
    expect(JSON.stringify(differ)).not.toContain(OTHER)
    const account = resolveAgentchatAccount({ channels: { agentchat: { apiKeyFile: stored.path, apiKey: OTHER } } } as never, 'default')
    expect(account.configured).toBe(false)
    expect(account.parseError).toMatch(/are different keys/)
  })

  it('the key file in use and the same key still in plain text: used from the file, and flagged as a copy to remove', () => {
    const stored = writeApiKeyFile('default', KEY)
    expect(resolveConfiguredApiKey({ apiKeyFile: stored.path, apiKey: KEY })).toMatchObject({ ok: true, source: 'file', plainTextCopy: true })
    expect(parseChannelConfig({ apiKeyFile: stored.path, apiKey: KEY })).toMatchObject({ apiKey: KEY, apiKeySource: 'file', apiKeyPlainTextCopy: true })
  })

  it('a key file that cannot be read: the account is not configured and says why (or the plain-text key stands in, with the problem reported)', () => {
    const gone = path.join(scratch, 'gone')
    const account = resolveAgentchatAccount({ channels: { agentchat: { apiKeyFile: gone } } } as never, 'default')
    expect(account.configured).toBe(false)
    expect(account.parseError).toBe(`channels.agentchat.apiKeyFile (${gone}) cannot be used: the file does not exist — run \`openclaw channels add agentchat\` to store the key again`)
    expect(resolveConfiguredApiKey({ apiKeyFile: gone, apiKey: KEY })).toMatchObject({ ok: true, source: 'config', fileProblem: 'the file does not exist' })
  })
})

describe('openclaw channels add agentchat --token-file <path> — the key never on the command line (T6-F04) and never in openclaw.json (T6-F09)', () => {
  const tokenFile = () => {
    const file = path.join(scratch, 'agentchat.key')
    fs.writeFileSync(file, `${KEY}\n`, { mode: 0o600 })
    return file
  }

  it('OpenClaw 2026.10.x order (prepare → validate → apply → lifecycle → after): the config names an owner-only key file, holds no key, and nothing warns', async () => {
    vi.mocked(checkApiKey).mockResolvedValue({ ok: true, handle: 'alice' })
    const { runtime, lines } = cliRuntime()
    const input = { tokenFile: tokenFile() }
    const prepared = await agentchatSetupAdapter.prepareAccountConfigInput!({ cfg: {} as never, accountId: 'default', input, runtime })
    expect(prepared).toEqual({ tokenFile: input.tokenFile, agentHandle: 'alice' })
    expect(JSON.stringify(prepared)).not.toContain(KEY) // the key is never copied into the setup input
    expect(agentchatSetupAdapter.validateInput!({ cfg: {} as never, accountId: 'default', input: prepared })).toBeNull()
    const next = agentchatPlugin.setup!.applyAccountConfig({ cfg: {} as never, accountId: 'default', input: prepared })
    await agentchatLifecycleAdapter.onAccountConfigChanged!({ prevCfg: {} as never, nextCfg: next, accountId: 'default', runtime })
    await agentchatPlugin.setup!.afterAccountConfigWritten!({ previousCfg: {} as never, cfg: next, accountId: 'default', input: prepared, runtime })

    expect(checkApiKey).toHaveBeenCalledTimes(1) // asked once, before the write
    expect(checkApiKey).toHaveBeenCalledWith(KEY, { apiBase: undefined })
    const section = (next as unknown as { channels: { agentchat: Record<string, unknown> } }).channels.agentchat
    expect(section.apiKey).toBeUndefined()
    expect(section.apiKeyFile).toBe(apiKeyFilePathFor('default', KEY))
    expect(section.agentHandle).toBe('alice')
    expect(configText(next)).not.toContain(KEY)
    expect(readApiKeyFile(section.apiKeyFile as string)).toMatchObject({ ok: true, apiKey: KEY, loosePermissions: false })
    expect(readAgentchatApiKey(next, 'default')).toBe(KEY)
    // Known OpenClaw limit, stated in the docs: the hosted tools' bearer is ${AGENTCHAT_API_KEY} from the gateway environment.
    expect(fs.readFileSync(dotenv(), 'utf8')).toContain('AGENTCHAT_API_KEY=')
    expect(lines.filter((l) => l.level === 'error')).toEqual([])
    expect(lines.map((l) => l.line).join('\n')).not.toContain(KEY)
  })

  it('an older OpenClaw (no prepareAccountConfigInput): the lifecycle hook before the write asks AgentChat, then stores the key the config names', async () => {
    vi.mocked(checkApiKey).mockResolvedValue({ ok: true, handle: 'alice' })
    const { runtime, lines } = cliRuntime()
    const input = { tokenFile: tokenFile() }
    expect(agentchatSetupAdapter.validateInput!({ cfg: {} as never, accountId: 'default', input })).toBeNull()
    const next = agentchatPlugin.setup!.applyAccountConfig({ cfg: {} as never, accountId: 'default', input })
    expect(listAccountKeyFiles('default')).toEqual([]) // nothing stored before AgentChat answered
    await agentchatLifecycleAdapter.onAccountConfigChanged!({ prevCfg: {} as never, nextCfg: next, accountId: 'default', runtime })
    expect(listAccountKeyFiles('default')).toEqual([apiKeyFilePathFor('default', KEY)])
    await agentchatPlugin.setup!.afterAccountConfigWritten!({ previousCfg: {} as never, cfg: next, accountId: 'default', input, runtime })
    expect(configText(next)).not.toContain(KEY)
    expect(readAgentchatApiKey(next, 'default')).toBe(KEY)
    expect(lines.map((l) => l.line).join('\n')).not.toContain(KEY)
  })

  it('an older OpenClaw, a key AgentChat turns away: the write is cancelled and the stored key stays exactly as it was', async () => {
    const kept = writeApiKeyFile('default', OTHER)
    const prevCfg = { channels: { agentchat: { apiKeyFile: kept.path, agentHandle: 'alice' } } }
    vi.mocked(checkApiKey).mockResolvedValue({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid API key' })
    const { runtime, lines } = cliRuntime()
    const input = { tokenFile: tokenFile() }
    const next = agentchatPlugin.setup!.applyAccountConfig({ cfg: prevCfg as never, accountId: 'default', input })
    await expect(agentchatLifecycleAdapter.onAccountConfigChanged!({ prevCfg: prevCfg as never, nextCfg: next, accountId: 'default', runtime })).rejects.toBeInstanceOf(WizardCancelledError)
    expect(listAccountKeyFiles('default')).toEqual([kept.path])
    expect(fs.readFileSync(kept.path, 'utf8').trim()).toBe(OTHER)
    expect(lines[0]).toEqual({ level: 'error', line: expect.stringMatching(/^AgentChat did not accept the API key \(UNAUTHORIZED\): Invalid API key\nThe key was not saved\./) })
  })

  it('a token file that cannot be read is refused before anything is written, and the refusal never echoes a key', async () => {
    const { runtime } = cliRuntime()
    const missing = { tokenFile: path.join(scratch, 'nope.key') }
    const prepared = await agentchatSetupAdapter.prepareAccountConfigInput!({ cfg: {} as never, accountId: 'default', input: missing, runtime })
    expect(checkApiKey).not.toHaveBeenCalled()
    expect(agentchatSetupAdapter.validateInput!({ cfg: {} as never, accountId: 'default', input: prepared })).toBe(`--token-file: ${missing.tokenFile} does not exist. The key was not saved.`)
    const twoLines = path.join(scratch, 'two.key')
    fs.writeFileSync(twoLines, `${KEY}\n${OTHER}\n`)
    const refusal = agentchatSetupAdapter.validateInput!({ cfg: {} as never, accountId: 'default', input: { tokenFile: twoLines } })
    expect(refusal).toMatch(/is not one API key: it holds more than the key/)
    expect(refusal).not.toContain(KEY)
    expect(agentchatSetupAdapter.validateInput!({ cfg: {} as never, accountId: 'default', input: { tokenFile: tokenFile(), token: KEY } })).toBe('pass the API key once: --token-file <path> or --token, not both')
    expect(listAccountKeyFiles('default')).toEqual([])
  })

  it('a rotation: before the write only the new key file is stored; .env still holds the old key until the config naming the new one is written', async () => {
    vi.mocked(checkApiKey).mockResolvedValue({ ok: true, handle: 'alice' })
    const old = writeApiKeyFile('default', OTHER)
    fs.writeFileSync(dotenv(), `AGENTCHAT_API_KEY=${OTHER}\n`)
    const prevCfg = { channels: { agentchat: { apiKeyFile: old.path, agentHandle: 'alice' } } }
    const { runtime } = cliRuntime()
    const input = { tokenFile: tokenFile() }
    const prepared = await agentchatSetupAdapter.prepareAccountConfigInput!({ cfg: prevCfg as never, accountId: 'default', input, runtime })
    const next = agentchatPlugin.setup!.applyAccountConfig({ cfg: prevCfg as never, accountId: 'default', input: prepared })
    await agentchatLifecycleAdapter.onAccountConfigChanged!({ prevCfg: prevCfg as never, nextCfg: next, accountId: 'default', runtime })
    // A write that never lands here (refused, cancelled) leaves .env and the config agreeing on the old key.
    expect(fs.readFileSync(dotenv(), 'utf8')).toBe(`AGENTCHAT_API_KEY=${OTHER}\n`)
    expect(readApiKeyFile(apiKeyFilePathFor('default', KEY))).toMatchObject({ ok: true, apiKey: KEY })
    expect(fs.readFileSync(old.path, 'utf8').trim()).toBe(OTHER)
    await agentchatPlugin.setup!.afterAccountConfigWritten!({ previousCfg: prevCfg as never, cfg: next, accountId: 'default', input: prepared, runtime })
    expect(fs.readFileSync(dotenv(), 'utf8')).toBe(`AGENTCHAT_API_KEY=${KEY}\n`)
  })

  it('what validateInput will refuse (a bad --url) is refused before anything is asked or stored', async () => {
    const { runtime } = cliRuntime()
    const input = { tokenFile: tokenFile(), url: 'ftp://agentchat.example' }
    const prepared = await agentchatSetupAdapter.prepareAccountConfigInput!({ cfg: {} as never, accountId: 'default', input, runtime })
    expect(checkApiKey).not.toHaveBeenCalled()
    expect(agentchatSetupAdapter.validateInput!({ cfg: {} as never, accountId: 'default', input: prepared })).toBe('apiBase must be http(s) — e.g. https://api.agentchat.me')
    expect(listAccountKeyFiles('default')).toEqual([])
    expect(fs.existsSync(dotenv())).toBe(false)
  })

  it('a path that ran no hook before the write: the after-hook asks AgentChat before it stores the key the config names, and stores nothing it turns away', async () => {
    vi.mocked(checkApiKey).mockResolvedValue({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid API key' })
    const { runtime, lines } = cliRuntime()
    const input = { tokenFile: tokenFile() }
    const cfg = { channels: { agentchat: { apiKeyFile: apiKeyFilePathFor('default', KEY) } } }
    await agentchatPlugin.setup!.afterAccountConfigWritten!({ previousCfg: {} as never, cfg: cfg as never, accountId: 'default', input, runtime })
    expect(listAccountKeyFiles('default')).toEqual([])
    expect(fs.existsSync(dotenv())).toBe(false)
    expect(lines[0]).toEqual({ level: 'error', line: expect.stringMatching(/^AgentChat did not accept the API key \(UNAUTHORIZED\): Invalid API key .*does not exist — run `openclaw channels add agentchat` again/) })
  })

  it('reads the key file once per process (OpenClaw calls several hooks with the same input; - is standard input, which can be read once)', () => {
    const file = tokenFile()
    expect(readTokenFile(file)).toEqual({ ok: true, apiKey: KEY })
    fs.writeFileSync(file, `${OTHER}\n`)
    expect(readTokenFile(file)).toEqual({ ok: true, apiKey: KEY })
  })

  it('--token still works but says, once, that it put the key on the command line', async () => {
    vi.mocked(checkApiKey).mockResolvedValue({ ok: true, handle: 'alice' })
    const { runtime, lines } = cliRuntime()
    const prepared = await agentchatSetupAdapter.prepareAccountConfigInput!({ cfg: {} as never, accountId: 'default', input: { token: KEY }, runtime })
    const next = agentchatPlugin.setup!.applyAccountConfig({ cfg: {} as never, accountId: 'default', input: prepared })
    await agentchatPlugin.setup!.afterAccountConfigWritten!({ previousCfg: {} as never, cfg: next, accountId: 'default', input: prepared, runtime })
    expect(configText(next)).not.toContain(KEY)
    const errors = lines.filter((l) => l.level === 'error').map((l) => l.line)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/the key was on this command's command line \(--token\), where any user of this machine can read it \(ps\) while the command runs — next time pass --token-file <path>/)
  })

  it('setup over an install that kept the key in plain text moves it out and says so; OpenClaw’s own copies are named, paths only', async () => {
    const configPath = path.join(stateDir(), 'openclaw.json')
    fs.writeFileSync(`${configPath}.bak`, JSON.stringify({ channels: { agentchat: { apiKey: KEY } } }))
    try {
      vi.mocked(checkApiKey).mockResolvedValue({ ok: true, handle: 'alice' })
      const { runtime, lines } = cliRuntime()
      const previousCfg = { channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } }
      const input = { tokenFile: tokenFile() }
      const prepared = await agentchatSetupAdapter.prepareAccountConfigInput!({ cfg: previousCfg as never, accountId: 'default', input, runtime })
      const next = agentchatPlugin.setup!.applyAccountConfig({ cfg: previousCfg as never, accountId: 'default', input: prepared })
      expect(configText(next)).not.toContain(KEY)
      await agentchatPlugin.setup!.afterAccountConfigWritten!({ previousCfg: previousCfg as never, cfg: next, accountId: 'default', input: prepared, runtime })
      const text = lines.map((l) => l.line).join('\n')
      expect(text).toContain('removed the plain-text channels.agentchat.apiKey from openclaw.json')
      // This hook runs after OpenClaw's one config write for the add: the list is the files as they are now.
      expect(text).toContain(`OpenClaw's own copies of openclaw.json still hold this key in plain text: ${configPath}.bak`)
      expect(text).not.toContain(KEY)
    } finally {
      fs.rmSync(`${configPath}.bak`, { force: true })
    }
  })
})

/**
 * One config write as OpenClaw makes it (`src/config/backup-rotation.ts`): `.bak.4` dropped, each `.bak.N` → `.bak.N+1`,
 * `.bak` → `.bak.1`, the config as it was → `.bak`, then the new config in place.
 */
function writeConfigLikeOpenClaw(configPath: string, next: string): void {
  const base = `${configPath}.bak`
  fs.rmSync(`${base}.4`, { force: true })
  for (let index = 3; index >= 1; index--) if (fs.existsSync(`${base}.${index}`)) fs.renameSync(`${base}.${index}`, `${base}.${index + 1}`)
  if (fs.existsSync(base)) fs.renameSync(base, `${base}.1`)
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, base)
  fs.writeFileSync(configPath, next)
}

describe('openclaw channels remove --channel agentchat --delete (T6-F15)', () => {
  const configCopies = (configPath: string) => [configPath, `${configPath}.bak`, ...[1, 2, 3, 4].map((n) => `${configPath}.bak.${n}`), `${configPath}.last-good`]
  afterEach(() => {
    for (const file of configCopies(path.join(stateDir(), 'openclaw.json'))) fs.rmSync(file, { force: true })
  })

  it('removes the .env line, names the key file it keeps (OpenClaw may still refuse the write) and OpenClaw’s own config copies that hold the key once its write is done — paths only', async () => {
    const stored = writeApiKeyFile('default', KEY)
    fs.writeFileSync(dotenv(), `OTHER_VAR=1\nAGENTCHAT_API_KEY=${KEY}\n`)
    const configPath = path.join(stateDir(), 'openclaw.json')
    const prevCfg = { channels: { agentchat: { apiKeyFile: stored.path, agentHandle: 'alice' } } }
    const plain = JSON.stringify({ channels: { agentchat: { apiKey: KEY } } })
    fs.writeFileSync(configPath, JSON.stringify(prevCfg))
    fs.writeFileSync(`${configPath}.bak`, plain)
    fs.writeFileSync(`${configPath}.bak.2`, plain)
    fs.writeFileSync(`${configPath}.bak.4`, plain)
    fs.writeFileSync(`${configPath}.last-good`, plain)
    const { runtime, lines } = cliRuntime()
    await agentchatLifecycleAdapter.onAccountRemoved!({ prevCfg: prevCfg as never, accountId: 'default', runtime })
    // OpenClaw runs this hook before it commits the removal and can still refuse the write (lab: its size-drop guard);
    // a deleted key file would then be a config naming a key that is gone. Kept, and named.
    expect(fs.readFileSync(stored.path, 'utf8').trim()).toBe(KEY)
    expect(fs.readFileSync(dotenv(), 'utf8')).toBe('OTHER_VAR=1\n')
    const text = lines.map((l) => l.line).join('\n')
    expect(text).toContain(
      `kept the API key file ${stored.path} — the copy of the key this plugin keeps, never deleted here because OpenClaw can still refuse this removal: ` +
        'delete it when you no longer need the agent, or add the agent again with openclaw channels add agentchat --token-file <the file>',
    )
    // One sentence, not "the only copy on this machine" followed by a list of other copies.
    expect(text).not.toContain('only copy')
    const named = `${configPath}.bak.1, ${configPath}.bak.3, ${configPath}.last-good`
    // Said as what it is: the state once OpenClaw's write is done (a write it refuses rotates nothing).
    expect(text).toContain(`Once OpenClaw has written this removal, OpenClaw's own copies of openclaw.json still hold this key in plain text: ${named}`)
    expect(text).not.toContain(KEY)
    // OpenClaw's files are OpenClaw's: never edited by the hook.
    expect(fs.readFileSync(`${configPath}.bak.2`, 'utf8')).toContain(KEY)

    // Then OpenClaw writes the config once: the files named are exactly the ones holding the key when the command ends.
    writeConfigLikeOpenClaw(configPath, JSON.stringify({}))
    const holding = configCopies(configPath).filter((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(KEY))
    expect(holding.join(', ')).toBe(named)
  })

  it('an account still in plain text when it is removed: the config as it was becomes .bak, and is named', async () => {
    const configPath = path.join(stateDir(), 'openclaw.json')
    const prevCfg = { channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } }
    fs.writeFileSync(configPath, JSON.stringify(prevCfg))
    const { runtime, lines } = cliRuntime()
    await agentchatLifecycleAdapter.onAccountRemoved!({ prevCfg: prevCfg as never, accountId: 'default', runtime })
    expect(lines.map((l) => l.line).join('\n')).toContain(`Once OpenClaw has written this removal, OpenClaw's own copies of openclaw.json still hold this key in plain text: ${configPath}.bak —`)
    writeConfigLikeOpenClaw(configPath, JSON.stringify({}))
    expect(fs.readFileSync(`${configPath}.bak`, 'utf8')).toContain(KEY)
  })

  it('channels remove without --delete is a pause: the key file stays', async () => {
    const stored = writeApiKeyFile('default', KEY)
    const prevCfg = { channels: { agentchat: { apiKeyFile: stored.path, agentHandle: 'alice' } } }
    const nextCfg = agentchatPlugin.config.setAccountEnabled!({ cfg: prevCfg as never, accountId: 'default', enabled: false })
    const { runtime } = cliRuntime()
    await agentchatLifecycleAdapter.onAccountConfigChanged!({ prevCfg: prevCfg as never, nextCfg, accountId: 'default', runtime })
    expect(fs.readFileSync(stored.path, 'utf8').trim()).toBe(KEY)
    expect((nextCfg as unknown as { channels: { agentchat: { apiKeyFile: string } } }).channels.agentchat.apiKeyFile).toBe(stored.path)
  })
})

describe('what we document and print: no key on a command line (T6-F04), no promise the tools pick up a new key without a restart (T6-F10)', () => {
  const root = path.resolve(__dirname, '..')
  const docs = ['README.md', 'RUNBOOK.md', 'SECURITY.md', 'UPSTREAM_NOTES.md']
  const sources = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory() ? sources(full) : entry.name.endsWith('.ts') ? [full] : []
    })
  /**
   * A recipe that hands the key over on argv: `--token ac_…`, `--token "$(cat …)"`, `--token <key>`, `--token …`,
   * `--api-key …`, `curl -H "Authorization: Bearer $AGENTCHAT_API_KEY"`, `config set channels.agentchat.apiKey …`
   * — anywhere except in a sentence that says not to.
   */
  const ARGV_KEY = /--token[ =](?:ac_|"?\$\(|"?\$\{?[A-Z_]|<(?!token>|path>)|…|\.\.\.)|--api-key[ =]\S|-H\s+["']?Authorization: Bearer \$|config set channels\.agentchat\.apiKey /
  const SAYS_NOT_TO = /\bNever\b|\bnot\b.*\bcommand line\b/

  it('no doc and no printed line tells anyone to pass the key on the command line', () => {
    for (const file of [...docs.map((d) => path.join(root, d)), ...sources(path.join(root, 'src'))]) {
      const text = fs.readFileSync(file, 'utf8')
      const hits = text.split('\n').filter((line) => ARGV_KEY.test(line) && !SAYS_NOT_TO.test(line))
      expect({ file: path.relative(root, file), hits }).toEqual({ file: path.relative(root, file), hits: [] })
    }
  })

  it('the README names --token-file for the non-interactive path; README and RUNBOOK say a new key needs one gateway restart for the tools', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    const runbook = fs.readFileSync(path.join(root, 'RUNBOOK.md'), 'utf8')
    expect(readme).toContain('openclaw channels add agentchat --token-file')
    expect(readme).toContain('the socket picks up the new key at once, the hosted tools only after `openclaw gateway restart`')
    // The runbook's `blocked` section promised "a key rotated back … reconnects without a restart" and offered `config set … apiKey`.
    expect(runbook).not.toMatch(/a key rotated back or an account reinstated reconnects without a restart/)
    expect(runbook).toContain('3. `openclaw gateway restart`, once, so the hosted tools use the new key too')
  })
})
