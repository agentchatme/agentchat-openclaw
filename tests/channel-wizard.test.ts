/**
 * Tests for the interactive channel setup wizard (`channel.wizard.ts`).
 *
 * The WizardPrompter is a `scripted` prompter that consumes an ordered list
 * of expected prompts (`note`, `select`, `text`, `confirm`). Any deviation —
 * wrong prompt kind, a value the prompt's `validate` rejects, surplus or
 * missing steps — fails the test. Spinners (`progress`) are recorded, not
 * scripted.
 *
 * Register and recover run the real SDK helper (`integration.account.run`)
 * against a scripted AgentChat server: `fetch` is stubbed, each answer is a
 * body of the sign-up flow contract (contract v1, "Sign-up flows") with the
 * server's own sentences, and every request is recorded. Nothing reaches
 * the network (tests/setup/network-guard.ts).
 *
 * Coverage:
 *   - `prepare` dispatch: register / paste / recover menu when unconfigured,
 *     edit menu (keep / change-base / replace-key) when re-run against an
 *     already-configured account; the change-base flow.
 *   - Register: a wrong code then the right one in one run; a new code
 *     asked for at the code prompt and one offered after the code expired;
 *     cancel; a taken handle re-asks the handle only; an email at its limit
 *     re-asks the email only; a Retry-After wait sat out before the call is
 *     repeated; the server's stop (a 5xx); AgentChat unreachable.
 *   - Recover: HANDLE_REQUIRED (the server's list of handles, then a second
 *     code), the configured handle pre-filled; the handle saved is the
 *     server's.
 *   - The credential step: a pasted key (or the one in AGENTCHAT_API_KEY) is
 *     checked before it is saved; one AgentChat turns away is never saved.
 *   - `finalize`: places the integration for the handle the server returned;
 *     a turned-away key and an unreachable server are reported, not thrown.
 *   - `status.resolveStatusLines`; `applyAgentchatAccountPatch`; `disable`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// The identity line is served by AgentChat; the wizard's placement is tested
// with a canned copy so no test reaches the network.
vi.mock('../src/integration/texts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/integration/texts.js')>()
  return {
    ...actual,
    loadIdentityLine: vi.fn(async () => 'I am @alice on AgentChat (api.agentchat.me). On any AgentChat wake I call agentchat__agentchat_inbox first.'),
  }
})

import { agentchatSetupWizard } from '../src/channel.wizard.js'
import {
  applyAgentchatAccountPatch,
  readAgentchatConfigField,
} from '../src/channel-account.js'
import { PACKAGE_VERSION } from '../src/version.js'
import { testKey } from './helpers/keys.js'
import { readAgentchatApiKey } from '../src/channel-key.js'
import { apiKeyFilePathFor } from '../src/credentials/key-file.js'

const KEY_PASTED = testKey('abcdef0123456789abcd')
const KEY_EXISTING = testKey('0123456789abcdef0123')
const KEY_BAD = testKey('bad00000000000000000')
const KEY_REGISTERED = testKey('fedcba9876543210fedc')
const KEY_RECOVERED = testKey('recovered0000000000')
const KEY_STAGING = testKey('stagingkey0000000000')

// ─── A scripted person ──────────────────────────────────────────────────────

type Scripted =
  | {
      kind: 'note'
      contains?: string
      /** The whole note, `title\nmessage`, exactly. */
      exact?: string
    }
  | {
      kind: 'text'
      contains?: string
      value: string
      /**
       * When present, asserts the prompt's pre-filled `initialValue`:
       * a string must match exactly, `null` asserts there is none.
       */
      initialValue?: string | null
    }
  | { kind: 'select'; contains?: string; value: unknown; options?: string[] }
  | { kind: 'confirm'; contains?: string; value: boolean }

function scripted(steps: Scripted[]) {
  const queue = [...steps]
  const consumed: Scripted[] = []
  const progress: string[] = []
  const take = <K extends Scripted['kind']>(expected: K, actualMessage: string): Extract<Scripted, { kind: K }> => {
    const head = queue.shift()
    if (!head) {
      throw new Error(`Wizard asked for ${expected} ("${actualMessage}") but the script is exhausted after ${consumed.length} steps`)
    }
    if (head.kind !== expected) {
      throw new Error(`Wizard asked for ${expected} ("${actualMessage}"); script expected ${head.kind}${'contains' in head && head.contains ? ` containing "${head.contains}"` : ''}`)
    }
    if ('contains' in head && head.contains && !actualMessage.includes(head.contains)) {
      throw new Error(`Wizard asked ${expected} with message "${actualMessage}"; script expected contains "${head.contains}"`)
    }
    if (head.kind === 'note' && head.exact !== undefined && actualMessage !== head.exact) {
      throw new Error(`Wizard noted ${JSON.stringify(actualMessage)}; script expected exactly ${JSON.stringify(head.exact)}`)
    }
    consumed.push(head)
    return head as Extract<Scripted, { kind: K }>
  }
  const prompter = {
    intro: async () => undefined,
    outro: async () => undefined,
    note: async (message: string, title?: string) => {
      take('note', `${title ?? ''}\n${message}`)
    },
    text: async (params: { message: string; initialValue?: string; validate?: (v: string) => string | undefined }) => {
      const entry = take('text', params.message)
      if ('initialValue' in entry) {
        const expected = entry.initialValue ?? undefined
        if (params.initialValue !== expected) {
          throw new Error(`text prompt "${params.message}" had initialValue ${JSON.stringify(params.initialValue)}; script expected ${JSON.stringify(expected)}`)
        }
      }
      const err = params.validate?.(entry.value)
      if (err) throw new Error(`scripted value "${entry.value}" rejected by validate for "${params.message}": ${err}`)
      return entry.value
    },
    select: async (params: { message: string; options: Array<{ value: unknown; label: string }> }) => {
      const entry = take('select', params.message)
      if (entry.options) expect(params.options.map((o) => o.label)).toEqual(entry.options)
      if (!params.options.some((o) => o.value === entry.value)) {
        throw new Error(`select "${params.message}" has no option ${JSON.stringify(entry.value)}`)
      }
      return entry.value as never
    },
    confirm: async (params: { message: string }) => take('confirm', params.message).value,
    multiselect: async () => {
      throw new Error('multiselect not mocked in wizard tests')
    },
    progress: (label: string) => {
      progress.push(label)
      return { update: (message: string) => progress.push(message), stop: () => undefined }
    },
  }
  return { prompter, remaining: () => queue.length, progress }
}

