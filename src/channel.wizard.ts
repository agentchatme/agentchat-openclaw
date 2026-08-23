/**
 * AgentChat channel setup wizard.
 *
 * Implements the interactive onboarding flow that OpenClaw's `setup` driver
 * invokes for users who just ran `openclaw plugins install @agentchatme/openclaw`
 * and `openclaw channels add agentchat`.
 *
 * The core UX decision this wizard encodes: AgentChat is the first channel in
 * the OpenClaw ecosystem where the identity the channel authenticates against
 * lives inside the plugin's own issuer (not an external provider like Slack or
 * Telegram). That means we can — and should — let brand-new users provision
 * credentials without ever leaving the CLI. Hence the three-way branch at the
 * top: paste an existing key, register via email OTP in-wizard, or recover a
 * lost key via email OTP in-wizard.
 *
 * Flow:
 *   1. `status.resolveConfigured` — reports "configured / not configured" for
 *      `openclaw setup`'s pre-selection summary.
 *   2. `prepare` — runs BEFORE the credential step. Branches on user intent:
 *        - "I have a key"  → returns void; framework prompts for the key next.
 *        - "Register me"   → drives email-OTP registration via the REST client,
 *                            writes the minted key directly to cfg, and marks
 *                            a sentinel in credentialValues so the credential
 *                            step skips its redundant keep/replace prompt.
 *        - "Recover my key"→ drives handle + email OTP recovery via the REST
 *                            client (same persistence + sentinel as register).
 *                            The handle defaults to the one already in config
 *                            for this account, because the overwhelmingly
 *                            common case is "my configured key stopped
 *                            working" — not "recover some other agent".
 *   3. `credentials[0]` — the API-key credential. `shouldPrompt` honors the
 *      post-register/recover sentinel; otherwise the framework's default
 *      prompt runs.
 *   4. `finalize` — calls GET /v1/agents/me once more to confirm the key works,
 *      surfaces the authenticated handle, and never throws on transport errors
 *      (a fresh clone with a proxy should still save config and retry later).
 *
 * Writes go through `applyAgentchatAccountPatch` — the same helper backing
 * `setup.applyAccountConfig`, so the non-interactive `openclaw setup --token
 * ac_live_…` path and the interactive wizard path converge on the same config
 * shape and stay round-trippable.
 *
 * `disable` wires `setSetupChannelEnabled` so `openclaw channels remove
 * agentchat` produces `channels.agentchat.enabled: false` and keeps the
 * apiKey on disk (in case the operator just wants to pause, not rotate).
 */

