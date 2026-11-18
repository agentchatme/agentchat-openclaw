/**
 * AgentChat channel setup wizard.
 *
 * The interactive onboarding OpenClaw's `setup` driver runs after
 * `openclaw plugins install @agentchatme/openclaw` and
 * `openclaw channels add agentchat`. AgentChat issues its own identities, so
 * a new user gets a key without leaving the CLI: register a new agent, paste
 * an existing key, or recover a lost one.
 *
 * Register and recover run the SDK's sign-up helper
 * (`integration.account.run`). Every answer of AgentChat's sign-up
 * endpoints says what comes next (contract v1, "Sign-up flows"), and the
 * helper follows it: it shows the server's sentence, asks again only for
 * the input the server names (a taken handle re-asks the handle, an email
 * at its limit the email), sits out the waits the server announces, and
 * offers a new code when the code is gone. This file keeps no rule of its
 * own (no handle shape, no attempt cap, no limit); it wires OpenClaw's
 * prompter in as the helper's `ask` / `show` and saves the key.
 *
 * Flow:
 *   1. `status.resolveConfigured` — "configured / not configured" for
 *      `openclaw setup`'s pre-selection summary.
 *   2. `prepare` — before the credential step:
 *        - "Register" / "Recover" → the helper's conversation. The key it
 *          returns is saved with the handle the server returned, and a
 *          sentinel in credentialValues skips the credential step's prompt.
 *          Recovery pre-fills the handle already configured here, because
 *          the common case is "the key I have configured stopped working".
 *        - "I have a key" → returns; OpenClaw's credential step asks next.
 *   3. `credentials[0]` — OpenClaw's API-key step (a pasted key, or the one
 *      in AGENTCHAT_API_KEY). The key is checked with AgentChat before it is
 *      saved (`applySet` / `applyUseEnv`): a key AgentChat turns away is
 *      never saved, and a key it accepts is saved with its handle.
 *   4. `finalize` — checks the key, reports the handle, and places the
 *      integration: the key in its key file (a plain-text key from an
 *      earlier release is moved there) and in OpenClaw's `.env` for the
 *      hosted tools, the served identity line
 *      in AGENTS.md, the hosted MCP server in `mcp.servers.agentchat`
 *      (returned as a config patch for OpenClaw to persist). Never throws on
 *      transport errors (a fresh clone behind a proxy still saves config and
 *      the runtime retries later).
 *
 * Writes go through `applyAgentchatAccountPatch` — the same helper behind
 * `setup.applyAccountConfig`, so the non-interactive `openclaw channels add
 * agentchat --token-file <path>` path and the wizard converge on the same
 * config shape: the key in its own owner-only key file, `apiKeyFile` naming
 * it in the config, never the key itself.
 *
 * `disable` wires `setSetupChannelEnabled` so `openclaw channels remove
 * --channel agentchat` produces `channels.agentchat.enabled: false` and keeps the
 * key file on disk (in case the operator just wants to pause, not rotate).
 */

import { ConnectionError, integration } from 'agentchatme'
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
  agentchatReenableHint,
  applyAgentchatAccountPatch,
  isAgentchatAccountEnabled,
  isApiKeyPresent,
  readAgentchatConfigField,
} from './channel-account.js'
import { accountCallOptions, checkApiKey, type KeyCheck } from './setup-client.js'
// Credential lookup helper — see SECURITY.md for why this lives in a
// separate module and must not be inlined into the wizard.
import { readApiKeyFromEnv } from './credentials/read-env.js'
import {
  placeIntegration,
  formatPlacement,
  applyIntegrationConfig,
  stripIntegrationConfig,
  storeAccountKey,
  keyCopiesAfterRunLine,
} from './integration/placement.js'
import { readAgentchatApiKey, resolveAgentchatApiKey } from './channel-key.js'
import { openclawCommand } from './cli-command.js'
import { DEFAULT_API_BASE } from './integration/mcp.js'
import { loadIdentityLine } from './integration/texts.js'
import { createSdkClient } from './binding/sdk-client.js'

type AccountKind = integration.AccountKind
type AccountQuestion = integration.AccountQuestion
type AccountAnswer = integration.AccountAnswer

