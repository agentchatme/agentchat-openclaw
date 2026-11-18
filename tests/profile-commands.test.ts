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
import * as path from 'node:path'

import { agentchatReenableHint } from '../src/channel-account.js'
import { gatewayKeyMismatch, gatewayKeyMismatchStatus, resolveConfiguredApiKey } from '../src/channel-key.js'
import { openclawCommand } from '../src/cli-command.js'
import { checkPlacement, describeKeyCopies, keyAtRestWarnings, keyCopiesAfterRunLine, removeIntegrationFiles } from '../src/integration/placement.js'
import { turnReadiness } from '../src/integration/model.js'
import { writeApiKeyFile } from '../src/credentials/key-file.js'
import { testKey } from './helpers/keys.js'

const KEY = testKey('p'.repeat(40))
const OTHER = testKey('q'.repeat(40))
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
  it('no line names a bare `openclaw …` command under the oc2 profile', () => {
    process.env.OPENCLAW_PROFILE = 'oc2'
    const stored = writeApiKeyFile('default', KEY)
    const keyFileCfg = { channels: { agentchat: { apiKeyFile: stored.path, agentHandle: 'alice' } } }
    const plainCfg = { channels: { agentchat: { apiKey: KEY, agentHandle: 'alice' } } }
    const lines = [
      agentchatReenableHint(plainCfg as never, 'default'),
      gatewayKeyMismatchStatus(),
      (resolveConfiguredApiKey(undefined) as { reason: string }).reason,
      (resolveConfiguredApiKey({ apiKeyFile: '/nonexistent/key' }) as { reason: string }).reason,
      (resolveConfiguredApiKey({ apiKey: OTHER, apiKeyFile: stored.path }) as { reason: string }).reason,
      describeKeyCopies(['/x/openclaw.json.bak'])!,
      keyCopiesAfterRunLine(),
      ...removeIntegrationFiles(keyFileCfg, 'default', { clearKey: true }),
      ...keyAtRestWarnings(plainCfg, 'default'),
      ...checkPlacement({ cfg: {}, handle: 'alice', apiKey: KEY, apiBase: 'https://api.agentchat.test', accountId: 'default', env: {} }).map((check) => check.detail),
      ...checkPlacement({ cfg: {}, handle: undefined, apiKey: undefined, apiBase: 'https://api.agentchat.test', accountId: 'default', env: {} }).map((check) => check.detail),
      (turnReadiness({ cfg: {}, apiBase: 'https://api.agentchat.test', apiKey: KEY, env: {} }) as { reason: string }).reason,
    ]
    const commands = lines.filter((line) => /(?<![\w/@.-])openclaw /.test(line))
    expect(commands.length).toBeGreaterThan(8)
    for (const line of commands) expect(line).not.toMatch(UNPROFILED)
  })
})