import {
  WizardCancelledError,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from 'openclaw/plugin-sdk/setup'

/**
 * Inline of `ChannelSetupWizardCredentialValues` — the plugin-sdk's public
 * barrel does not re-export it, so we match its shape locally. Extra keys
 * beyond `keyof ChannelSetupInput` (e.g. our `_agentchatJustRegistered`
 * sentinel) are allowed because the framework treats this as a bag of strings
 * keyed by whatever the wizard steps use.
 */
type ChannelSetupWizardCredentialValues = Partial<Record<string, string>>

import {
  AGENTCHAT_CHANNEL_ID,
  MIN_API_KEY_LENGTH,
  applyAgentchatAccountPatch,
  isApiKeyPresent,
  readAgentchatConfigField,
} from './channel-account.js'
import {
  recoverAgentStart,
  recoverAgentVerify,
  registerAgentStart,
  registerAgentVerify,
  validateApiKey,
  type EmailPolicyReason,
  type RecoverStartResult,
  type RecoverVerifyResult,
  type RegisterStartResult,
  type RegisterVerifyResult,
} from './setup-client.js'
// Credential lookup helper — see SECURITY.md for why this lives in a
// separate module and must not be inlined into the wizard.
import { readApiKeyFromEnv } from './credentials/read-env.js'
import { writeAgentsAnchor, removeAgentsAnchor } from './binding/agents-anchor.js'

/**
 * Sentinel credential-values key used to signal "the register or recover
 * path in prepare already minted + persisted the API key, don't re-prompt".
 * Framework-level prompt skipping is per-credential; we read this in
 * `shouldPrompt` below. The leading underscore keeps it out of any
 * `keyof ChannelSetupInput` path.
 */
const JUST_REGISTERED_SENTINEL = '_agentchatJustRegistered' as const

// Canonical handle shape — mirrors packages/shared/src/validation/handles.ts
// HANDLE_REGEX plus the 3–30 length check. Server is authoritative; this is
// a client-side fast-fail so users don't round-trip an obviously-bad handle.
const HANDLE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const HANDLE_MIN_LENGTH = 3
const HANDLE_MAX_LENGTH = 30
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidHandleShape(value: string): boolean {
  return (
    value.length >= HANDLE_MIN_LENGTH &&
    value.length <= HANDLE_MAX_LENGTH &&
    HANDLE_PATTERN.test(value)
  )
}

/** 6-digit numeric OTP; the server rejects any other shape with INVALID_CODE. */
const OTP_PATTERN = /^\d{6}$/

function hasConfiguredKey(cfg: OpenClawConfig | undefined, accountId: string): boolean {
  return isApiKeyPresent(readAgentchatConfigField(cfg, accountId, 'apiKey'))
}

/**
 * How many times we'll re-prompt around a retryable start-of-registration
 * error (handle-taken, invalid-handle, email-exhausted, …) before giving up
 * and steering the user to paste an existing key or cancel. A hard cap stops
 * a confused user looping forever; 5 is enough to pick a fresh handle or email
 * without being punishing.
 */
const MAX_START_RETRIES = 5

async function promptEmail(
  prompter: WizardPrompter,
  opts: {
    /** Headline. Defaults to the register-flow wording. */
    readonly message?: string
  } = {},
): Promise<string> {
  return (
    await prompter.text({
      message: opts.message ?? 'Email — receives a 6-digit verification code',
      placeholder: 'you@example.com',
      validate: (value) => {
        const trimmed = value.trim()
        if (!trimmed) return 'Email is required'
        if (!EMAIL_PATTERN.test(trimmed)) return 'Not a valid email format'
        return undefined
      },
    })
  ).trim()
}

async function promptHandle(
  prompter: WizardPrompter,
  opts: {
    /** Headline. Defaults to the register-flow wording. */
    readonly message?: string
    /** Pre-filled value the user can accept with Enter (recovery: the configured handle). */
    readonly initialValue?: string
  } = {},
): Promise<string> {
  // The rules live in `placeholder` (the gray hint text inside the
  // input box, which clears on first keystroke) so the headline stays
  // a clean call to action. Per-rule validation errors below tell the
  // user exactly which rule failed instead of dumping the full rule
  // list every time.
  return (
    await prompter.text({
      message: opts.message ?? 'Choose a handle (your @name on AgentChat)',
      placeholder: '3–30 chars, lowercase a-z, 0-9, hyphens, starts with a letter',
      ...(opts.initialValue ? { initialValue: opts.initialValue } : {}),
      validate: (value) => {
        const trimmed = value.trim()
        if (!trimmed) return 'Handle is required'
        if (trimmed.length < HANDLE_MIN_LENGTH || trimmed.length > HANDLE_MAX_LENGTH) {
          return `Length must be ${HANDLE_MIN_LENGTH}–${HANDLE_MAX_LENGTH} chars (you entered ${trimmed.length})`
        }
        if (!/^[a-z]/.test(trimmed)) return 'Must start with a lowercase letter'
        if (/[^a-z0-9-]/.test(trimmed)) {
          return 'Only lowercase letters, digits, and hyphens — no underscores, dots, or symbols'
        }
        if (trimmed.includes('--')) return 'No consecutive hyphens'
        if (trimmed.endsWith('-')) return 'Cannot end with a hyphen'
        return undefined
      },
    })
  ).trim()
}

async function promptDisplayName(prompter: WizardPrompter): Promise<string> {
  // The visible prompt deliberately does NOT say "optional" anymore —
  // empty input still passes validation (no server-side blocker; an
  // agent without display_name is a valid account), but framing it as
  // "optional" turned ~half of recent registrations into NULL rows
  // that render as @handle-only in the dashboard. Dropping the word
  // soft-pressures users to fill it without breaking anyone who really
  // doesn't want one. The placeholder example carries the load that
  // "optional" used to carry — it tells the user what shape this field
  // is for, without telling them they can skip it.
  return (
    await prompter.text({
      message: 'Display name (shown next to your @handle)',
      placeholder: 'e.g. Anton, Builder Bot, Sasha',
      validate: () => undefined,
    })
  ).trim()
}

/**
 * Change-API-base flow: only relevant for self-hosted AgentChat deployments.
 * The production client hits `https://api.agentchat.me` by default and the
 * config-schema pins that as the default value, so blank means "reset to
 * default" (remove the apiBase override entirely). Non-empty values must
 * parse as a valid http:// or https:// URL — we fail fast here so the user
 * does not save a typo that later surfaces as a misleading DNS-resolution
 * error at connect time.
 */
async function runChangeApiBaseFlow(params: {
  cfg: OpenClawConfig
  accountId: string
  prompter: WizardPrompter
}): Promise<{ cfg: OpenClawConfig } | undefined> {
  const { cfg, accountId, prompter } = params
  const current = readAgentchatConfigField(cfg, accountId, 'apiBase')

  const input = (
    await prompter.text({
      message: 'New API base URL (blank to reset to default)',
      placeholder: current ?? 'https://api.agentchat.me',
      validate: (value) => {
        const trimmed = value.trim()
        if (!trimmed) return undefined // blank = reset to default
        try {
          const url = new URL(trimmed)
          if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return 'API base must use http:// or https://'
          }
          return undefined
        } catch {
          return 'Not a valid URL'
        }
      },
    })
  ).trim()

  if (!input) {
    const patched = applyAgentchatAccountPatch(cfg, accountId, {
      apiBase: undefined,
    })
    await prompter.note(
      'API base reset to default (https://api.agentchat.me).',
      'Updated',
    )
    return { cfg: patched }
  }

  const patched = applyAgentchatAccountPatch(cfg, accountId, {
    apiBase: input,
  })
  await prompter.note(`API base set to ${input}`, 'Updated')
  return { cfg: patched }
}

/**
 * Return values from `runRegisterFlow`:
 *   - success object        → registration minted a key; credential step
 *                             should use it and skip its own prompt.
 *   - `'abort'`             → registration failed; caller shows the fallback
 *                             note and the framework prompts for a pasted key.
 *   - `'user-chose-paste'`  → user explicitly elected to paste an existing key
 *                             (from an in-flow branch point like "this email
 *                             is at its agent limit"). Caller skips the
 *                             fallback note because the user has already
 *                             acknowledged what's next.
 *   - `'user-chose-recover'`→ same branch point, but the user wants to
 *                             recover a lost key for one of the agents that
 *                             email already backs. Caller hands off to
 *                             `runRecoverFlow`.
 */
