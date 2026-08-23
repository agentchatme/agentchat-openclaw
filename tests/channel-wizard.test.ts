/**
 * Tests for the interactive channel setup wizard (`channel.wizard.ts`).
 *
 * The WizardPrompter interface is replaced by a `scriptedPrompter` that
 * consumes an ordered list of expected prompts (`note`, `select`, `text`,
 * `confirm`, `progress`). Any deviation — wrong prompt kind, scripted value
 * rejected by the prompt's `validate`, surplus or missing steps — fails
 * the test. This pins the wizard's control flow end-to-end without needing
 * a real TTY.
 *
 * Coverage:
 *   - `prepare` dispatch: register / paste / recover menu when unconfigured,
 *     edit menu (keep / change-base / replace-key) when re-run against
 *     an already-configured account.
 *   - The change-base flow: accepts a valid URL, rejects invalid input
 *     at the validate step, resets to default when blank.
 *   - `runRegisterFlow` happy path (email → handle → OTP → minted key)
 *     and the key retryable start-errors (handle-taken, the per-email
 *     policy branch with its retry / recover / paste / cancel choices,
 *     quoting the server's `details.limit` and falling back to the server
 *     message for a legacy EMAIL_TAKEN).
 *   - `runRecoverFlow`: always sends handle + email; the handle defaults to
 *     the configured `agentHandle`; OTP retry; every terminal failure
 *     (rate-limited start, legacy no-pending_id start, expired, too many
 *     codes, HANDLE_REQUIRED listing the sibling handles) ends with the
 *     fall-back-to-paste note and no cfg change.
 *   - `finalize` validation against the live `/v1/agents/me` probe —
 *     success path captures the handle; failure path notes the warning
 *     without throwing so the config still persists.
 *   - `status.resolveStatusLines` for both configured and unconfigured.
 *
 * setup-client is stubbed via `vi.mock` so the server responses are under
 * test control.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

vi.mock('../src/setup-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/setup-client.js')>()
  return {
    ...actual,
    validateApiKey: vi.fn(),
    registerAgentStart: vi.fn(),
    registerAgentVerify: vi.fn(),
    recoverAgentStart: vi.fn(),
    recoverAgentVerify: vi.fn(),
  }
})

import {
  recoverAgentStart,
  recoverAgentVerify,
  registerAgentStart,
  registerAgentVerify,
  validateApiKey,
} from '../src/setup-client.js'
import { agentchatSetupWizard } from '../src/channel.wizard.js'
import {
  applyAgentchatAccountPatch,
  readAgentchatConfigField,
} from '../src/channel-account.js'

type Scripted =
  | { kind: 'note'; contains?: string }
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
  | { kind: 'select'; contains?: string; value: unknown }
  | { kind: 'confirm'; contains?: string; value: boolean }
  | { kind: 'progress' }

function scripted(steps: Scripted[]) {
  const queue = [...steps]
  const consumed: Scripted[] = []
  const take = <K extends Scripted['kind']>(
    expected: K,
    actualMessage: string,
  ): Extract<Scripted, { kind: K }> => {
    const head = queue.shift()
    if (!head) {
      throw new Error(
        `Wizard asked for ${expected} ("${actualMessage}") but the script is exhausted after ${consumed.length} steps`,
      )
    }
    if (head.kind !== expected) {
      throw new Error(
        `Wizard asked for ${expected} ("${actualMessage}"); script expected ${head.kind}`,
      )
    }
    if ('contains' in head && head.contains && !actualMessage.includes(head.contains)) {
      throw new Error(
        `Wizard asked ${expected} with message "${actualMessage}"; script expected contains "${head.contains}"`,
      )
    }
    consumed.push(head)
    return head as Extract<Scripted, { kind: K }>
  }
  const prompter = {
    intro: async () => {
      /* no-op — OpenClaw's setup driver handles intro/outro at a higher level */
    },
    outro: async () => {
      /* no-op */
    },
    note: async (message: string, title?: string) => {
      take('note', `${title ?? ''}\n${message}`)
    },
    text: async (params: {
      message: string
      initialValue?: string
      validate?: (v: string) => string | undefined
    }) => {
      const entry = take('text', params.message)
      if ('initialValue' in entry) {
        const expected = entry.initialValue ?? undefined
        if (params.initialValue !== expected) {
          throw new Error(
            `text prompt "${params.message}" had initialValue ${JSON.stringify(params.initialValue)}; script expected ${JSON.stringify(expected)}`,
          )
        }
      }
      if (params.validate) {
        const err = params.validate(entry.value)
        if (err) {
          throw new Error(
            `scripted value "${entry.value}" rejected by validate for "${params.message}": ${err}`,
          )
        }
      }
      return entry.value
    },
    select: async (params: { message: string }) => {
      const entry = take('select', params.message)
      return entry.value as never
    },
    confirm: async (params: { message: string }) => {
      const entry = take('confirm', params.message)
      return entry.value
    },
    multiselect: async () => {
      throw new Error('multiselect not mocked in wizard tests')
    },
    progress: (_label: string) => {
      take('progress', _label)
      return { update: () => undefined, stop: () => undefined }
    },
  }
  return {
    prompter,
    remaining: () => queue.length,
    consumed: () => consumed,
  }
}