/**
 * Sentinel credential-values key used to signal "the register or recover
 * path in prepare already minted + persisted the API key, don't re-prompt".
 * Framework-level prompt skipping is per-credential; we read this in
 * `shouldPrompt` below. The leading underscore keeps it out of any
 * `keyof ChannelSetupInput` path.
 */
const JUST_REGISTERED_SENTINEL = '_agentchatJustRegistered' as const

/**
 * The field labels: the helper's (`DEFAULT_LABELS`), with the handle named
 * for what it is. The rules for each field are the server's; its answer
 * says what to change.
 */
const LABELS: integration.AccountLabels = {
  ...integration.account.DEFAULT_LABELS,
  handle: 'Handle (your @name on AgentChat)',
}

function hasConfiguredKey(cfg: OpenClawConfig | undefined, accountId: string): boolean {
  return readAgentchatApiKey(cfg, accountId) !== undefined
}

/**
 * Store a key the person has (issued by register or recover, or entered
 * and accepted): its own owner-only key file, and the config patch that
 * names the file — never the key. The `.env` line for the hosted tools is
 * placed by `finalize`, so a wizard left before the end changes no `.env`.
 * A key file that cannot be written must not lose the key: the patch then
 * keeps it as the plain-text `apiKey` of earlier releases (doctor says so,
 * and `openclaw doctor --fix` moves it once the directory is writable).
 */
function storeKeyPatch(accountId: string, apiKey: string): { patch: Record<string, unknown>; file?: string; problem?: string } {
  try {
    // The key file only: the .env line is placed by finalize, with the config the wizard returns.
    const stored = storeAccountKey(accountId, apiKey, { dotenv: 'never' })
    return { patch: { apiKeyFile: stored.file, apiKey: undefined }, file: stored.file }
  } catch (err) {
    return { patch: { apiKey, apiKeyFile: undefined }, problem: `the key file could not be written (${err instanceof Error ? err.message : String(err)}); the key is kept in openclaw.json for now — run \`${openclawCommand('doctor --fix')}\` once the directory is writable` }
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
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

// ─── Register and recover: the SDK's helper, OpenClaw's prompter ─────────

/** What `prepare` returns when register or recover saved a key. */
type Prepared = { cfg: OpenClawConfig; credentialValues: ChannelSetupWizardCredentialValues }

/**
 * An email or handle, typed. An empty answer is not sent (OpenClaw's own
 * "Required"); everything else goes to the server, whose answer says what
 * to change. Leaving the question is the prompter's cancel.
 */
async function askText(
  prompter: WizardPrompter,
  message: string,
  opts: { readonly placeholder?: string } = {},
): Promise<string> {
  return (
    await prompter.text({
      message,
      ...opts,
      validate: (value) => (value.trim() ? undefined : 'Required'),
    })
  ).trim()
}

const EMAIL_PLACEHOLDER = 'you@example.com'

/**
 * The code question. The person types the code, or leaves it blank to
 * choose: a new code, back to the code, or cancel.
 */
async function askCode(prompter: WizardPrompter, label: string): Promise<AccountAnswer> {
  for (;;) {
    const code = (
      await prompter.text({ message: label, placeholder: 'leave blank for a new code or to cancel' })
    ).trim()
    if (code) return { answer: 'value', value: code }
    const choice = await prompter.select<'new_code' | 'enter' | 'cancel'>({
      message: 'What would you like to do?',
      options: [
        { value: 'new_code', label: 'Send a new code' },
        { value: 'enter', label: 'Enter the code' },
        { value: 'cancel', label: 'Cancel', hint: 'paste an existing key instead, or leave setup' },
      ],
      initialValue: 'new_code',
    })
    if (choice === 'new_code') return { answer: 'new_code' }
    if (choice === 'cancel') return { answer: 'cancel' }
  }
}

/** OpenClaw's prompter as the helper's `ask`: one question, one prompt. */
function askThrough(prompter: WizardPrompter): (question: AccountQuestion) => Promise<AccountAnswer> {
  return async (question) => {
    if (question.field === 'new_code') {
      const yes = await prompter.confirm({ message: 'Send a new code?', initialValue: true })
      return yes ? { answer: 'new_code' } : { answer: 'cancel' }
    }
    if (question.field === 'code') return askCode(prompter, question.label ?? LABELS.code)
    const label = question.label ?? LABELS[question.field]
    // HANDLE_REQUIRED: the server listed the handles on this email.
    const handles = (question.handles ?? []).filter((handle) => handle.length > 0)
    if (handles.length > 0) {
      const picked = await prompter.select<string>({
        message: label,
        options: [
          ...handles.map((handle) => ({ value: handle, label: `@${handle}` })),
          { value: '', label: 'Another handle' },
        ],
      })
      if (picked) return { answer: 'value', value: picked }
    }
    const typed = await askText(prompter, label, question.field === 'email' ? { placeholder: EMAIL_PLACEHOLDER } : {})
    return { answer: 'value', value: typed }
  }
}

/** Every call to AgentChat runs under a spinner; `stop()` without a message clears it. */
function fetchWithProgress(prompter: WizardPrompter): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const progress = prompter.progress('Contacting AgentChat…')
    try {
      return await globalThis.fetch(input, init)
    } finally {
      progress.stop()
    }
  }) as typeof fetch
}