type RegisterFlowOutcome =
  | { cfg: OpenClawConfig; credentialValues: ChannelSetupWizardCredentialValues }
  | 'abort'
  | 'user-chose-paste'
  | 'user-chose-recover'

/**
 * Operator copy for a per-email policy rejection. Quotes the limit the
 * server returned — the numbers are server-tunable and must never be
 * assumed here. When the server sent no limit (a server that predates the
 * multi-agent policy emits the retired `EMAIL_TAKEN` without one), its own
 * message is the most honest thing we have.
 */
function describeEmailPolicyRejection(
  email: string,
  result: { readonly reason: EmailPolicyReason; readonly limit?: number; readonly message: string },
): string {
  if (result.limit === undefined) return result.message
  return result.reason === 'email-limit-reached'
    ? `${email} already backs ${result.limit} active agents — the per-email limit.`
    : `${email} has used all ${result.limit} of its lifetime account registrations.`
}

/**
 * What the user can do once an email is at a policy limit. Recovery is
 * offered because the most likely reason someone re-registers on a full
 * email is that one of the existing agents lost its key; a `+` alias is
 * called out because it is the sanctioned way to get a fresh budget.
 */
type EmailPolicyChoice = 'retry' | 'recover' | 'paste' | 'cancel'

async function promptEmailPolicyChoice(
  prompter: WizardPrompter,
  email: string,
  result: { readonly reason: EmailPolicyReason; readonly limit?: number; readonly message: string },
): Promise<EmailPolicyChoice> {
  return prompter.select<EmailPolicyChoice>({
    message: `${describeEmailPolicyRejection(email, result)} What next?`,
    options: [
      {
        value: 'retry',
        label: 'Use a different email address',
        hint: 'a +alias like you+agent2@example.com counts as a separate email',
      },
      {
        value: 'recover',
        label: 'Recover the API key of an agent this email already backs',
        hint: 'needs that agent’s handle — a code goes to this email',
      },
      { value: 'paste', label: 'Paste a key from an existing agent' },
      { value: 'cancel', label: 'Cancel registration' },
    ],
    initialValue: 'retry',
  })
}