// ─── A scripted AgentChat ───────────────────────────────────────────────────

const API = 'https://api.agentchat.test'

interface Seen {
  method: string
  path: string
  body: Record<string, unknown> | null
  headers: Headers
  at: number
}

/** Answers requests in order (an Error is a request that got no answer) and records each one. */
function server(answers: Array<Response | Error>) {
  const seen: Seen[] = []
  let i = 0
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    seen.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      headers: new Headers(init?.headers),
      at: Date.now(),
    })
    const entry = answers[i++]
    if (entry === undefined) throw new Error(`server: unexpected request #${i} ${url.pathname}`)
    if (entry instanceof Error) throw entry
    return entry
  })
  vi.stubGlobal('fetch', fetchImpl)
  return { seen, left: () => answers.length - i }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

type Kind = 'register' | 'recover'
const verifyStep = (kind: Kind) => (kind === 'register' ? 'verify' : 'recover_verify')

/**
 * A live pending code. `resend_after_s` is 0 here (a minute has passed
 * since the send) unless a test is about that wait.
 */
function pending(id: string, over: Record<string, unknown> = {}) {
  return {
    status: 'pending',
    pending_id: id,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    expires_in_s: 600,
    code_length: 6,
    attempts: 0,
    max_attempts: 5,
    resend_after_s: 0,
    ...over,
  }
}

const SENT = (email: string) => `We sent a 6-digit code to ${email}. It expires in 10 minutes.`
const RECOVER_SENT = (email: string, handle?: string) =>
  handle
    ? `If @${handle} is registered with ${email}, we sent a 6-digit code there. It expires in 10 minutes.`
    : `If an agent is registered with ${email}, we sent a 6-digit code there. It expires in 10 minutes.`

const codeSent = (kind: Kind, id: string, message: string) =>
  json(200, { message, version: 1, flow: kind, next_step: verifyStep(kind), ...pending(id) })

const flowError = (status: number, code: string, message: string, details: Record<string, unknown>, headers: Record<string, string> = {}) =>
  json(status, { code, message, details: { version: 1, ...details } }, headers)

const wrongCode = (kind: Kind, id: string, attempts: number) =>
  flowError(400, 'INVALID_CODE', "That code didn't work. Check the code and try again.", {
    flow: kind,
    next_step: verifyStep(kind),
    ...pending(id, { attempts }),
    param: 'code',
  })

const registered = (handle: string, apiKey: string) =>
  json(201, {
    agent: { handle, email: 'alice@example.com' },
    api_key: apiKey,
    message: `Email verified. Logged in as @${handle}.`,
    version: 1,
    flow: 'register',
    next_step: 'done',
    status: 'approved',
  })

const recovered = (handle: string, apiKey: string) =>
  json(200, {
    handle,
    api_key: apiKey,
    message: `Email verified. Logged in as @${handle}. Your old API key no longer works.`,
    version: 1,
    flow: 'recover',
    next_step: 'done',
    status: 'approved',
  })

const me = (handle: string) => json(200, { handle, email_masked: 'a****@example.com' })
const unauthorized = () => json(401, { code: 'UNAUTHORIZED', message: 'Invalid API key' })

// ─── Fixtures ───────────────────────────────────────────────────────────────

const wizardWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-openclaw-wizard-'))
afterAll(() => fs.rmSync(wizardWorkspace, { recursive: true, force: true }))

beforeEach(() => {
  delete process.env.AGENTCHAT_API_KEY
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete process.env.AGENTCHAT_API_KEY
})

const emptyCfg = {
  agents: { defaults: { workspace: wizardWorkspace } },
} as never
/** Not configured, pointed at the scripted server. */
const freshCfg = applyAgentchatAccountPatch(emptyCfg, 'default', { apiBase: API }) as never
const configuredCfg = applyAgentchatAccountPatch(emptyCfg, 'default', {
  apiKey: KEY_PASTED,
  agentHandle: 'alice',
}) as never
const configuredHereCfg = applyAgentchatAccountPatch(configuredCfg, 'default', { apiBase: API }) as never

function prepare(cfg: unknown, prompter: unknown, credentialValues: Record<string, string> = {}) {
  return agentchatSetupWizard.prepare!({ cfg, accountId: 'default', credentialValues, prompter } as never)
}

type Prepared = { cfg: unknown; credentialValues: Record<string, string> }
/** A config field; `apiKey` is the key the account runs with — read from the key file the config names. */
const field = (result: unknown, name: 'apiKey' | 'agentHandle' | 'apiBase') =>
  name === 'apiKey' ? readAgentchatApiKey((result as Prepared).cfg as never, 'default') : readAgentchatConfigField((result as Prepared).cfg as never, 'default', name)