/** A wait the server announced, sat out under a countdown. */
function sleepWithProgress(prompter: WizardPrompter): (ms: number) => Promise<void> {
  const label = (seconds: number) => `Waiting ${seconds} s…`
  return (ms) =>
    new Promise<void>((resolve) => {
      let left = Math.ceil(ms / 1000)
      const progress = prompter.progress(label(left))
      const tick = setInterval(() => {
        left -= 1
        if (left > 0) progress.update(label(left))
      }, 1000)
      setTimeout(() => {
        clearInterval(tick)
        progress.stop()
        resolve()
      }, ms)
    })
}

/** What register asks before the first call: the email, the handle, the display name. */
async function registerInput(prompter: WizardPrompter): Promise<Partial<integration.RegisterInput>> {
  await prompter.note(
    [
      'Registration creates a new AgentChat agent tied to your email address.',
      'Your handle is the agent’s @name on AgentChat. AgentChat emails you a',
      'code to confirm the address — check your inbox (and spam).',
    ].join('\n'),
    'AgentChat: register a new agent',
  )
  const email = await askText(prompter, LABELS.email, { placeholder: EMAIL_PLACEHOLDER })
  const handle = await askText(prompter, LABELS.handle)
  // The visible prompt deliberately does not say "optional": an agent
  // without a display name is a valid account, but framing it as optional
  // left about half of registrations rendering as @handle only. The
  // placeholder says what the field is for.
  const displayName = (
    await prompter.text({
      message: 'Display name (shown next to your @handle)',
      placeholder: 'e.g. Anton, Builder Bot, Sasha',
    })
  ).trim()
  return { email, handle, ...(displayName ? { display_name: displayName } : {}) }
}

/**
 * What recover knows before the first call. The email is asked by the
 * helper. The handle configured here is offered (Enter keeps it; blank
 * sends none); without one, none is sent, and the server asks for it when
 * the email backs more than one agent.
 */
async function recoverInput(
  prompter: WizardPrompter,
  configuredHandle: string | undefined,
): Promise<Partial<integration.RecoverInput>> {
  await prompter.note(
    [
      'Recovery issues a new API key for an agent you registered. AgentChat',
      'emails a code to the address the agent registered with; the old key',
      'stops working once the new one is issued.',
      ...(configuredHandle
        ? ['', `@${configuredHandle} is configured here — press Enter at the handle prompt to recover it.`]
        : []),
    ].join('\n'),
    'AgentChat: recover a lost API key',
  )
  if (!configuredHandle) return {}
  const handle = (await prompter.text({ message: LABELS.handle, initialValue: configuredHandle })).trim()
  return handle ? { handle } : {}
}

/** The flow ended without a key: say so; OpenClaw's credential step asks for a key next. */
async function notCompleted(prompter: WizardPrompter, kind: AccountKind): Promise<undefined> {
  await prompter.note(
    `${kind === 'register' ? 'Registration' : 'Recovery'} was not completed. You can still paste an existing API key at the next prompt, or cancel the wizard.`,
    'Falling back to credential entry',
  )
  return undefined
}

/**
 * Register a new agent, or recover a lost key, with the SDK's helper. The
 * server's sentences are shown as they come (`show`); the helper asks only
 * what the server names. A key is saved only from the helper's `done`, with
 * the handle the server returned.
 */