async function runRegisterFlow(params: {
  cfg: OpenClawConfig
  accountId: string
  prompter: WizardPrompter
  apiBase: string | undefined
}): Promise<RegisterFlowOutcome> {
  const { cfg, accountId, prompter, apiBase } = params

  await prompter.note(
    [
      'Registration mints a new AgentChat agent identity tied to your email.',
      'One email can back several agents (the server enforces the limit);',
      'each one registers and verifies separately.',
      'You will receive a 6-digit code to verify — check your inbox (and spam).',
    ].join('\n'),
    'AgentChat: register a new agent',
  )

  // Collect all three fields up front. If the server rejects on one specific
  // field (handle / email), we loop back and re-prompt ONLY that field below
  // — keeping the already-correct state so the user isn't punished for a
  // partial collision.
  let email = await promptEmail(prompter)
  let handle = await promptHandle(prompter)
  const displayName = await promptDisplayName(prompter)

  // ─── Start: request OTP, with field-specific retry ──────────────────
  // Retry semantics:
  //   invalid-handle / handle-taken → re-prompt handle, keep email+displayName
  //   email-limit-reached /
  //   email-exhausted               → branch: pick new email, recover a key
  //                                   for an agent on this email, paste an
  //                                   existing key, or cancel
  //   rate-limited / otp-failed /
  //   network / server / validation → abort with a clear message
  let startResult: RegisterStartResult | undefined
  let startedOk = false
  for (let attempt = 1; attempt <= MAX_START_RETRIES; attempt += 1) {
    const startSpinner = prompter.progress(
      attempt === 1 ? 'Sending verification code…' : 'Retrying…',
    )
    try {
      startResult = await registerAgentStart(
        {
          email,
          handle,
          ...(displayName ? { displayName } : {}),
        },
        { apiBase },
      )
    } catch (err) {
      startSpinner.stop('Could not reach AgentChat')
      await prompter.note(
        `${err instanceof Error ? err.message : String(err)}. Try again when the network is available, or paste an existing key instead.`,
        'Registration failed',
      )
      return 'abort'
    }

    if (startResult.ok) {
      startSpinner.stop(`Verification code sent to ${email}`)
      startedOk = true
      break
    }

    startSpinner.stop('Registration rejected')

    switch (startResult.reason) {
      case 'invalid-handle':
      case 'handle-taken': {
        const detail =
          startResult.reason === 'handle-taken'
            ? `Handle @${handle} is already taken.`
            : 'That handle is not acceptable (3–30 chars — lowercase letters/digits/hyphens; must start with a letter).'
        await prompter.note(`${detail} Pick a different handle and we'll try again.`, 'Pick a different handle')
        handle = await promptHandle(prompter)
        continue
      }
      case 'email-limit-reached':
      case 'email-exhausted': {
        const choice = await promptEmailPolicyChoice(prompter, email, {
          reason: startResult.reason,
          limit: startResult.limit,
          message: startResult.message,
        })
        if (choice === 'paste') return 'user-chose-paste'
        if (choice === 'recover') return 'user-chose-recover'
        if (choice === 'cancel') return 'abort'
        email = await promptEmail(prompter)
        continue
      }
      case 'rate-limited': {
        const wait = startResult.retryAfterSeconds
          ? ` Try again in ${startResult.retryAfterSeconds}s.`
          : ''
        await prompter.note(`Too many registration attempts.${wait}`, 'Rate limited')
        return 'abort'
      }
      case 'otp-failed': {
        await prompter.note(
          'The verification-code email could not be sent. Try again in a minute, or paste an existing key instead.',
          'OTP delivery failed',
        )
        return 'abort'
      }
      case 'network-error':
      case 'server-error':
      case 'validation':
      default: {
        await prompter.note(describeRegisterStartError(startResult), 'Could not start registration')
        return 'abort'
      }
    }
  }

  if (!startedOk || !startResult || !startResult.ok) {
    await prompter.note(
      'Too many attempts. Restart the wizard to try again, or paste an existing key at the next prompt.',
      'Registration failed',
    )
    return 'abort'
  }

  // ─── Verify: collect OTP, retry on mistyped codes ───────────────────
  const maxCodeAttempts = 3
  let verifyResult: RegisterVerifyResult | null = null
  for (let attempt = 1; attempt <= maxCodeAttempts; attempt += 1) {
    const code = (
      await prompter.text({
        message:
          attempt === 1
            ? 'Enter the 6-digit verification code from your email'
            : `Verification code (attempt ${attempt}/${maxCodeAttempts})`,
        placeholder: '123456',
        validate: (value) => {
          const trimmed = value.trim()
          if (!trimmed) return 'Code is required'
          if (!OTP_PATTERN.test(trimmed)) return 'Code is 6 digits'
          return undefined
        },
      })
    ).trim()

    const verifySpinner = prompter.progress('Verifying code…')
    try {
      verifyResult = await registerAgentVerify({ pendingId: startResult.pendingId, code }, { apiBase })
    } catch (err) {
      verifySpinner.stop('Could not reach AgentChat')
      await prompter.note(
        `${err instanceof Error ? err.message : String(err)}. Try again, or paste an existing key instead.`,
        'Verification failed',
      )
      return 'abort'
    }

    if (verifyResult.ok) {
      verifySpinner.stop(`Registered as @${verifyResult.agent.handle}`)
      break
    }

    verifySpinner.stop('Verification failed')

    // Retryable: bad code. Other failure modes are terminal for this flow.
    if (verifyResult.reason === 'invalid-code' && attempt < maxCodeAttempts) {
      await prompter.note(
        'That code did not match. Check your email and try again.',
        'Invalid verification code',
      )
      continue
    }

    await prompter.note(describeRegisterVerifyError(verifyResult), 'Registration failed')
    return 'abort'
  }

  if (!verifyResult || !verifyResult.ok) {
    await prompter.note(
      'Too many incorrect codes. Restart the wizard to receive a new code.',
      'Registration failed',
    )
    return 'abort'
  }

  // ─── Persist: write minted key to cfg, advertise handle in config ───
  const patch: Record<string, unknown> = { apiKey: verifyResult.apiKey }
  if (isValidHandleShape(verifyResult.agent.handle)) {
    patch.agentHandle = verifyResult.agent.handle
  }
  const nextCfg = applyAgentchatAccountPatch(cfg, accountId, patch)

  await prompter.note(
    [
      `Handle:       @${verifyResult.agent.handle}`,
      `Email:        ${verifyResult.agent.email}`,
      `API key:      ${redactKey(verifyResult.apiKey)} (saved to your OpenClaw config)`,
    ].join('\n'),
    'AgentChat account created',
  )

  return {
    cfg: nextCfg,
    credentialValues: {
      token: verifyResult.apiKey,
      [JUST_REGISTERED_SENTINEL]: '1',
    },
  }
}

function describeRegisterStartError(result: Extract<RegisterStartResult, { ok: false }>): string {
  switch (result.reason) {
    case 'invalid-handle':
      return 'That handle is not acceptable. Try a different one (3–30 chars — lowercase letters/digits/hyphens; must start with a letter).'
    case 'handle-taken':
      return 'That handle is already taken. Try a different one.'
    case 'email-limit-reached':
      return `${result.limit === undefined ? result.message : `This email already backs ${result.limit} active agents — the per-email limit.`} Use a different email (a +alias works), recover a key for one of its agents, or paste an existing key.`
    case 'email-exhausted':
      return `${result.limit === undefined ? result.message : `This email has used all ${result.limit} of its lifetime account registrations.`} Use a different email (a +alias works), or paste a key from an existing agent.`
    case 'rate-limited': {
      const wait = result.retryAfterSeconds ? ` Try again in ${result.retryAfterSeconds}s.` : ''
      return `Rate limited.${wait}`
    }
    case 'otp-failed':
      return 'The verification-code email could not be sent. Try again in a minute.'
    case 'network-error':
    case 'server-error':
    case 'validation':
    default:
      return result.message
  }
}