/** The config never holds the key itself: only the path of its owner-only key file. */
function expectKeyFileOnly(cfg: unknown, apiKey: string): void {
  expect(readAgentchatConfigField(cfg as never, 'default', 'apiKey')).toBeUndefined()
  const file = readAgentchatConfigField(cfg as never, 'default', 'apiKeyFile')
  expect(file).toBe(apiKeyFilePathFor('default', apiKey))
  expect(JSON.stringify(cfg)).not.toContain(apiKey)
  if (process.platform !== 'win32') expect(fs.statSync(file!).mode & 0o777).toBe(0o600)
}

/** The register prompts before the first call: menu, intro, email, handle, display name. */
const registerOpening = (email = 'alice@example.com', handle = 'alice', displayName = ''): Scripted[] => [
  { kind: 'select', contains: 'How would you like to configure', value: 'register' },
  { kind: 'note', contains: 'AgentChat: register a new agent' },
  { kind: 'text', contains: 'Email address', value: email },
  { kind: 'text', contains: 'Handle (your @name on AgentChat)', value: handle },
  { kind: 'text', contains: 'Display name', value: displayName },
]

const serverNote = (message: string): Scripted => ({ kind: 'note', exact: `AgentChat\n${message}` })
const fellBack = (what: 'Registration' | 'Recovery'): Scripted => ({
  kind: 'note',
  exact: `Falling back to credential entry\n${what} was not completed. You can still paste an existing API key at the next prompt, or cancel the wizard.`,
})

// ─── prepare: dispatch and change-base ──────────────────────────────────────

describe('agentchatSetupWizard.prepare — dispatch', () => {
  it('shows the register-or-paste menu when no key is configured', async () => {
    const s = scripted([
      {
        kind: 'select',
        contains: 'How would you like to configure',
        value: 'paste',
        options: ['Register a new agent (email code)', 'I already have an API key', 'Recover a lost API key (email code)'],
      },
    ])
    expect(await prepare(emptyCfg, s.prompter)).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('shows the edit menu when already configured and the user keeps it', async () => {
    const s = scripted([{ kind: 'select', contains: 'already configured', value: 'keep' }])
    expect(await prepare(configuredCfg, s.prompter, { token: KEY_PASTED })).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('falls through to the register-or-paste menu when the user picks replace-key', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'replace-key' },
      { kind: 'select', contains: 'How would you like to configure', value: 'paste' },
    ])
    expect(await prepare(configuredCfg, s.prompter, { token: KEY_PASTED })).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })
})

describe('agentchatSetupWizard.prepare — change-base flow', () => {
  it('writes the new apiBase to cfg', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'change-base' },
      { kind: 'text', contains: 'New API base URL', value: 'https://staging.agentchat.me' },
      { kind: 'note', contains: 'API base set to https://staging.agentchat.me' },
    ])
    const result = await prepare(configuredCfg, s.prompter, { token: KEY_PASTED })
    expect(field(result, 'apiBase')).toBe('https://staging.agentchat.me')
    expect(s.remaining()).toBe(0)
  })

  it('resets the apiBase to the schema default when the input is blank', async () => {
    const withCustomBase = applyAgentchatAccountPatch(configuredCfg, 'default', { apiBase: 'https://staging.agentchat.me' })
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'change-base' },
      { kind: 'text', contains: 'New API base URL', value: '' },
      { kind: 'note', contains: 'reset to default' },
    ])
    const result = await prepare(withCustomBase, s.prompter, { token: KEY_PASTED })
    expect(field(result, 'apiBase')).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('rejects an obviously malformed URL at the validate step', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'change-base' },
      { kind: 'text', contains: 'New API base URL', value: 'not-a-url' },
    ])
    await expect(prepare(configuredCfg, s.prompter, { token: KEY_PASTED })).rejects.toThrow(/Not a valid URL/)
  })

  it('rejects non-http(s) protocols at the validate step', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'change-base' },
      { kind: 'text', contains: 'New API base URL', value: 'ftp://example.com' },
    ])
    await expect(prepare(configuredCfg, s.prompter, { token: KEY_PASTED })).rejects.toThrow(/http:\/\/ or https:\/\//)
  })
})

// ─── Register ───────────────────────────────────────────────────────────────