async function runAccountFlow(params: {
  kind: AccountKind
  cfg: OpenClawConfig
  accountId: string
  prompter: WizardPrompter
}): Promise<Prepared | undefined> {
  const { kind, cfg, accountId, prompter } = params
  const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase')
  const input =
    kind === 'register'
      ? await registerInput(prompter)
      : await recoverInput(prompter, nonEmpty(readAgentchatConfigField(cfg, accountId, 'agentHandle')))

  let result: integration.AccountRunResult
  try {
    result = await integration.account.run({
      kind,
      input,
      labels: LABELS,
      ask: askThrough(prompter),
      show: (message) => prompter.note(message, 'AgentChat'),
      sleep: sleepWithProgress(prompter),
      ...accountCallOptions({ apiBase, fetch: fetchWithProgress(prompter) }),
    })
  } catch (err) {
    if (err instanceof WizardCancelledError) throw err
    const unreached = err instanceof ConnectionError || (err instanceof Error && err.name === 'AbortError')
    await prompter.note(
      err instanceof Error ? err.message : String(err),
      unreached ? 'Could not reach AgentChat' : `${kind === 'register' ? 'Registration' : 'Recovery'} failed`,
    )
    return notCompleted(prompter, kind)
  }
  if (result.outcome !== 'done') return notCompleted(prompter, kind)

  // The key is the identity: the config describes the handle the server
  // returned, never the one typed. The key is stored at once — AgentChat
  // issues it once (a recover ends the old key), so a setup cancelled after
  // this point must not lose it.
  const stored = storeKeyPatch(accountId, result.apiKey)
  const nextCfg = applyAgentchatAccountPatch(cfg, accountId, { ...stored.patch, agentHandle: result.handle })
  await prompter.note(
    [
      `Handle:   @${result.handle}`,
      `API key:  ${redactKey(result.apiKey)} (${stored.file ? `stored in ${stored.file}, readable only by you; openclaw.json holds only its path` : 'saved to your OpenClaw config'})`,
      ...(stored.problem ? ['', stored.problem] : []),
    ].join('\n'),
    kind === 'register' ? 'AgentChat account created' : 'AgentChat API key recovered',
  )
  return {
    cfg: nextCfg,
    credentialValues: {
      token: result.apiKey,
      [JUST_REGISTERED_SENTINEL]: '1',
    },
  }
}

function redactKey(apiKey: string): string {
  if (apiKey.length < 12) return '••••'
  return `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`
}

// ─── A key the person has: checked before it is saved ──────────────────

/**
 * Save a key the person entered (pasted, or the one in AGENTCHAT_API_KEY)
 * only if AgentChat does not turn it away. Accepted: saved with the handle
 * it belongs to, and the hosted tools entry. Turned away: the config stays
 * as it was (`finalize` shows the server's answer). No answer: nothing is
 * known about the key, so it is saved for the runtime to try, without a
 * handle unless it is the key already configured.
 *
 * `value` is what OpenClaw's credential step produced: the key itself, or
 * a secret reference, which this config does not hold (left unchanged;
 * `finalize` still places the resolved key).
 */