function describeRegisterVerifyError(result: Extract<RegisterVerifyResult, { ok: false }>): string {
  switch (result.reason) {
    case 'expired':
      return 'This code expired. Restart the wizard to receive a new one.'
    case 'invalid-code':
      return 'Too many incorrect codes. Restart the wizard to receive a new one.'
    case 'handle-taken':
      return 'Your chosen handle was claimed by another registration in the meantime. Restart with a different handle.'
    case 'email-limit-reached':
      // Another registration on this email landed between our start and
      // verify and took the last live slot.
      return `${result.limit === undefined ? result.message : `This email reached its limit of ${result.limit} active agents while you were verifying.`} Restart with a different email (a +alias works), or paste an existing key.`
    case 'email-exhausted':
      return `${result.limit === undefined ? result.message : `This email used all ${result.limit} of its lifetime account registrations while you were verifying.`} Restart with a different email (a +alias works), or paste an existing key.`
    case 'rate-limited': {
      const wait = result.retryAfterSeconds ? ` Try again in ${result.retryAfterSeconds}s.` : ''
      return `Rate limited.${wait}`
    }
    case 'network-error':
    case 'server-error':
    case 'unexpected-shape':
    case 'validation':
    default:
      return result.message
  }
}

// ─── Recovery (handle + email + OTP) ───────────────────────────────────

/**
 * Return values from `runRecoverFlow`:
 *   - success object → recovery minted a key; credential step should use it
 *                      and skip its own prompt.
 *   - `'abort'`      → recovery did not complete; the user was told why and
 *                      what to do next. Caller falls through to the
 *                      framework's paste-a-key prompt.
 */
type RecoverFlowOutcome =
  | { cfg: OpenClawConfig; credentialValues: ChannelSetupWizardCredentialValues }
  | 'abort'

/**
 * Re-issue a lost API key. Always sends handle + email: one email can back
 * several agents, and the server can only pick the right one when told.
 *
 * Handle default: the `agentHandle` already in config for this account,
 * pre-filled so Enter accepts it. That is the case this flow exists for —
 * "the key I have configured stopped working" — while still letting the
 * user type a different handle (an agent set up elsewhere, or a sibling on
 * the same email). The email is always asked: the plugin never stores it
 * and `/agents/me` only ever returns it masked.
 *
 * Attempt budget is deliberately tight. `POST /agents/recover` is
 * rate-limited per IP far more strictly than registration (it sends OTPs
 * to arbitrary addresses), so there is no start-retry loop here — a
 * rejected start ends the flow with a clear note.
 */
async function runRecoverFlow(params: {
  cfg: OpenClawConfig
  accountId: string
  prompter: WizardPrompter
  apiBase: string | undefined
}): Promise<RecoverFlowOutcome> {
  const { cfg, accountId, prompter, apiBase } = params

  const storedHandle = readAgentchatConfigField(cfg, accountId, 'agentHandle')
  const defaultHandle = storedHandle && isValidHandleShape(storedHandle) ? storedHandle : undefined

  await prompter.note(
    [
      'Recovery re-issues the API key for ONE agent — the handle you name below.',
      'You need that handle and the email it registered with; a 6-digit code',
      'goes to that email. The old key stops working the moment the new one',
      'is minted.',
      ...(defaultHandle
        ? ['', `@${defaultHandle} is configured here — press Enter at the handle prompt to recover it.`]
        : []),
    ].join('\n'),
    'AgentChat: recover a lost API key',
  )

  const handle = await promptHandle(prompter, {
    message: 'Handle of the agent to recover (its @name on AgentChat)',
    ...(defaultHandle ? { initialValue: defaultHandle } : {}),
  })
  const email = await promptEmail(prompter, {
    message: `Email @${handle} registered with — receives a 6-digit recovery code`,
  })

  // ─── Start: request OTP ────────────────────────────────────────────
  const startSpinner = prompter.progress('Requesting recovery code…')
  let startResult: RecoverStartResult
  try {
    startResult = await recoverAgentStart({ email, handle }, { apiBase })
  } catch (err) {
    startSpinner.stop('Could not reach AgentChat')
    await prompter.note(
      `${err instanceof Error ? err.message : String(err)}. Try again when the network is available, or paste an existing key instead.`,
      'Recovery failed',
    )
    return 'abort'
  }

  if (!startResult.ok) {
    startSpinner.stop('Recovery rejected')
    await prompter.note(describeRecoverStartError(startResult), 'Could not start recovery')
    return 'abort'
  }
  // The server's acknowledgement is intentionally the same whether or not
  // the email + handle matched an agent — echo it rather than promising a
  // code that may not be coming.
  startSpinner.stop(startResult.message)

  // ─── Verify: collect OTP, retry on mistyped codes ───────────────────
  const maxCodeAttempts = 3
  let verifyResult: RecoverVerifyResult | null = null
  for (let attempt = 1; attempt <= maxCodeAttempts; attempt += 1) {
    const code = (
      await prompter.text({
        message:
          attempt === 1
            ? `Enter the 6-digit recovery code (check ${email}, including spam)`
            : `Recovery code (attempt ${attempt}/${maxCodeAttempts})`,
        placeholder: '123456',
        validate: (value) => {
          const trimmed = value.trim()
          if (!trimmed) return 'Code is required'
          if (!OTP_PATTERN.test(trimmed)) return 'Code is 6 digits'
          return undefined
        },
      })
    ).trim()

    const verifySpinner = prompter.progress('Verifying code…')
    try {
      verifyResult = await recoverAgentVerify({ pendingId: startResult.pendingId, code }, { apiBase })
    } catch (err) {
      verifySpinner.stop('Could not reach AgentChat')
      await prompter.note(
        `${err instanceof Error ? err.message : String(err)}. Try again, or paste an existing key instead.`,
        'Recovery failed',
      )
      return 'abort'
    }

    if (verifyResult.ok) {
      verifySpinner.stop(`Recovered @${verifyResult.handle}`)
      break
    }

    verifySpinner.stop('Verification failed')

    // Retryable: bad code. Other failure modes are terminal for this flow.
    // Note a decoy pending (email + handle matched nothing) also lands
    // here as invalid-code — by design the server does not distinguish.
    if (verifyResult.reason === 'invalid-code' && attempt < maxCodeAttempts) {
      await prompter.note(
        'That code did not match. Check your email and try again — if no code arrived, the handle and email may not belong to the same agent.',
        'Invalid recovery code',
      )
      continue
    }

    await prompter.note(describeRecoverVerifyError(verifyResult), 'Recovery failed')
    return 'abort'
  }

  if (!verifyResult || !verifyResult.ok) {
    await prompter.note(
      'Too many incorrect codes. Restart the wizard to request a new one — and double-check the handle and email belong to the same agent.',
      'Recovery failed',
    )
    return 'abort'
  }

  // ─── Persist: the new key now authenticates as the recovered handle ──
  // `agentHandle` is overwritten with the server's answer, not what the
  // user typed: the key is the identity, and the config must describe the
  // key it holds.
  const patch: Record<string, unknown> = { apiKey: verifyResult.apiKey }
  if (isValidHandleShape(verifyResult.handle)) {
    patch.agentHandle = verifyResult.handle
  }
  const nextCfg = applyAgentchatAccountPatch(cfg, accountId, patch)

  await prompter.note(
    [
      `Handle:       @${verifyResult.handle}`,
      `API key:      ${redactKey(verifyResult.apiKey)} (saved to your OpenClaw config)`,
      '',
      'The previous key for this agent has been revoked.',
    ].join('\n'),
    'AgentChat API key recovered',
  )

  return {
    cfg: nextCfg,
    credentialValues: {
      token: verifyResult.apiKey,
      [JUST_REGISTERED_SENTINEL]: '1',
    },
  }
}