const vMock = validateApiKey as unknown as ReturnType<typeof vi.fn>
const rStart = registerAgentStart as unknown as ReturnType<typeof vi.fn>
const rVerify = registerAgentVerify as unknown as ReturnType<typeof vi.fn>
const recStart = recoverAgentStart as unknown as ReturnType<typeof vi.fn>
const recVerify = recoverAgentVerify as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vMock.mockReset()
  rStart.mockReset()
  rVerify.mockReset()
  recStart.mockReset()
  recVerify.mockReset()
})

const wizardWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-openclaw-wizard-'))
afterAll(() => fs.rmSync(wizardWorkspace, { recursive: true, force: true }))

const emptyCfg = {
  agents: { defaults: { workspace: wizardWorkspace } },
} as never
const configuredCfg = applyAgentchatAccountPatch(emptyCfg, 'default', {
  apiKey: 'ac_live_abcdef0123456789abcd',
  agentHandle: 'alice',
}) as never

const liveAgent = {
  handle: 'alice',
  displayName: null,
  email: 'a****@agentchat.local',
  createdAt: '2026-04-20T00:00:00Z',
}

describe('agentchatSetupWizard.prepare — dispatch', () => {
  it('shows the register-or-paste menu when no key is configured', async () => {
    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'paste' },
    ])
    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('shows the edit menu when already configured and the user keeps it', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'keep' },
    ])
    const result = await agentchatSetupWizard.prepare!({
      cfg: configuredCfg,
      accountId: 'default',
      credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('falls through to the register-or-paste menu when the user picks replace-key', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'replace-key' },
      { kind: 'select', contains: 'How would you like to configure', value: 'paste' },
    ])
    const result = await agentchatSetupWizard.prepare!({
      cfg: configuredCfg,
      accountId: 'default',
      credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
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
    const result = await agentchatSetupWizard.prepare!({
      cfg: configuredCfg,
      accountId: 'default',
      credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    const patched = (result as { cfg: unknown }).cfg
    expect(readAgentchatConfigField(patched as never, 'default', 'apiBase')).toBe(
      'https://staging.agentchat.me',
    )
    expect(s.remaining()).toBe(0)
  })

  it('resets the apiBase to the schema default when the input is blank', async () => {
    // Seed a custom apiBase first so we can observe the reset.
    const withCustomBase = applyAgentchatAccountPatch(configuredCfg, 'default', {
      apiBase: 'https://staging.agentchat.me',
    })

    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'change-base' },
      { kind: 'text', contains: 'New API base URL', value: '' },
      { kind: 'note', contains: 'reset to default' },
    ])
    const result = await agentchatSetupWizard.prepare!({
      cfg: withCustomBase as never,
      accountId: 'default',
      credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    const patched = (result as { cfg: unknown }).cfg
    expect(readAgentchatConfigField(patched as never, 'default', 'apiBase')).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('rejects an obviously malformed URL at the validate step', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'change-base' },
      { kind: 'text', contains: 'New API base URL', value: 'not-a-url' },
    ])
    await expect(
      agentchatSetupWizard.prepare!({
        cfg: configuredCfg,
        accountId: 'default',
        credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
        prompter: s.prompter as never,
      } as never),
    ).rejects.toThrow(/Not a valid URL/)
  })

  it('rejects non-http(s) protocols at the validate step', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'change-base' },
      { kind: 'text', contains: 'New API base URL', value: 'ftp://example.com' },
    ])
    await expect(
      agentchatSetupWizard.prepare!({
        cfg: configuredCfg,
        accountId: 'default',
        credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
        prompter: s.prompter as never,
      } as never),
    ).rejects.toThrow(/http:\/\/ or https:\/\//)
  })
})