async function saveEnteredKey(cfg: OpenClawConfig, accountId: string, value: unknown, key: string): Promise<OpenClawConfig> {
  if (typeof value !== 'string' || !nonEmpty(key)) return cfg
  const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase')
  let check: KeyCheck | null
  try {
    check = await checkApiKey(key, { apiBase })
  } catch {
    check = null
  }
  if (check !== null && !check.ok) return cfg
  const handle = check?.handle
  const sameKey = readAgentchatApiKey(cfg, accountId) === key
  const stored = storeKeyPatch(accountId, key)
  const withKey = applyAgentchatAccountPatch(cfg, accountId, {
    ...stored.patch,
    // A new key whose handle is unknown must not keep the old key's handle.
    ...(handle ? { agentHandle: handle } : sameKey ? {} : { agentHandle: undefined }),
  })
  return applyIntegrationConfig(withKey, { accountId, handle, apiKey: key, apiBase: apiBase ?? DEFAULT_API_BASE }).cfg
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
      if (!isAgentchatAccountEnabled(cfg, id)) return [`AgentChat: configured${handle ? ` (@${handle})` : ''}; ${agentchatReenableHint(cfg, id)}`]
      return [`AgentChat: configured${handle ? ` (@${handle})` : ''}`]
    },
  },

  introNote: {
    title: 'AgentChat',
    lines: [
      'AgentChat is a messaging platform for AI agents — direct messages,',
      'groups, presence, attachments. Registration is free.',
      '',
      'This wizard registers a new agent by email code, accepts an existing',
      'API key, or recovers a lost key by email code — your choice in the',
      'next prompt.',
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
          label: 'Register a new agent (email code)',
          hint: 'no account yet — the wizard creates one',
        },
        {
          value: 'paste',
          label: 'I already have an API key',
          hint: 'paste ac_… on the next prompt',
        },
        {
          value: 'recover',
          label: 'Recover a lost API key (email code)',
          hint: 'an agent exists but its key is gone — re-issue it',
        },
      ],
      initialValue: 'register',
    })

    if (choice === 'paste') return
    return await runAccountFlow({ kind: choice, cfg, accountId, prompter })
  },

  credentials: [
    {
      inputKey: 'token',
      providerHint: 'agentchat',
      credentialLabel: 'API key',
      preferredEnvVar: 'AGENTCHAT_API_KEY',
      envPrompt: 'AGENTCHAT_API_KEY detected in env. Use it?',
      keepPrompt: 'AgentChat API key already configured. Keep it?',
      inputPrompt: 'Paste your AgentChat API key (ac_…)',
      helpTitle: 'AgentChat API key',
      helpLines: [
        'AgentChat checks the key before it is saved: a key it does not',
        'accept is not saved, so a bad key fails here instead of flapping',
        'reconnects at runtime.',
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
        const apiKey = readAgentchatApiKey(cfg, accountId)
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
      // The key the person entered, checked before it is saved.
      applySet: ({ cfg, accountId, value, resolvedValue }) => saveEnteredKey(cfg, accountId, value, resolvedValue),
      applyUseEnv: ({ cfg, accountId }) => {
        const key = readApiKeyFromEnv(MIN_API_KEY_LENGTH)
        return key ? saveEnteredKey(cfg, accountId, key, key) : cfg
      },
    },
  ],

  finalize: async ({ cfg, accountId, credentialValues, prompter }) => {
    const stored = nonEmpty(readAgentchatApiKey(cfg, accountId))
    const apiKey = nonEmpty(credentialValues.token) ?? stored
    // Nothing to check: prepare ended without a key and the credential step
    // was skipped, or the user bailed mid-flow.
    if (!apiKey) return

    const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase')
    const spinner = prompter.progress('Checking the API key with AgentChat…')
    let check: KeyCheck
    try {
      check = await checkApiKey(apiKey, { apiBase })
    } catch (err) {
      spinner.stop('Could not reach AgentChat to check the key')
      await prompter.note(
        [
          err instanceof Error ? err.message : String(err),
          '',
          stored === apiKey ? 'The config was saved — the runtime will retry on startup.' : 'The key was not saved.',
        ].join('\n'),
        'AgentChat API unreachable',
      )
      return
    }

    if (!check.ok) {
      spinner.stop('AgentChat did not accept the API key')
      await prompter.note(
        [
          check.message,
          '',
          stored === apiKey
            ? `This key is the one in your OpenClaw config. Re-run \`${openclawCommand('channels add agentchat')}\` → Replace the API key to recover a lost key or paste another one.`
            : `The key was not saved. Re-run \`${openclawCommand('channels add agentchat')}\` to paste another key, register a new agent, or recover a lost key.`,
        ].join('\n'),
        'AgentChat API key not accepted',
      )
      return
    }

    spinner.stop(`Authenticated as @${check.handle}`)

    // Place the integration: the key in OpenClaw's state-dir `.env` (the
    // hosted tools' bearer header is a template on it), the served identity
    // line in AGENTS.md (loaded every turn), the manual (bundled), and the
    // hosted MCP server in `mcp.servers.agentchat`. Best-effort by intent: a
    // read-only workspace must NOT bounce the wizard — the key and config are
    // saved; the report says what to repair.
    const handle = check.handle
    const resolvedBase = apiBase ?? DEFAULT_API_BASE
    // A key kept in plain text in openclaw.json (an install from before the
    // key file, the person chose "keep"): setup moves it into a key file now.
    let keyCfg = cfg
    const source = resolveAgentchatApiKey(cfg, accountId)
    let moved: string | undefined
    if (source.ok && source.source === 'config' && source.apiKey === apiKey) {
      const storedKey = storeKeyPatch(accountId, apiKey)
      if (storedKey.file) {
        keyCfg = applyAgentchatAccountPatch(cfg, accountId, storedKey.patch)
        // OpenClaw writes the config after the wizard returns (its setup flow decides how often), so the
        // copies it then holds are named by a read-only check afterwards, not listed from the files as they are now.
        moved = [`✓ key moved out of openclaw.json: the plain-text channels.agentchat.apiKey is now a key file (${storedKey.file}, owner-only)`, keyCopiesAfterRunLine()].join('\n')
      }
    }
    const keyFile = readAgentchatConfigField(keyCfg, accountId, 'apiKeyFile')
    const identityLine = await loadIdentityLine({ client: createSdkClient({ apiKey, apiBase: resolvedBase }), accountId })
    const placed = placeIntegration({ cfg: keyCfg, handle, apiKey, apiBase: resolvedBase, identityLine, accountId })
    const failed = placed.steps.filter((s) => s.status === 'failed')
    const skipped = placed.steps.filter((s) => s.status === 'skipped' && s.name === 'anchor')
    await prompter.note(
      [
        ...(keyFile && !moved ? [`✓ key file: ${keyFile} (owner-only); openclaw.json holds only its path`] : []),
        ...(moved ? [moved] : []),
        ...formatPlacement(placed.steps),
        '',
        placed.mcp === 'added' || placed.steps.some((s) => s.name === 'key' && s.status === 'changed')
          ? `Restart the gateway once (\`${openclawCommand('gateway restart')}\`) so its environment carries the key and it connects the hosted tools. Then \`${openclawCommand('channels capabilities --channel agentchat')}\` shows the integration and the tools.`
          : 'The agent is reachable: a peer\'s message wakes it; the agent decides with its own model; it answers through the hosted AgentChat tools.',
        ...(failed.length > 0
          ? ['', `Some placement failed (above). Your account is configured; re-run \`${openclawCommand('channels add agentchat')}\` after fixing the path, or \`${openclawCommand('doctor --fix')}\` for the config entry.`]
          : []),
        ...(skipped.length > 0 ? ['', `The identity line waits for AgentChat to be reachable: run \`${openclawCommand('doctor --fix')}\` then.`] : []),
      ].join('\n'),
      'AgentChat integration placed',
    )

    // The config side of placement: the handle the key authenticates as
    // (configured-state, doctor and the own-echo filter need it), the
    // hosted tools entry, and the llm override opt-in when this account
    // is bound to an agent other than OpenClaw's default.
    const applied = applyIntegrationConfig(placed.cfg, { accountId, handle, apiKey, apiBase: resolvedBase })
    return { cfg: applied.cfg }
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

  // `disable` fires on `openclaw channels remove --channel agentchat`. We strip the
  // AGENTS.md identity line and our own `mcp.servers.agentchat` entry so the
  // agent stops being told it is @handle on AgentChat and stops seeing the
  // hosted tools the moment the channel is removed. The key stays in the
  // channel config and in `.env` (a remove is a pause, not a rotation).
  // Best-effort: FS errors never block the channel-remove. Plugin uninstall
  // (`openclaw plugins uninstall`) fires no plugin hook, so this only runs
  // when the user explicitly removes the channel; orphans are documented in
  // RUNBOOK.md.
  disable: (cfg) => {
    // The config side only, same as `config.setAccountEnabled(false)`: the
    // plugin's own mcp.servers.agentchat entry goes (matched by URL +
    // transport on the env-substituted config), the key stays — a remove is
    // a pause, not a rotation. Files (the identity line) are removed by the
    // lifecycle hook after the patch is checked, never from a pure adapter.
    return setSetupChannelEnabled(stripIntegrationConfig(cfg, 'default').cfg, AGENTCHAT_CHANNEL_ID, false)
  },
}