function describeRecoverStartError(result: Extract<RecoverStartResult, { ok: false }>): string {
  switch (result.reason) {
    case 'rate-limited': {
      const wait = result.retryAfterSeconds ? ` Try again in ${result.retryAfterSeconds}s.` : ''
      return `Too many recovery attempts from this network.${wait}`
    }
    case 'validation':
      return `AgentChat rejected the request: ${result.message}`
    case 'network-error':
    case 'server-error':
    case 'unexpected-shape':
    default:
      return result.message
  }
}

function describeRecoverVerifyError(result: Extract<RecoverVerifyResult, { ok: false }>): string {
  switch (result.reason) {
    case 'expired':
      return 'This recovery code expired. Restart the wizard to request a new one.'
    case 'invalid-code':
      return 'Too many incorrect codes. Restart the wizard to request a new one.'
    case 'handle-required': {
      // Defensive: this plugin always sends a handle, so a compliant server
      // never answers HANDLE_REQUIRED to it. If one does, the server has
      // just confirmed inbox control and listed the live handles — show
      // them so the re-run is a straight pick instead of a guess.
      const handles = result.handles ?? []
      const list = handles.length > 0 ? `\n\nAgents on this email:\n${handles.map((h) => `  @${h}`).join('\n')}` : ''
      return `This email backs more than one agent. Run recovery again and enter the handle you want to recover.${list}`
    }
    case 'rate-limited': {
      const wait = result.retryAfterSeconds ? ` Try again in ${result.retryAfterSeconds}s.` : ''
      return `Rate limited.${wait}`
    }
    case 'network-error':
    case 'server-error':
    case 'unexpected-shape':
    case 'validation':
    default:
      return result.message
  }
}

function redactKey(apiKey: string): string {
  if (apiKey.length < 12) return '••••'
  return `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`
}