describe('agentchatSetupWizard.prepare — register flow happy path', () => {
  it('registers via OTP and writes the minted key into cfg', async () => {
    rStart.mockResolvedValueOnce({ ok: true, pendingId: 'pnd_1' })
    rVerify.mockResolvedValueOnce({
      ok: true,
      agent: {
        id: 'agt_1',
        handle: 'alice',
        email: 'alice@example.com',
        createdAt: '2026-04-21T00:00:00Z',
      },
      apiKey: 'ac_live_0123456789abcdef0123',
    })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'register' },
      { kind: 'note', contains: 'register a new agent' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'text', contains: 'Choose a handle', value: 'alice' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'progress' },
      { kind: 'text', contains: 'verification code', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat account created' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    const { cfg, credentialValues } = result as {
      cfg: unknown
      credentialValues: Record<string, string>
    }
    expect(readAgentchatConfigField(cfg as never, 'default', 'apiKey')).toBe(
      'ac_live_0123456789abcdef0123',
    )
    expect(readAgentchatConfigField(cfg as never, 'default', 'agentHandle')).toBe('alice')
    expect(credentialValues.token).toBe('ac_live_0123456789abcdef0123')
    expect(s.remaining()).toBe(0)
  })
})

describe('agentchatSetupWizard.prepare — register flow retryable errors', () => {
  it('re-prompts for handle after a handle-taken start error', async () => {
    rStart
      .mockResolvedValueOnce({ ok: false, reason: 'handle-taken' })
      .mockResolvedValueOnce({ ok: true, pendingId: 'pnd_2' })
    rVerify.mockResolvedValueOnce({
      ok: true,
      agent: {
        id: 'agt_2',
        handle: 'alice2',
        email: 'alice@example.com',
        createdAt: '2026-04-21T00:00:00Z',
      },
      apiKey: 'ac_live_fedcba9876543210fedc',
    })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'register' },
      { kind: 'note', contains: 'register a new agent' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'text', contains: 'Choose a handle', value: 'alice' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'progress' },
      { kind: 'note', contains: 'already taken' },
      { kind: 'text', contains: 'Choose a handle', value: 'alice2' },
      { kind: 'progress' },
      { kind: 'text', contains: 'verification code', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat account created' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    expect(rStart).toHaveBeenCalledTimes(2)
    expect(s.remaining()).toBe(0)
  })

  it('quotes the server limit on email-limit-reached and returns user-chose-paste when the user picks "paste"', async () => {
    rStart.mockResolvedValueOnce({
      ok: false,
      reason: 'email-limit-reached',
      status: 409,
      message: 'This email already backs 10 active agents. Delete one, or register with a different email.',
      limit: 10,
    })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'register' },
      { kind: 'note', contains: 'register a new agent' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'text', contains: 'Choose a handle', value: 'alice' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'progress' },
      // The number comes from `details.limit`, never from a constant.
      { kind: 'select', contains: 'alice@example.com already backs 10 active agents', value: 'paste' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    // When the user chose paste, prepare returns undefined (no cfg change)
    // and the framework's credential prompt fires on the next step.
    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('falls back to the server message for a legacy EMAIL_TAKEN (no limit) rejection', async () => {
    rStart.mockResolvedValueOnce({
      ok: false,
      reason: 'email-limit-reached',
      status: 409,
      message: 'An account is already registered with this email. Delete it first to create a new one.',
    })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'register' },
      { kind: 'note', contains: 'register a new agent' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'text', contains: 'Choose a handle', value: 'alice' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'progress' },
      { kind: 'select', contains: 'An account is already registered with this email', value: 'cancel' },
      { kind: 'note', contains: 'Falling back to credential entry' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('re-prompts for a different email on email-exhausted (quoting the lifetime limit) and completes', async () => {
    rStart
      .mockResolvedValueOnce({
        ok: false,
        reason: 'email-exhausted',
        status: 409,
        message: 'This email has reached the maximum of 30 account registrations.',
        limit: 30,
      })
      .mockResolvedValueOnce({ ok: true, pendingId: 'pnd_3' })
    rVerify.mockResolvedValueOnce({
      ok: true,
      agent: {
        id: 'agt_3',
        handle: 'alice',
        email: 'alice+bot2@example.com',
        createdAt: '2026-04-21T00:00:00Z',
      },
      apiKey: 'ac_live_0123456789abcdef0123',
    })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'register' },
      { kind: 'note', contains: 'register a new agent' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'text', contains: 'Choose a handle', value: 'alice' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'progress' },
      { kind: 'select', contains: 'has used all 30 of its lifetime account registrations', value: 'retry' },
      { kind: 'text', contains: 'Email', value: 'alice+bot2@example.com' },
      { kind: 'progress' },
      { kind: 'text', contains: 'verification code', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat account created' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    expect(rStart).toHaveBeenCalledTimes(2)
    // Handle + display name were kept; only the email changed.
    expect(rStart.mock.calls[1]?.[0]).toMatchObject({ email: 'alice+bot2@example.com', handle: 'alice' })
    expect(s.remaining()).toBe(0)
  })

  it('hands off to recovery when the user picks "recover" on email-limit-reached', async () => {
    rStart.mockResolvedValueOnce({
      ok: false,
      reason: 'email-limit-reached',
      status: 409,
      message: 'at limit',
      limit: 10,
    })
    recStart.mockResolvedValueOnce({
      ok: true,
      pendingId: 'pnd_r1',
      message: 'If an account is registered with this email, a verification code has been sent.',
    })
    recVerify.mockResolvedValueOnce({ ok: true, handle: 'alice-codex', apiKey: 'ac_live_recovered0000000000' })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'register' },
      { kind: 'note', contains: 'register a new agent' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'text', contains: 'Choose a handle', value: 'alice-new' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'progress' },
      { kind: 'select', contains: 'already backs 10 active agents', value: 'recover' },
      { kind: 'note', contains: 'recover a lost API key' },
      // Nothing is configured yet, so there is no default handle to offer.
      { kind: 'text', contains: 'Handle of the agent to recover', value: 'alice-codex', initialValue: null },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'progress' },
      { kind: 'text', contains: 'recovery code', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat API key recovered' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    expect(recStart).toHaveBeenCalledWith(
      { email: 'alice@example.com', handle: 'alice-codex' },
      expect.anything(),
    )
    const { cfg } = result as { cfg: unknown }
    expect(readAgentchatConfigField(cfg as never, 'default', 'apiKey')).toBe('ac_live_recovered0000000000')
    expect(readAgentchatConfigField(cfg as never, 'default', 'agentHandle')).toBe('alice-codex')
    expect(s.remaining()).toBe(0)
  })

  it('aborts with the quoted limit when the verify-time trigger rejects on email-limit-reached', async () => {
    rStart.mockResolvedValueOnce({ ok: true, pendingId: 'pnd_4' })
    rVerify.mockResolvedValueOnce({
      ok: false,
      reason: 'email-limit-reached',
      status: 409,
      message: 'at limit',
      limit: 10,
    })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'register' },
      { kind: 'note', contains: 'register a new agent' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'text', contains: 'Choose a handle', value: 'alice' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'progress' },
      { kind: 'text', contains: 'verification code', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'reached its limit of 10 active agents while you were verifying' },
      { kind: 'note', contains: 'Falling back to credential entry' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })
})

describe('agentchatSetupWizard.prepare — recover flow', () => {
  const RECOVERED_KEY = 'ac_live_recovered0000000000'
  const GENERIC_ACK = 'If an account is registered with this email, a verification code has been sent.'

  it('recovers a key from the unconfigured menu, always sending handle + email', async () => {
    recStart.mockResolvedValueOnce({ ok: true, pendingId: 'pnd_r1', message: GENERIC_ACK })
    recVerify.mockResolvedValueOnce({ ok: true, handle: 'alice', apiKey: RECOVERED_KEY })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'recover a lost API key' },
      { kind: 'text', contains: 'Handle of the agent to recover', value: 'alice', initialValue: null },
      { kind: 'text', contains: 'Email @alice registered with', value: 'Alice@Example.com' },
      { kind: 'progress' },
      { kind: 'text', contains: 'recovery code (check Alice@Example.com', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat API key recovered' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    expect(recStart).toHaveBeenCalledTimes(1)
    expect(recStart).toHaveBeenCalledWith({ email: 'Alice@Example.com', handle: 'alice' }, expect.anything())
    expect(recVerify).toHaveBeenCalledWith({ pendingId: 'pnd_r1', code: '123456' }, expect.anything())

    const { cfg, credentialValues } = result as {
      cfg: unknown
      credentialValues: Record<string, string>
    }
    expect(readAgentchatConfigField(cfg as never, 'default', 'apiKey')).toBe(RECOVERED_KEY)
    expect(readAgentchatConfigField(cfg as never, 'default', 'agentHandle')).toBe('alice')
    // Same sentinel as register: the credential step must not re-prompt.
    expect(credentialValues.token).toBe(RECOVERED_KEY)
    expect(credentialValues._agentchatJustRegistered).toBe('1')
    expect(s.remaining()).toBe(0)
  })

  it('defaults the handle to the configured agentHandle when re-run on a configured account', async () => {
    recStart.mockResolvedValueOnce({ ok: true, pendingId: 'pnd_r2', message: GENERIC_ACK })
    recVerify.mockResolvedValueOnce({ ok: true, handle: 'alice', apiKey: RECOVERED_KEY })

    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'replace-key' },
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: '@alice is configured here' },
      // Pre-filled with the stored handle; Enter (scripted as the same value) keeps it.
      { kind: 'text', contains: 'Handle of the agent to recover', value: 'alice', initialValue: 'alice' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'progress' },
      { kind: 'text', contains: 'recovery code', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat API key recovered' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: configuredCfg,
      accountId: 'default',
      credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    expect(recStart).toHaveBeenCalledWith({ email: 'alice@example.com', handle: 'alice' }, expect.anything())
    const { cfg } = result as { cfg: unknown }
    // The old key is replaced in place.
    expect(readAgentchatConfigField(cfg as never, 'default', 'apiKey')).toBe(RECOVERED_KEY)
    expect(s.remaining()).toBe(0)
  })

  it('lets the user override the default handle and writes the handle the server answered with', async () => {
    recStart.mockResolvedValueOnce({ ok: true, pendingId: 'pnd_r3', message: GENERIC_ACK })
    recVerify.mockResolvedValueOnce({ ok: true, handle: 'alice-codex', apiKey: RECOVERED_KEY })

    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'replace-key' },
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'recover a lost API key' },
      { kind: 'text', contains: 'Handle of the agent to recover', value: 'alice-codex', initialValue: 'alice' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'progress' },
      { kind: 'text', contains: 'recovery code', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat API key recovered' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: configuredCfg,
      accountId: 'default',
      credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
      prompter: s.prompter as never,
    } as never)

    expect(recStart).toHaveBeenCalledWith({ email: 'alice@example.com', handle: 'alice-codex' }, expect.anything())
    const { cfg } = (result ?? {}) as { cfg?: unknown }
    expect(readAgentchatConfigField(cfg as never, 'default', 'agentHandle')).toBe('alice-codex')
    expect(s.remaining()).toBe(0)
  })

  it('rejects a malformed handle at the validate step before any network call', async () => {
    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'recover a lost API key' },
      { kind: 'text', contains: 'Handle of the agent to recover', value: 'Not_A_Handle' },
    ])

    await expect(
      agentchatSetupWizard.prepare!({
        cfg: emptyCfg,
        accountId: 'default',
        credentialValues: {},
        prompter: s.prompter as never,
      } as never),
    ).rejects.toThrow(/Must start with a lowercase letter/)
    expect(recStart).not.toHaveBeenCalled()
  })

  it('echoes the server acknowledgement verbatim and retries a mistyped code', async () => {
    recStart.mockResolvedValueOnce({ ok: true, pendingId: 'pnd_r4', message: GENERIC_ACK })
    recVerify
      .mockResolvedValueOnce({ ok: false, reason: 'invalid-code', status: 400, message: 'Invalid or expired verification code' })
      .mockResolvedValueOnce({ ok: true, handle: 'alice', apiKey: RECOVERED_KEY })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'recover a lost API key' },
      { kind: 'text', contains: 'Handle of the agent to recover', value: 'alice' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'progress' },
      { kind: 'text', contains: 'recovery code', value: '000000' },
      { kind: 'progress' },
      { kind: 'note', contains: 'That code did not match' },
      { kind: 'text', contains: 'attempt 2/3', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat API key recovered' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    expect(recVerify).toHaveBeenCalledTimes(2)
    expect(s.remaining()).toBe(0)
  })

  it('gives up after three wrong codes and falls back to credential entry', async () => {
    recStart.mockResolvedValueOnce({ ok: true, pendingId: 'pnd_r5', message: GENERIC_ACK })
    recVerify.mockResolvedValue({ ok: false, reason: 'invalid-code', status: 400, message: 'nope' })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'recover a lost API key' },
      { kind: 'text', contains: 'Handle of the agent to recover', value: 'alice' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'progress' },
      { kind: 'text', contains: 'recovery code', value: '000001' },
      { kind: 'progress' },
      { kind: 'note', contains: 'That code did not match' },
      { kind: 'text', contains: 'attempt 2/3', value: '000002' },
      { kind: 'progress' },
      { kind: 'note', contains: 'That code did not match' },
      { kind: 'text', contains: 'attempt 3/3', value: '000003' },
      { kind: 'progress' },
      { kind: 'note', contains: 'Too many incorrect codes' },
      { kind: 'note', contains: 'Falling back to credential entry' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(recVerify).toHaveBeenCalledTimes(3)
    expect(s.remaining()).toBe(0)
  })

  it('stops on a rate-limited start and quotes Retry-After', async () => {
    recStart.mockResolvedValueOnce({
      ok: false,
      reason: 'rate-limited',
      status: 429,
      message: 'slow down',
      retryAfterSeconds: 3600,
    })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'recover a lost API key' },
      { kind: 'text', contains: 'Handle of the agent to recover', value: 'alice' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'progress' },
      { kind: 'note', contains: 'Too many recovery attempts from this network. Try again in 3600s.' },
      { kind: 'note', contains: 'Falling back to credential entry' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(recVerify).not.toHaveBeenCalled()
    expect(s.remaining()).toBe(0)
  })

  it('stops before asking for a code when a legacy server returns no pending_id', async () => {
    recStart.mockResolvedValueOnce({
      ok: false,
      reason: 'unexpected-shape',
      status: 200,
      message: 'AgentChat did not start a recovery (no pending_id in the response). Check that the email is the one this agent registered with.',
    })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'recover a lost API key' },
      { kind: 'text', contains: 'Handle of the agent to recover', value: 'alice' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'progress' },
      { kind: 'note', contains: 'no pending_id' },
      { kind: 'note', contains: 'Falling back to credential entry' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(recVerify).not.toHaveBeenCalled()
    expect(s.remaining()).toBe(0)
  })

  it('stops on an expired code', async () => {
    recStart.mockResolvedValueOnce({ ok: true, pendingId: 'pnd_r6', message: GENERIC_ACK })
    recVerify.mockResolvedValueOnce({ ok: false, reason: 'expired', status: 400, message: 'expired' })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'recover a lost API key' },
      { kind: 'text', contains: 'Handle of the agent to recover', value: 'alice' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'progress' },
      { kind: 'text', contains: 'recovery code', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'This recovery code expired' },
      { kind: 'note', contains: 'Falling back to credential entry' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('prints the sibling handles and asks for a re-run on a defensive HANDLE_REQUIRED', async () => {
    recStart.mockResolvedValueOnce({ ok: true, pendingId: 'pnd_r7', message: GENERIC_ACK })
    recVerify.mockResolvedValueOnce({
      ok: false,
      reason: 'handle-required',
      status: 409,
      message: 'This email backs more than one agent. Run recovery again with the handle you want to recover.',
      handles: ['alice', 'alice-codex'],
    })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'recover a lost API key' },
      { kind: 'text', contains: 'Handle of the agent to recover', value: 'alice' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'progress' },
      { kind: 'text', contains: 'recovery code', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'Run recovery again and enter the handle you want to recover.\n\nAgents on this email:\n  @alice\n  @alice-codex' },
      { kind: 'note', contains: 'Falling back to credential entry' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('reports a thrown transport error under the recovery title, not registration', async () => {
    recStart.mockRejectedValueOnce(new Error('socket hang up'))

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'recover' },
      { kind: 'note', contains: 'recover a lost API key' },
      { kind: 'text', contains: 'Handle of the agent to recover', value: 'alice' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'progress' },
      { kind: 'note', contains: 'Recovery failed\nsocket hang up' },
      { kind: 'note', contains: 'Falling back to credential entry' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })
})

describe('agentchatSetupWizard.finalize', () => {
  it('succeeds when the probe authenticates and captures the server handle', async () => {
    vMock.mockResolvedValueOnce({ ok: true, agent: liveAgent })

    const s = scripted([
      { kind: 'progress' },
    ])

    const result = await agentchatSetupWizard.finalize!({
      cfg: applyAgentchatAccountPatch(emptyCfg, 'default', {
        apiKey: 'ac_live_abcdef0123456789abcd',
      }) as never,
      accountId: 'default',
      credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    const patched = (result as { cfg: unknown }).cfg
    expect(readAgentchatConfigField(patched as never, 'default', 'agentHandle')).toBe('alice')
    expect(s.remaining()).toBe(0)
  })

  it('surfaces a warning but keeps the config when the key fails live probe', async () => {
    vMock.mockResolvedValueOnce({
      ok: false,
      reason: 'unauthorized',
      message: 'API key is invalid',
    })

    const s = scripted([
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat validation warning' },
    ])

    const result = await agentchatSetupWizard.finalize!({
      cfg: applyAgentchatAccountPatch(emptyCfg, 'default', {
        apiKey: 'ac_live_bad00000000000000000',
      }) as never,
      accountId: 'default',
      credentialValues: { token: 'ac_live_bad00000000000000000' },
      prompter: s.prompter as never,
    } as never)

    // finalize returns undefined on a probe failure — the cfg the framework
    // already persisted stays. Runtime will retry on startup.
    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('is a no-op when no API key is present in cfg or credentialValues', async () => {
    const s = scripted([])
    const result = await agentchatSetupWizard.finalize!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(vMock).not.toHaveBeenCalled()
  })
})

describe('agentchatSetupWizard.status', () => {
  it('reports "not configured" with a hint when no key is present', async () => {
    const status = agentchatSetupWizard.status!
    const configured = status.resolveConfigured({ cfg: emptyCfg, accountId: 'default' } as never)
    expect(configured).toBe(false)

    // `resolveStatusLines` is typed `string[] | Promise<string[]>` at the
    // plugin-sdk level to allow async implementations; `await` works for
    // both shapes. Non-null assert because the field is optional in the
    // interface (our implementation always provides it).
    const lines = await status.resolveStatusLines!({
      cfg: emptyCfg,
      accountId: 'default',
      configured: false,
    } as never)
    expect(lines.join(' ')).toMatch(/not configured/)
    // The hint must advertise all three entry points, recovery included.
    expect(lines.join(' ')).toMatch(/recover a lost one/)
  })

  it('reports "configured (@handle)" when both key and handle are present', async () => {
    const status = agentchatSetupWizard.status!
    const configured = status.resolveConfigured({
      cfg: configuredCfg,
      accountId: 'default',
    } as never)
    expect(configured).toBe(true)

    const lines = await status.resolveStatusLines!({
      cfg: configuredCfg,
      accountId: 'default',
      configured: true,
    } as never)
    expect(lines.join(' ')).toMatch(/configured \(@alice\)/)
  })
})

describe('applyAgentchatAccountPatch', () => {
  it('writes to the flat channels.agentchat.* shape for the default account', () => {
    const patched = applyAgentchatAccountPatch(emptyCfg, 'default', {
      apiKey: 'ac_live_abcdef0123456789abcd',
      agentHandle: 'alice',
    })
    expect(readAgentchatConfigField(patched, 'default', 'apiKey')).toBe(
      'ac_live_abcdef0123456789abcd',
    )
    expect(readAgentchatConfigField(patched, 'default', 'agentHandle')).toBe('alice')
  })

  it('writes to the accounts-map shape for a non-default account id', () => {
    const patched = applyAgentchatAccountPatch(emptyCfg, 'staging', {
      apiKey: 'ac_live_stagingkey0000000000',
      apiBase: 'https://staging.agentchat.me',
    })
    expect(readAgentchatConfigField(patched, 'staging', 'apiKey')).toBe(
      'ac_live_stagingkey0000000000',
    )
    expect(readAgentchatConfigField(patched, 'staging', 'apiBase')).toBe(
      'https://staging.agentchat.me',
    )
    // Does not leak into the default account.
    expect(readAgentchatConfigField(patched, 'default', 'apiKey')).toBeUndefined()
  })

  it('treats an undefined field value as a removal', () => {
    const seeded = applyAgentchatAccountPatch(emptyCfg, 'default', {
      apiKey: 'ac_live_abcdef0123456789abcd',
      apiBase: 'https://staging.agentchat.me',
    })
    const patched = applyAgentchatAccountPatch(seeded, 'default', {
      apiBase: undefined,
    })
    expect(readAgentchatConfigField(patched, 'default', 'apiBase')).toBeUndefined()
    // apiKey untouched.
    expect(readAgentchatConfigField(patched, 'default', 'apiKey')).toBe(
      'ac_live_abcdef0123456789abcd',
    )
  })
})