describe('agentchatSetupWizard.prepare — register', () => {
  it('a wrong code, then the right one, in one run: the key and the server’s handle are saved', async () => {
    const api = server([codeSent('register', 'pnd_1', SENT('alice@example.com')), wrongCode('register', 'pnd_1', 1), registered('alice', KEY_REGISTERED)])
    const s = scripted([
      ...registerOpening('alice@example.com', 'alice', 'Alice'),
      serverNote('We sent a 6-digit code to alice@example.com. It expires in 10 minutes.'),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '000000' },
      serverNote("That code didn't work. Check the code and try again."),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '123456' },
      serverNote('Email verified. Logged in as @alice.'),
      { kind: 'note', contains: 'AgentChat account created' },
    ])

    const result = await prepare(freshCfg, s.prompter)

    expect(field(result, 'apiKey')).toBe(KEY_REGISTERED)
    // Stored at once — AgentChat issues a key once — in its own owner-only file; the config names the file (T6-F09).
    expectKeyFileOnly((result as Prepared).cfg, KEY_REGISTERED)
    expect(field(result, 'agentHandle')).toBe('alice')
    expect((result as Prepared).credentialValues).toEqual({ token: KEY_REGISTERED, _agentchatJustRegistered: '1' })
    expect(api.seen.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /v1/register', 'POST /v1/register/verify', 'POST /v1/register/verify'])
    expect(api.seen[0]!.body).toEqual({ email: 'alice@example.com', handle: 'alice', display_name: 'Alice' })
    expect(api.seen[1]!.body).toEqual({ pending_id: 'pnd_1', code: '000000' })
    expect(api.seen[2]!.body).toEqual({ pending_id: 'pnd_1', code: '123456' })
    // Every call announces the plugin, and runs under a spinner.
    for (const r of api.seen) {
      expect(r.headers.get('x-agentchat-client')).toBe('openclaw')
      expect(r.headers.get('x-agentchat-client-version')).toBe(PACKAGE_VERSION)
    }
    expect(s.progress.filter((p) => p === 'Contacting AgentChat…')).toHaveLength(3)
    expect(s.remaining()).toBe(0)
  })

  it('a new code asked for at the code prompt (blank → Send a new code) goes to the same email; the new pending code is the one verified', async () => {
    const api = server([
      codeSent('register', 'pnd_1', SENT('alice@example.com')),
      codeSent('register', 'pnd_2', SENT('alice@example.com')),
      registered('alice', KEY_REGISTERED),
    ])
    const s = scripted([
      ...registerOpening(),
      serverNote(SENT('alice@example.com')),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '' },
      { kind: 'select', contains: 'What would you like to do?', value: 'new_code', options: ['Send a new code', 'Enter the code', 'Cancel'] },
      serverNote(SENT('alice@example.com')),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '654321' },
      serverNote('Email verified. Logged in as @alice.'),
      { kind: 'note', contains: 'AgentChat account created' },
    ])

    const result = await prepare(freshCfg, s.prompter)

    expect(field(result, 'apiKey')).toBe(KEY_REGISTERED)
    expect(api.seen.map((r) => r.path)).toEqual(['/v1/register', '/v1/register', '/v1/register/verify'])
    expect(api.seen[1]!.body).toEqual(api.seen[0]!.body)
    expect(api.seen[2]!.body).toEqual({ pending_id: 'pnd_2', code: '654321' })
    expect(s.remaining()).toBe(0)
  })

  it('an expired code: the server’s sentence, then “Send a new code?”, then the new code', async () => {
    const api = server([
      codeSent('register', 'pnd_1', SENT('alice@example.com')),
      flowError(400, 'EXPIRED', 'That code has expired. Request a new code.', { flow: 'register', next_step: 'register', status: 'expired' }),
      codeSent('register', 'pnd_2', SENT('alice@example.com')),
      registered('alice', KEY_REGISTERED),
    ])
    const s = scripted([
      ...registerOpening(),
      serverNote(SENT('alice@example.com')),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '111111' },
      serverNote('That code has expired. Request a new code.'),
      { kind: 'confirm', contains: 'Send a new code?', value: true },
      serverNote(SENT('alice@example.com')),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '222222' },
      serverNote('Email verified. Logged in as @alice.'),
      { kind: 'note', contains: 'AgentChat account created' },
    ])

    const result = await prepare(freshCfg, s.prompter)

    expect(field(result, 'apiKey')).toBe(KEY_REGISTERED)
    expect(api.seen.map((r) => r.path)).toEqual(['/v1/register', '/v1/register/verify', '/v1/register', '/v1/register/verify'])
    expect(api.seen[3]!.body).toEqual({ pending_id: 'pnd_2', code: '222222' })
    expect(s.remaining()).toBe(0)
  })

  it('cancel at the code prompt saves nothing and hands over to the credential step', async () => {
    const api = server([codeSent('register', 'pnd_1', SENT('alice@example.com'))])
    const s = scripted([
      ...registerOpening(),
      serverNote(SENT('alice@example.com')),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '' },
      { kind: 'select', contains: 'What would you like to do?', value: 'cancel' },
      fellBack('Registration'),
    ])

    expect(await prepare(freshCfg, s.prompter)).toBeUndefined()
    expect(api.seen).toHaveLength(1)
    expect(s.remaining()).toBe(0)
  })

  it('a taken handle re-asks the handle only; the email and display name go again unchanged', async () => {
    const api = server([
      flowError(409, 'HANDLE_TAKEN', 'The handle @alice is taken. Try another.', { flow: 'register', next_step: 'register', param: 'handle' }),
      codeSent('register', 'pnd_1', SENT('alice@example.com')),
      registered('alice2', KEY_REGISTERED),
    ])
    const s = scripted([
      ...registerOpening('alice@example.com', 'alice', 'Alice'),
      serverNote('The handle @alice is taken. Try another.'),
      { kind: 'text', contains: 'Handle (your @name on AgentChat)', value: 'alice2' },
      serverNote(SENT('alice@example.com')),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '123456' },
      serverNote('Email verified. Logged in as @alice2.'),
      { kind: 'note', contains: 'Handle:   @alice2' },
    ])

    const result = await prepare(freshCfg, s.prompter)

    expect(field(result, 'agentHandle')).toBe('alice2')
    expect(api.seen[0]!.body).toEqual({ email: 'alice@example.com', handle: 'alice', display_name: 'Alice' })
    expect(api.seen[1]!.body).toEqual({ email: 'alice@example.com', handle: 'alice2', display_name: 'Alice' })
    expect(s.remaining()).toBe(0)
  })

  it('a handle the server finds malformed is the server’s to explain; no local rule stops it first', async () => {
    const api = server([
      flowError(400, 'VALIDATION_ERROR', 'Enter a handle of 3 to 30 characters: lowercase letters, numbers and hyphens, starting with a letter.', {
        flow: 'register',
        next_step: 'register',
        param: 'handle',
      }),
      codeSent('register', 'pnd_1', SENT('alice@example.com')),
    ])
    const s = scripted([
      ...registerOpening('alice@example.com', 'Not_A_Handle'),
      serverNote('Enter a handle of 3 to 30 characters: lowercase letters, numbers and hyphens, starting with a letter.'),
      { kind: 'text', contains: 'Handle', value: 'alice' },
      serverNote(SENT('alice@example.com')),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '' },
      { kind: 'select', contains: 'What would you like to do?', value: 'cancel' },
      fellBack('Registration'),
    ])

    await prepare(freshCfg, s.prompter)
    expect(api.seen[0]!.body).toMatchObject({ handle: 'Not_A_Handle' })
    expect(api.seen[1]!.body).toMatchObject({ handle: 'alice' })
    expect(s.remaining()).toBe(0)
  })

  it('an email at its limit re-asks the email only, with the server’s sentence (its number, not ours)', async () => {
    const api = server([
      flowError(409, 'EMAIL_LIMIT_REACHED', 'This email address already has 10 active agents, the most allowed. Use a different email address.', {
        limit: 10,
        flow: 'register',
        next_step: 'register',
        param: 'email',
      }),
      codeSent('register', 'pnd_1', SENT('alice+bot2@example.com')),
      registered('alice', KEY_REGISTERED),
    ])
    const s = scripted([
      ...registerOpening(),
      serverNote('This email address already has 10 active agents, the most allowed. Use a different email address.'),
      { kind: 'text', contains: 'Email address', value: 'alice+bot2@example.com' },
      serverNote(SENT('alice+bot2@example.com')),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '123456' },
      serverNote('Email verified. Logged in as @alice.'),
      { kind: 'note', contains: 'AgentChat account created' },
    ])

    const result = await prepare(freshCfg, s.prompter)

    expect(field(result, 'apiKey')).toBe(KEY_REGISTERED)
    expect(api.seen[1]!.body).toEqual({ email: 'alice+bot2@example.com', handle: 'alice' })
    expect(s.remaining()).toBe(0)
  })

  it('sits out a Retry-After wait under a countdown, then repeats the call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const api = server([
      flowError(
        429,
        'OTP_COOLDOWN',
        'You can request a new code in 5 seconds.',
        { flow: 'register', next_step: 'register', retry_after_s: 5 },
        { 'Retry-After': '5' },
      ),
      codeSent('register', 'pnd_1', SENT('alice@example.com')),
    ])
    const s = scripted([
      ...registerOpening(),
      serverNote('You can request a new code in 5 seconds.'),
      serverNote(SENT('alice@example.com')),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '' },
      { kind: 'select', contains: 'What would you like to do?', value: 'cancel' },
      fellBack('Registration'),
    ])

    const done = prepare(freshCfg, s.prompter)
    await vi.runAllTimersAsync()
    expect(await done).toBeUndefined()

    expect(api.seen.map((r) => r.path)).toEqual(['/v1/register', '/v1/register'])
    expect(api.seen[1]!.at - api.seen[0]!.at).toBeGreaterThanOrEqual(5_000)
    expect(s.progress).toEqual(expect.arrayContaining(['Waiting 5 s…', 'Waiting 1 s…']))
    expect(s.remaining()).toBe(0)
  })

  it('stops on the server’s word (a 5xx): its sentence, then the credential step', async () => {
    const api = server([
      flowError(500, 'OTP_FAILED', "We couldn't send the code. Try again in a few minutes.", { flow: 'register', next_step: 'register' }),
    ])
    const s = scripted([...registerOpening(), serverNote("We couldn't send the code. Try again in a few minutes."), fellBack('Registration')])

    expect(await prepare(freshCfg, s.prompter)).toBeUndefined()
    expect(api.seen).toHaveLength(1) // never retried: a retry would send a second email
    expect(s.remaining()).toBe(0)
  })

  it('AgentChat unreachable: says so and hands over to the credential step', async () => {
    server([new TypeError('fetch failed')])
    const s = scripted([
      ...registerOpening(),
      { kind: 'note', contains: 'Could not reach AgentChat\nfetch failed' },
      fellBack('Registration'),
    ])

    expect(await prepare(freshCfg, s.prompter)).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })
})