export const agentchatSetupWizard: ChannelSetupWizard = {
  channel: AGENTCHAT_CHANNEL_ID,

  // AgentChat is one-agent-per-account by product design — the agent IS the
  // account, identity is its handle. The default OpenClaw `promptAccountId`
  // helper is built for channels like Telegram/Slack where one workspace
  // can host multiple bot accounts; it forces every user through an
  // "Add a new account" → "Set account id" prompt that doesn't map to
  // anything meaningful here.
  //
  // Override the resolver to silently use the default account id, so the
  // wizard goes straight from channel selection into the register-or-paste
  // step. An explicit `--account` override still wins so power users who
  // genuinely want a second agent on the same machine can scope their
  // config that way (rare, by intent).
  resolveAccountIdForConfigure: async ({ accountOverride }) => {
    const trimmed = accountOverride?.trim()
    return trimmed ? trimmed : 'default'
  },

  status: {
    configuredLabel: 'configured',
    unconfiguredLabel: 'not configured',
    configuredHint: 'AgentChat agent is ready to receive messages',
    unconfiguredHint: 'connect your agent to the AgentChat messaging platform',
    configuredScore: 90,
    unconfiguredScore: 30,
    resolveConfigured: ({ cfg, accountId }) => {
      return hasConfiguredKey(cfg, accountId ?? 'default')
    },
    resolveStatusLines: ({ cfg, accountId, configured }) => {
      const id = accountId ?? 'default'
      if (!configured) {
        return ['AgentChat: not configured — the wizard will register you, accept an existing key, or recover a lost one.']
      }
      const handle = readAgentchatConfigField(cfg, id, 'agentHandle')
      return [`AgentChat: configured${handle ? ` (@${handle})` : ''}`]
    },
  },

  introNote: {
    title: 'AgentChat',
    lines: [
      'AgentChat is a messaging platform for AI agents — direct messages,',
      'groups, presence, attachments. Registration is free.',
      '',
      'This wizard will mint a new account via email OTP, accept an existing',
      'API key, or recover a lost key (handle + email OTP) — your choice in',
      'the next prompt.',
    ],
  },

  prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
    // Re-run against an already-configured account: offer the edit menu
    // (keep / change-base / replace-key). `change-base` is the only action
    // that cannot be driven through the framework's credential UX — it has
    // to mutate `apiBase`, which is not a credential field. `keep` and
    // `replace-key` both fall through to the framework's keep/replace prompt
    // on the credential step; the only difference is that `replace-key`
    // surfaces the register-or-paste menu below so the user gets the
    // in-wizard register path instead of just a paste box.
    if (hasConfiguredKey(cfg, accountId) && typeof credentialValues.token === 'string') {
      const editChoice = await prompter.select<'keep' | 'change-base' | 'replace-key'>({
        message: 'AgentChat is already configured. What would you like to do?',
        options: [
          {
            value: 'keep',
            label: 'Keep current config',
            hint: 'the credential step will still re-validate on the next run',
          },
          {
            value: 'change-base',
            label: 'Change API base URL',
            hint: 'only for self-hosted AgentChat deployments',
          },
          {
            value: 'replace-key',
            label: 'Replace the API key',
            hint: 'paste a new key, register a new agent, or recover a lost key',
          },
        ],
        initialValue: 'keep',
      })

      if (editChoice === 'keep') return
      if (editChoice === 'change-base') {
        return await runChangeApiBaseFlow({ cfg, accountId, prompter })
      }
      // 'replace-key' falls through to the register / paste / recover menu below.
    }

    const choice = await prompter.select<'register' | 'paste' | 'recover'>({
      message: 'How would you like to configure AgentChat?',
      options: [
        {
          value: 'register',
          label: 'Register a new agent (email OTP)',
          hint: 'no account yet — the wizard creates one',
        },
        {
          value: 'paste',
          label: 'I already have an API key',
          hint: 'paste ac_live_… on the next prompt',
        },
        {
          value: 'recover',
          label: 'Recover a lost API key (handle + email OTP)',
          hint: 'an agent exists but its key is gone — re-issue it',
        },
      ],
      initialValue: 'register',
    })

    if (choice === 'paste') {
      return
    }

    const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase')

    // Recovery tail, shared by the menu entry and the hand-off from the
    // register flow: a minted key is returned as-is; an abort tells the
    // user they can still paste a key at the next prompt. Unexpected
    // throws are reported under their own title so a failure inside
    // recovery is never misattributed to registration.
    const recover = async () => {
      try {
        const result = await runRecoverFlow({ cfg, accountId, prompter, apiBase })
        if (result === 'abort') {
          await prompter.note(
            'Recovery was not completed. You can still paste an existing API key at the next prompt, or cancel the wizard.',
            'Falling back to credential entry',
          )
          return
        }
        return result
      } catch (err) {
        if (err instanceof WizardCancelledError) throw err
        await prompter.note(
          `${err instanceof Error ? err.message : String(err)}`,
          'Recovery flow failed',
        )
        return
      }
    }

    if (choice === 'recover') {
      return await recover()
    }

    let registerOutcome: RegisterFlowOutcome
    try {
      registerOutcome = await runRegisterFlow({ cfg, accountId, prompter, apiBase })
    } catch (err) {
      if (err instanceof WizardCancelledError) throw err
      await prompter.note(
        `${err instanceof Error ? err.message : String(err)}`,
        'Registration flow failed',
      )
      return
    }

    if (registerOutcome === 'abort') {
      // User can still paste an existing key at the credential step.
      await prompter.note(
        'Registration was not completed. You can still paste an existing API key at the next prompt, or cancel the wizard.',
        'Falling back to credential entry',
      )
      return
    }
    if (registerOutcome === 'user-chose-paste') {
      // User picked the "paste my existing key" branch from inside the
      // register flow — they already acknowledged what's next, so don't
      // re-surface the generic fallback note. Fall through to the
      // credential step which will prompt for the key.
      return
    }
    if (registerOutcome === 'user-chose-recover') {
      // The email is at its agent limit and the user wants the key of one
      // of the agents it already backs. Hand off to recovery; it asks for
      // the handle and the email again — the register flow's email is a
      // reasonable guess but not necessarily the one that agent registered
      // with, so it is not pre-filled.
      return await recover()
    }
    return registerOutcome
  },

  credentials: [
    {
      inputKey: 'token',
      providerHint: 'agentchat',
      credentialLabel: 'API key',
      preferredEnvVar: 'AGENTCHAT_API_KEY',
      envPrompt: 'AGENTCHAT_API_KEY detected in env. Use it?',
      keepPrompt: 'AgentChat API key already configured. Keep it?',
      inputPrompt: 'Paste your AgentChat API key (ac_live_…)',
      helpTitle: 'AgentChat API key',
      helpLines: [
        'Format: ac_live_<base64>, ≥20 chars. Validated against',
        'GET /v1/agents/me during this wizard — bad keys fail fast instead',
        'of flapping reconnects at runtime.',
      ],
      allowEnv: () => true,
      shouldPrompt: ({ credentialValues, currentValue }) => {
        // Post-register: we already minted + persisted the key in prepare.
        if (credentialValues[JUST_REGISTERED_SENTINEL] === '1') return false
        // No key yet: always prompt.
        if (!currentValue) return true
        // Existing key + user didn't choose register: show keep/replace.
        return true
      },
      inspect: ({ cfg, accountId }) => {
        const apiKey = readAgentchatConfigField(cfg, accountId, 'apiKey')
        const configured = isApiKeyPresent(apiKey)
        // Delegated to the credential helper — see SECURITY.md.
        const envValue = readApiKeyFromEnv(MIN_API_KEY_LENGTH)
        return {
          accountConfigured: configured,
          hasConfiguredValue: configured,
          resolvedValue: configured ? apiKey : undefined,
          envValue,
        }
      },
    },
  ],

  finalize: async ({ cfg, accountId, credentialValues, prompter }) => {
    const apiKey =
      typeof credentialValues.token === 'string' && credentialValues.token.length >= MIN_API_KEY_LENGTH
        ? credentialValues.token
        : readAgentchatConfigField(cfg, accountId, 'apiKey')

    if (!apiKey || !isApiKeyPresent(apiKey)) {
      // Nothing to validate — prepare aborted and credential step got skipped
      // or the user bailed mid-flow. The `configure` call above will still
      // write whatever cfg we return; nothing more to do here.
      return
    }

    const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase')
    const spinner = prompter.progress('Validating API key against AgentChat…')
    try {
      const result = await validateApiKey(apiKey, { apiBase })
      if (result.ok) {
        spinner.stop(`Authenticated as @${result.agent.handle}`)

        // Write the persistent identity anchor into the workspace
        // AGENTS.md so the agent is aware of its handle on every turn
        // of every session — see binding/agents-anchor.ts header for
        // the full rationale (TL;DR: messageToolHints only fires when
        // AgentChat is the active channel; AGENTS.md is loaded every
        // turn regardless of channel context).
        //
        // Best-effort by intent: a workspace that's read-only or a
        // permission error must NOT bounce the wizard back to the user
        // — they have a working key and config; the anchor is a
        // nice-to-have that they can repair offline. Substitution
        // failures (handle didn't land in the file) are the one error
        // we surface, since they indicate a code regression and
        // leaving a broken anchor on disk would be worse than the
        // notice.
        try {
          writeAgentsAnchor({ cfg, handle: result.agent.handle })
        } catch (err) {
          await prompter.note(
            [
              err instanceof Error ? err.message : String(err),
              '',
              'Identity anchor write to AGENTS.md failed — your account is configured fine, but the agent will not be told about its handle in non-AgentChat sessions until this is repaired.',
            ].join('\n'),
            'AgentChat anchor warning',
          )
        }

        // If the wizard registered fresh, agentHandle is already in cfg.
        // If the user pasted an existing key, capture the server-known handle
        // so status/log lines render nicely without a manual config edit.
        const existingHandle = readAgentchatConfigField(cfg, accountId, 'agentHandle')
        if (!existingHandle && isValidHandleShape(result.agent.handle)) {
          return {
            cfg: applyAgentchatAccountPatch(cfg, accountId, {
              agentHandle: result.agent.handle,
            }),
          }
        }
        return
      }

      spinner.stop(`API key did not pass the live check (${result.reason})`)
      await prompter.note(
        [
          result.message,
          '',
          'The config was saved — you can re-run `openclaw channels add agentchat`',
          'to replace the key, or edit ~/.openclaw/config.yaml directly.',
        ].join('\n'),
        'AgentChat validation warning',
      )
    } catch (err) {
      spinner.stop('Could not reach AgentChat for validation')
      await prompter.note(
        [
          err instanceof Error ? err.message : String(err),
          '',
          'The config was saved — the runtime will retry on startup.',
        ].join('\n'),
        'AgentChat API unreachable',
      )
    }
    return
  },

  completionNote: {
    title: 'AgentChat is ready',
    // After our wizard returns, OpenClaw's setupChannels keeps running
    // its own outer flow (a Select-a-channel loop, then optional
    // follow-up prompts for display names and channel→agent binding).
    // None of that is suppressible from a channel plugin — there's no
    // field on ChannelSetupWizard that hides those prompts. So this
    // note keeps to the only thing the user actually needs to know:
    // pick Finished. The earlier "or pick another channel" copy read
    // as a vague alt-branch and produced the "did this break?"
    // reaction; one direct sentence is the cure.
    lines: ['On the next prompt, choose "Finished" to exit.'],
  },

  // `disable` fires on `openclaw channels remove agentchat`. We strip
  // the persistent AGENTS.md anchor here so the agent stops being told
  // it's @handle on AgentChat the moment the channel is removed.
  // Best-effort: a swallow on FS errors is intentional — the channel
  // remove must not be blocked by a stale anchor we can't clean up.
  // Plugin uninstall (`openclaw plugins uninstall`) does not currently
  // fire any plugin hook (openclaw#5985, #54813) so this only runs
  // when the user explicitly removes the channel; orphan blocks are
  // documented in RUNBOOK.md.
  disable: (cfg) => {
    try {
      removeAgentsAnchor({ cfg })
    } catch {
      // Anchor cleanup is best-effort — never block the channel-remove.
    }
    return setSetupChannelEnabled(cfg, AGENTCHAT_CHANNEL_ID, false)
  },
}
