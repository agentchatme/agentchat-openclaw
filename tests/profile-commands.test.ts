/**
 * Every command the plugin prints acts on the profile it was printed for.
 *
 * `openclaw --profile oc2 …` runs with OPENCLAW_PROFILE=oc2 (OpenClaw sets it,
 * and a profile's gateway service carries it); its state is ~/.openclaw-oc2.
 * The refusal for a foreign AGENTCHAT_API_KEY used to say "OpenClaw reads
 * ~/.openclaw/.env" and end "restart the gateway (`openclaw gateway
 * restart`)": typed as printed in the oc2 profile, that restarts the default
 * profile's gateway — another agent — and leaves the refused one down.
 * Commands now go through OpenClaw's own formatter (it adds `--profile
 * <name>`), and paths are the profile's own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { agentchatReenableHint } from '../src/channel-account.js'
import { gatewayKeyMismatch, gatewayKeyMismatchStatus, resolveConfiguredApiKey } from '../src/channel-key.js'
import { agentchatSetupAdapter } from '../src/channel.js'
import { openclawCommand } from '../src/cli-command.js'
import { checkPlacement, describeKeyCopies, keyAtRestWarnings, keyCopiesAfterRunLine, removeIntegrationFiles } from '../src/integration/placement.js'
import { turnReadiness } from '../src/integration/model.js'
import { writeApiKeyFile } from '../src/credentials/key-file.js'
import { testKey } from './helpers/keys.js'

const KEY = testKey('p'.repeat(40))
const OTHER = testKey('q'.repeat(40))
/**
 * The channel as a bare argument (`channels add agentchat`, `channels remove
 * agentchat`): OpenClaw before 2026.8 answers "Too many arguments for this
 * command." to the first, every release to the second. `--channel agentchat`
 * is the form every supported OpenClaw takes.
 */
const POSITIONAL = /channels (?:add|remove) agentchat\b/
/** `openclaw` followed by anything but this profile's flag (`openclaw.json` is a file name, `@agentchatme/openclaw` a package). */
const UNPROFILED = /(?<![\w/@.-])openclaw (?!--profile oc2 )/

let saved: string | undefined
beforeEach(() => {
  saved = process.env.OPENCLAW_PROFILE
})
afterEach(() => {
  if (saved === undefined) delete process.env.OPENCLAW_PROFILE
  else process.env.OPENCLAW_PROFILE = saved
})

describe('openclawCommand', () => {
  it('adds --profile <name> under a profile, and nothing for the default one', () => {
    process.env.OPENCLAW_PROFILE = 'oc2'
    expect(openclawCommand('gateway restart')).toBe('openclaw --profile oc2 gateway restart')
    delete process.env.OPENCLAW_PROFILE
    expect(openclawCommand('gateway restart')).toBe('openclaw gateway restart')
    process.env.OPENCLAW_PROFILE = 'default'
    expect(openclawCommand('doctor --fix')).toBe('openclaw doctor --fix')
  })
})

describe('the refusal for a foreign AGENTCHAT_API_KEY in a non-default profile (oc2)', () => {
  it('names oc2’s .env and commands that act on oc2', () => {
    process.env.OPENCLAW_PROFILE = 'oc2'
    const stateDir = path.join('/home/lab', '.openclaw-oc2')
    const text = gatewayKeyMismatch(KEY, OTHER, stateDir)!
    expect(text).toContain(`OpenClaw reads ${path.join(stateDir, '.env')} only when the gateway starts`)
    expect(text).toContain('`openclaw --profile oc2 doctor --fix` places the account')
    expect(text).toContain('if `openclaw --profile oc2 gateway restart` warns')
    expect(text).toContain('reinstall it (`openclaw --profile oc2 gateway install --force`)')
    expect(text).toMatch(/Then restart the gateway \(`openclaw --profile oc2 gateway restart`\)\.$/)
    expect(text).not.toContain('~/.openclaw')
    expect(text).not.toMatch(UNPROFILED)
    expect(text).not.toContain(OTHER)
  })

  it('the default profile keeps the plain commands', () => {
    delete process.env.OPENCLAW_PROFILE
    const text = gatewayKeyMismatch(KEY, OTHER, '/home/lab/.openclaw')!
    expect(text).toContain('OpenClaw reads /home/lab/.openclaw/.env only when the gateway starts')
    expect(text).toMatch(/Then restart the gateway \(`openclaw gateway restart`\)\.$/)
  })
})