// ─── Recover ────────────────────────────────────────────────────────────────

describe('agentchatSetupWizard.prepare — recover', () => {
  it('HANDLE_REQUIRED: the server lists the handles, the person picks one, a second code, and the server’s handle is saved', async () => {
    const api = server([
      codeSent('recover', 'pnd_r1', RECOVER_SENT('alice@example.com')),
      flowError(409, 'HANDLE_REQUIRED', 'More than one agent uses this email address. Choose the handle to recover.', {
        handles: ['alice', 'alice-codex'],
        flow: 'recover',
        next_step: 'recover',
        param: 'handle',
      }),
      codeSent('recover', 'pnd_r2', RECOVER_SENT('alice@example.com', 'alice-codex')),
      recovered('alice-codex', KEY_RECOVERED),
    ])
    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'AgentChat: recover a lost API key' },
      // Nothing configured: no handle is asked up front; the server asks when it needs one.
      { kind: 'text', contains: 'Email address', value: 'alice@example.com' },
      serverNote('If an agent is registered with alice@example.com, we sent a 6-digit code there. It expires in 10 minutes.'),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '123456' },
      serverNote('More than one agent uses this email address. Choose the handle to recover.'),
      { kind: 'select', contains: 'Handle', value: 'alice-codex', options: ['@alice', '@alice-codex', 'Another handle'] },
      serverNote('If @alice-codex is registered with alice@example.com, we sent a 6-digit code there. It expires in 10 minutes.'),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '654321' },
      serverNote('Email verified. Logged in as @alice-codex. Your old API key no longer works.'),
      { kind: 'note', contains: 'AgentChat API key recovered\nHandle:   @alice-codex' },
    ])

    const result = await prepare(freshCfg, s.prompter)

    expect(field(result, 'apiKey')).toBe(KEY_RECOVERED)
    expect(field(result, 'agentHandle')).toBe('alice-codex')
    expect((result as Prepared).credentialValues).toEqual({ token: KEY_RECOVERED, _agentchatJustRegistered: '1' })
    expect(api.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v1/agents/recover',
      'POST /v1/agents/recover/verify',
      'POST /v1/agents/recover',
      'POST /v1/agents/recover/verify',
    ])
    expect(api.seen[0]!.body).toEqual({ email: 'alice@example.com' })
    expect(api.seen[2]!.body).toEqual({ email: 'alice@example.com', handle: 'alice-codex' })
    expect(api.seen[3]!.body).toEqual({ pending_id: 'pnd_r2', code: '654321' })
    expect(s.remaining()).toBe(0)
  })

  it('pre-fills the configured handle and sends it; the old key is replaced by the one the server returned', async () => {
    const api = server([codeSent('recover', 'pnd_r1', RECOVER_SENT('alice@example.com', 'alice')), recovered('alice', KEY_RECOVERED)])
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'replace-key' },
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: '@alice is configured here — press Enter at the handle prompt to recover it.' },
      { kind: 'text', contains: 'Handle', value: 'alice', initialValue: 'alice' },
      { kind: 'text', contains: 'Email address', value: 'alice@example.com' },
      serverNote(RECOVER_SENT('alice@example.com', 'alice')),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '123456' },
      serverNote('Email verified. Logged in as @alice. Your old API key no longer works.'),
      { kind: 'note', contains: 'AgentChat API key recovered' },
    ])

    const result = await prepare(configuredHereCfg, s.prompter, { token: KEY_PASTED })

    expect(api.seen[0]!.body).toEqual({ email: 'alice@example.com', handle: 'alice' })
    expect(field(result, 'apiKey')).toBe(KEY_RECOVERED)
    expect(s.remaining()).toBe(0)
  })

  it('a wrong code on recovery is re-asked from the server’s answer, with no local attempt cap', async () => {
    const answers: Array<Response | Error> = [codeSent('recover', 'pnd_r1', RECOVER_SENT('alice@example.com'))]
    const steps: Scripted[] = [
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'AgentChat: recover a lost API key' },
      { kind: 'text', contains: 'Email address', value: 'alice@example.com' },
      serverNote(RECOVER_SENT('alice@example.com')),
    ]
    // Four wrong codes: more than any cap the wizard used to keep; the server's is the only one.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      answers.push(wrongCode('recover', 'pnd_r1', attempt))
      steps.push({ kind: 'text', contains: 'Enter the 6-digit code', value: `00000${attempt}` }, serverNote("That code didn't work. Check the code and try again."))
    }
    answers.push(recovered('alice', KEY_RECOVERED))
    steps.push(
      { kind: 'text', contains: 'Enter the 6-digit code', value: '123456' },
      serverNote('Email verified. Logged in as @alice. Your old API key no longer works.'),
      { kind: 'note', contains: 'AgentChat API key recovered' },
    )
    const api = server(answers)
    const s = scripted(steps)

    const result = await prepare(freshCfg, s.prompter)
    expect(field(result, 'apiKey')).toBe(KEY_RECOVERED)
    expect(api.left()).toBe(0)
    expect(s.remaining()).toBe(0)
  })

  it('the code gone after too many wrong tries: the server’s sentence, “Send a new code?” → No ends the flow', async () => {
    const api = server([
      codeSent('recover', 'pnd_r1', RECOVER_SENT('alice@example.com')),
      flowError(429, 'OTP_ATTEMPTS_EXHAUSTED', 'You entered the wrong code too many times. Request a new code.', {
        flow: 'recover',
        next_step: 'recover',
        status: 'max_attempts_reached',
        attempts: 5,
        max_attempts: 5,
        resend_after_s: 0,
      }),
    ])
    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'AgentChat: recover a lost API key' },
      { kind: 'text', contains: 'Email address', value: 'alice@example.com' },
      serverNote(RECOVER_SENT('alice@example.com')),
      { kind: 'text', contains: 'Enter the 6-digit code', value: '000005' },
      serverNote('You entered the wrong code too many times. Request a new code.'),
      { kind: 'confirm', contains: 'Send a new code?', value: false },
      fellBack('Recovery'),
    ])

    expect(await prepare(freshCfg, s.prompter)).toBeUndefined()
    expect(api.seen).toHaveLength(2)
    expect(s.remaining()).toBe(0)
  })
})