describe('every printed command carries the profile (a sweep over what setup, status, doctor and remove print)', () => {
  it('no line names a bare `openclaw …` command under the oc2 profile', async () => {
    process.env.OPENCLAW_PROFILE = 'oc2'
    const stored = writeApiKeyFile('default', KEY)
    const keyFileCfg = { channels: { agentchat: { apiKeyFile: stored.path, agentHandle: 'alice' } } }
    const plainCfg = { channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } }
    const lines = [
      agentchatSetupAdapter.validateInput!({ cfg: {} as never, accountId: 'default', input: {} }) as string,
      agentchatReenableHint(plainCfg as never, 'default'),
      gatewayKeyMismatchStatus(),
      (resolveConfiguredApiKey(undefined) as { reason: string }).reason,
      (resolveConfiguredApiKey({ apiKeyFile: '/nonexistent/key' }) as { reason: string }).reason,
      (resolveConfiguredApiKey({ apiKey: OTHER, apiKeyFile: stored.path }) as { reason: string }).reason,
      describeKeyCopies(['/x/openclaw.json.bak'])!,
      keyCopiesAfterRunLine(),
      ...(await removeIntegrationFiles(keyFileCfg, 'default', { clearKey: true })),
      ...keyAtRestWarnings(plainCfg, 'default'),
      ...checkPlacement({ cfg: {}, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.test', accountId: 'default', env: {} }).map((check) => check.detail),
      ...checkPlacement({ cfg: {}, handle: undefined, apiKey: undefined, apiBase: 'https://api.agentchat.test', accountId: 'default', env: {} }).map((check) => check.detail),
      (turnReadiness({ cfg: {}, apiBase: 'https://api.agentchat.test', apiKey: KEY, env: {} }) as { reason: string }).reason,
    ]
    const commands = lines.filter((line) => /(?<![\w/@.-])openclaw /.test(line))
    expect(commands.length).toBeGreaterThan(8)
    for (const line of commands) expect(line).not.toMatch(UNPROFILED)
    // …and names the channel the way every supported OpenClaw takes it.
    const naming = commands.filter((line) => /channels (?:add|remove) /.test(line))
    expect(naming.length).toBeGreaterThan(5)
    for (const line of naming) {
      expect(line).not.toMatch(POSITIONAL)
      expect(line).toMatch(/channels (?:add|remove) --channel agentchat\b|channels add`/)
    }
  })
})

describe('the channel is passed as --channel agentchat, never as a bare argument', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const sources = (dir: string): string[] =>
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? sources(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : [],
    )

  it('no source file prints or documents the positional form', () => {
    const hits = sources('src').flatMap((file) =>
      fs
        .readFileSync(path.join(root, file), 'utf8')
        .split('\n')
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter((entry) => POSITIONAL.test(entry.text)),
    )
    expect(hits).toEqual([])
  })

  it('README, RUNBOOK and SECURITY name it only to say it fails', () => {
    for (const doc of ['README.md', 'RUNBOOK.md', 'SECURITY.md']) {
      const hits = fs
        .readFileSync(path.join(root, doc), 'utf8')
        .split('\n')
        .filter((line) => POSITIONAL.test(line) && !line.includes('Too many arguments for this command.'))
      expect({ doc, hits }).toEqual({ doc, hits: [] })
    }
  })

  it('the answer to `channels add --channel agentchat` with no key names the wizard route of every OpenClaw', () => {
    delete process.env.OPENCLAW_PROFILE
    expect(agentchatSetupAdapter.validateInput!({ cfg: {} as never, accountId: 'default', input: {} })).toBe(
      'an API key is required — pass --token-file <path> (a file that holds only the key; - reads it from standard input); ' +
        'or, to register a new agent or recover a lost key (email code), open the setup wizard: ' +
        '`openclaw channels add --channel agentchat` with no other option (OpenClaw before 2026.8: `openclaw channels add`, then pick AgentChat)',
    )
  })
})