// ─── The credential step: a key the person has ──────────────────────────────

describe('agentchatSetupWizard.credentials — a key is checked before it is saved', () => {
  const credential = agentchatSetupWizard.credentials[0]!

  it('a pasted key AgentChat accepts is saved with the handle it belongs to', async () => {
    const api = server([me('alice')])
    const cfg = (await credential.applySet!({ cfg: freshCfg, accountId: 'default', credentialValues: {}, value: KEY_PASTED, resolvedValue: KEY_PASTED })) as never
    expect(readAgentchatApiKey(cfg, 'default')).toBe(KEY_PASTED)
    expectKeyFileOnly(cfg, KEY_PASTED)
    expect(readAgentchatConfigField(cfg, 'default', 'agentHandle')).toBe('alice')
    expect((cfg as { mcp: { servers: { agentchat: { url: string } } } }).mcp.servers.agentchat.url).toBe(`${API}/mcp`)
    expect(api.seen.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/agents/me'])
    expect(api.seen[0]!.headers.get('authorization')).toBe(`Bearer ${KEY_PASTED}`)
  })

  it('a pasted key AgentChat turns away is never saved: the configured key stays; finalize shows the server’s answer', async () => {
    server([unauthorized(), unauthorized()])
    const before = applyAgentchatAccountPatch(freshCfg, 'default', { apiKey: KEY_EXISTING, agentHandle: 'alice' })
    const after = await credential.applySet!({ cfg: before, accountId: 'default', credentialValues: {}, value: KEY_BAD, resolvedValue: KEY_BAD })
    expect(after).toBe(before)
    expect(readAgentchatConfigField(after, 'default', 'apiKey')).toBe(KEY_EXISTING)

    const s = scripted([
      {
        kind: 'note',
        exact:
          'AgentChat API key not accepted\nInvalid API key\n\nThe key was not saved. Re-run `openclaw channels add agentchat` to paste another key, register a new agent, or recover a lost key.',
      },
    ])
    const result = await agentchatSetupWizard.finalize!({ cfg: after, accountId: 'default', credentialValues: { token: KEY_BAD }, prompter: s.prompter } as never)
    expect(result).toBeUndefined()
    const dotenv = path.join(process.env.OPENCLAW_STATE_DIR!, '.env')
    if (fs.existsSync(dotenv)) expect(fs.readFileSync(dotenv, 'utf8')).not.toContain(KEY_BAD)
    expect(s.remaining()).toBe(0)
  })

  it('a pasted key while AgentChat is unreachable is saved for the runtime to try, without the old key’s handle', async () => {
    server([new TypeError('fetch failed')])
    const before = applyAgentchatAccountPatch(freshCfg, 'default', { apiKey: KEY_EXISTING, agentHandle: 'alice' })
    const after = (await credential.applySet!({ cfg: before, accountId: 'default', credentialValues: {}, value: KEY_PASTED, resolvedValue: KEY_PASTED })) as never
    expect(readAgentchatApiKey(after, 'default')).toBe(KEY_PASTED)
    expectKeyFileOnly(after, KEY_PASTED)
    expect(readAgentchatConfigField(after, 'default', 'agentHandle')).toBeUndefined()
  })

  it('a 5xx is no verdict on the key: it is saved for the runtime to try, never refused', async () => {
    server([json(503, { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' })])
    const after = (await credential.applySet!({ cfg: freshCfg, accountId: 'default', credentialValues: {}, value: KEY_PASTED, resolvedValue: KEY_PASTED })) as never
    expect(readAgentchatApiKey(after, 'default')).toBe(KEY_PASTED)
  })

  it('the key in AGENTCHAT_API_KEY ("Use it?" → yes) is checked and saved the same way; a turned-away one is not', async () => {
    process.env.AGENTCHAT_API_KEY = KEY_PASTED
    server([me('alice'), unauthorized()])
    const accepted = (await credential.applyUseEnv!({ cfg: freshCfg, accountId: 'default' })) as never
    expect(readAgentchatApiKey(accepted, 'default')).toBe(KEY_PASTED)
    expectKeyFileOnly(accepted, KEY_PASTED)
    expect(readAgentchatConfigField(accepted, 'default', 'agentHandle')).toBe('alice')

    const rejected = await credential.applyUseEnv!({ cfg: freshCfg, accountId: 'default' })
    expect(rejected).toBe(freshCfg)
  })

  it('the credential step is skipped after register / recover saved a key', async () => {
    expect(await credential.shouldPrompt!({ cfg: freshCfg, accountId: 'default', credentialValues: { _agentchatJustRegistered: '1' }, state: {} } as never)).toBe(false)
    expect(await credential.shouldPrompt!({ cfg: freshCfg, accountId: 'default', credentialValues: {}, state: {} } as never)).toBe(true)
  })
})

// ─── finalize ───────────────────────────────────────────────────────────────

describe('agentchatSetupWizard.finalize', () => {
  it('places the integration for the handle the server returned', async () => {
    const api = server([me('alice')])
    const s = scripted([{ kind: 'note', contains: 'AgentChat integration placed' }])

    const result = await agentchatSetupWizard.finalize!({
      cfg: applyAgentchatAccountPatch(freshCfg, 'default', { apiKey: KEY_PASTED }) as never,
      accountId: 'default',
      credentialValues: { token: KEY_PASTED },
      prompter: s.prompter as never,
    } as never)

    expect(api.seen.map((r) => r.path)).toEqual(['/v1/agents/me'])
    const patched = (result as { cfg: { mcp?: { servers?: Record<string, unknown> } } }).cfg
    expect(readAgentchatConfigField(patched as never, 'default', 'agentHandle')).toBe('alice')
    // Placement: the hosted tools are registered as a bearer TEMPLATE on the
    // env var — never the key itself.
    const entry = patched.mcp?.servers?.agentchat as { url: string; transport: string; headers: { Authorization: string } }
    expect(entry.url).toBe(`${API}/mcp`)
    expect(entry.transport).toBe('streamable-http')
    expect(entry.headers.Authorization).toBe('Bearer ${AGENTCHAT_API_KEY}')
    expect(JSON.stringify(entry)).not.toContain(KEY_PASTED)
    // Placement: the served identity line landed in the workspace AGENTS.md.
    const agents = fs.readFileSync(path.join(wizardWorkspace, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('I am @alice on AgentChat (api.agentchat.me).')
    // Placement: the key landed in the (test-redirected) OpenClaw state-dir .env.
    const dotenv = fs.readFileSync(path.join(process.env.OPENCLAW_STATE_DIR!, '.env'), 'utf8')
    expect(dotenv).toContain(`AGENTCHAT_API_KEY=${KEY_PASTED}`)
    expect(s.progress).toContain('Checking the API key with AgentChat…')
    expect(s.remaining()).toBe(0)
  })

  it('a configured key AgentChat no longer accepts ("keep") is reported and left as it is', async () => {
    server([unauthorized()])
    const s = scripted([
      {
        kind: 'note',
        exact:
          'AgentChat API key not accepted\nInvalid API key\n\nThis key is the one in your OpenClaw config. Re-run `openclaw channels add agentchat` → Replace the API key to recover a lost key or paste another one.',
      },
    ])
    const result = await agentchatSetupWizard.finalize!({
      cfg: applyAgentchatAccountPatch(freshCfg, 'default', { apiKey: KEY_BAD }) as never,
      accountId: 'default',
      credentialValues: { token: KEY_BAD },
      prompter: s.prompter as never,
    } as never)
    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('AgentChat unreachable: the saved config stays, the runtime retries', async () => {
    server([new TypeError('fetch failed')])
    const s = scripted([{ kind: 'note', exact: 'AgentChat API unreachable\nfetch failed\n\nThe config was saved — the runtime will retry on startup.' }])
    const result = await agentchatSetupWizard.finalize!({
      cfg: applyAgentchatAccountPatch(freshCfg, 'default', { apiKey: KEY_PASTED }) as never,
      accountId: 'default',
      credentialValues: { token: KEY_PASTED },
      prompter: s.prompter as never,
    } as never)
    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('is a no-op when no API key is present in cfg or credentialValues', async () => {
    const api = server([])
    const s = scripted([])
    const result = await agentchatSetupWizard.finalize!({ cfg: emptyCfg, accountId: 'default', credentialValues: {}, prompter: s.prompter as never } as never)
    expect(result).toBeUndefined()
    expect(api.seen).toHaveLength(0)
  })

  it('disable strips our mcp.servers.agentchat entry (config only), keeps a hand-written one', () => {
    const cfg = {
      ...(configuredCfg as object),
      mcp: {
        servers: {
          agentchat: { url: 'https://api.agentchat.me/mcp', transport: 'streamable-http', headers: { Authorization: 'Bearer ${AGENTCHAT_API_KEY}' } },
          other: { url: 'https://example.invalid/mcp', transport: 'streamable-http' },
        },
      },
    }
    const disabled = agentchatSetupWizard.disable!(cfg as never) as { mcp: { servers: Record<string, unknown> }; channels: { agentchat: { enabled: boolean } } }
    expect(disabled.mcp.servers.agentchat).toBeUndefined()
    expect(disabled.mcp.servers.other).toBeDefined()
    expect(disabled.channels.agentchat.enabled).toBe(false)

    const hand = { ...(configuredCfg as object), mcp: { servers: { agentchat: { url: 'https://my.proxy/mcp', transport: 'streamable-http' } } } }
    const kept = agentchatSetupWizard.disable!(hand as never) as { mcp: { servers: Record<string, unknown> } }
    expect(kept.mcp.servers.agentchat).toEqual({ url: 'https://my.proxy/mcp', transport: 'streamable-http' })
  })
})

// ─── status, config patch ───────────────────────────────────────────────────

describe('agentchatSetupWizard.status', () => {
  it('reports "not configured" with a hint when no key is present', async () => {
    const status = agentchatSetupWizard.status!
    expect(status.resolveConfigured({ cfg: emptyCfg, accountId: 'default' } as never)).toBe(false)
    const lines = await status.resolveStatusLines!({ cfg: emptyCfg, accountId: 'default', configured: false } as never)
    expect(lines.join(' ')).toMatch(/not configured/)
    // The hint must advertise all three entry points, recovery included.
    expect(lines.join(' ')).toMatch(/recover a lost one/)
  })

  it('reports "configured (@handle)" when both key and handle are present', async () => {
    const status = agentchatSetupWizard.status!
    expect(status.resolveConfigured({ cfg: configuredCfg, accountId: 'default' } as never)).toBe(true)
    const lines = await status.resolveStatusLines!({ cfg: configuredCfg, accountId: 'default', configured: true } as never)
    expect(lines.join(' ')).toMatch(/configured \(@alice\)/)
    expect(lines.join(' ')).not.toMatch(/disabled/)
  })

  it('a disabled account names `openclaw config set channels.agentchat.enabled true`, never channels add', async () => {
    const status = agentchatSetupWizard.status!
    const disabledCfg = applyAgentchatAccountPatch(configuredCfg, 'default', { enabled: false })
    const lines = await status.resolveStatusLines!({ cfg: disabledCfg, accountId: 'default', configured: true } as never)
    expect(lines.join(' ')).toMatch(/configured \(@alice\); the account is disabled — re-enable it with `openclaw config set channels\.agentchat\.enabled true`/)
    expect(lines.join(' ')).not.toMatch(/run openclaw channels add/)
  })
})

describe('applyAgentchatAccountPatch', () => {
  it('writes to the flat channels.agentchat.* shape for the default account', () => {
    const patched = applyAgentchatAccountPatch(emptyCfg, 'default', { apiKey: KEY_PASTED, agentHandle: 'alice' })
    expect(readAgentchatConfigField(patched, 'default', 'apiKey')).toBe(KEY_PASTED)
    expect(readAgentchatConfigField(patched, 'default', 'agentHandle')).toBe('alice')
  })

  it('writes to the accounts-map shape for a non-default account id', () => {
    const patched = applyAgentchatAccountPatch(emptyCfg, 'staging', { apiKey: KEY_STAGING, apiBase: 'https://staging.agentchat.me' })
    expect(readAgentchatConfigField(patched, 'staging', 'apiKey')).toBe(KEY_STAGING)
    expect(readAgentchatConfigField(patched, 'staging', 'apiBase')).toBe('https://staging.agentchat.me')
    // Does not leak into the default account.
    expect(readAgentchatConfigField(patched, 'default', 'apiKey')).toBeUndefined()
  })

  it('treats an undefined field value as a removal', () => {
    const seeded = applyAgentchatAccountPatch(emptyCfg, 'default', { apiKey: KEY_PASTED, apiBase: 'https://staging.agentchat.me' })
    const patched = applyAgentchatAccountPatch(seeded, 'default', { apiBase: undefined })
    expect(readAgentchatConfigField(patched, 'default', 'apiBase')).toBeUndefined()
    expect(readAgentchatConfigField(patched, 'default', 'apiKey')).toBe(KEY_PASTED)
  })
})
