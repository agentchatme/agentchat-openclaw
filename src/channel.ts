/**
 * AgentChat channel plugin — entry point.
 *
 * The plugin is AgentChat's integration for OpenClaw (`docs/architecture.md`
 * in the core repo): it holds the socket for the account through the
 * `agentchatme` SDK, shows the server's cards and question to the agent's
 * own model through the SDK's gate helper, starts one turn per conversation
 * decided reply, and places the key, the served identity line, the hosted
 * tools and the manual where OpenClaw loads them. Nothing of the product
 * lives here — no tools, no gate wording, no message parsing, no delivery
 * semantics, no copied texts. The channel therefore carries only `gateway`,
 * `status` and `doctor` adapters: the agent's send is the hosted
 * `agentchat__agentchat_send_message` tool, not OpenClaw's `message` tool,
 * so there is no outbound adapter to route to.
 *
 * Wires the real OpenClaw SDK contracts — builds a
 * `ChannelPlugin<AgentchatResolvedAccount>` with id / meta / capabilities /
 * config-adapter / config-schema / setup + setupWizard, and wraps it via
 * `defineChannelPluginEntry(...)` for OpenClaw's extension loader. The
 * entry's `setRuntime` hands the integration OpenClaw's `PluginRuntime`
 * (`llm.complete` for the gate, `subagent.run` for the turn).
 *
 * Config adapter supports both:
 *   - single-account flat form: `channels.agentchat.{ apiKey, apiBase, ... }`
 *   - multi-account form:       `channels.agentchat.accounts.<id>.{ apiKey, ... }`
 *
 * Loaded by OpenClaw via `package.json`'s `openclaw.extensions` entry.
 */

import {
  buildChannelConfigSchema,
  defineChannelPluginEntry,
  type ChannelConfigUiHint,
  type ChannelPlugin,
} from 'openclaw/plugin-sdk/channel-core'
import { deleteAccountFromConfigSection, setAccountEnabledInConfigSection } from 'openclaw/plugin-sdk/channel-plugin-common'
import { WizardCancelledError, type ChannelSetupInput } from 'openclaw/plugin-sdk/setup'
import { createHash } from 'node:crypto'

import {
  AGENTCHAT_CHANNEL_ID,
  AGENTCHAT_DEFAULT_ACCOUNT_ID,
  MIN_API_KEY_LENGTH,
  applyAgentchatAccountPatch,
  isAgentchatAccountEnabled,
  isApiKeyPresent,
  readAccountRaw,
  readAgentchatConfigField,
  readChannelSection,
  splitEnabledFromRaw,
} from './channel-account.js'
import { agentchatSetupWizard } from './channel.wizard.js'
import {
  agentchatChannelConfigSchema,
  parseChannelConfig,
  type AgentchatChannelConfig,
} from './config-schema.js'
import { checkApiKey, type KeyCheck } from './setup-client.js'
import { registerReleaseCli, registerReleaseGatewayMethod } from './binding/release.js'
import { registerRunObserver } from './binding/run-observer.js'

import {
  agentchatGatewayAdapter,
  agentchatStatusAdapter,
  agentchatDoctorAdapter,
  type AgentchatProbeResult,
} from './binding/index.js'
import {
  placeIntegration,
  formatPlacement,
  applyIntegrationConfig,
  stripIntegrationConfig,
  removeIntegrationFiles,
  restoreIdentityLine,
  storeAccountKey,
  describeKeyCopies,
  openClawCopiesHoldingKey,
  dotEnvPath,
} from './integration/placement.js'
import { namesApiKey, readAgentchatApiKey } from './channel-key.js'
import { apiKeyFilePathFor, readTokenFile } from './credentials/key-file.js'
import { setPluginRuntime } from './integration/runtime-holder.js'
import { DEFAULT_API_BASE } from './integration/mcp.js'
import { loadIdentityLine } from './integration/texts.js'
import { createSdkClient } from './binding/sdk-client.js'

export {
  AGENTCHAT_CHANNEL_ID,
  AGENTCHAT_DEFAULT_ACCOUNT_ID,
  MIN_API_KEY_LENGTH,
  applyAgentchatAccountPatch,
  isApiKeyPresent,
  readAgentchatConfigField,
} from './channel-account.js'

export interface AgentchatResolvedAccount {
  accountId: string
  enabled: boolean
  configured: boolean
  config: AgentchatChannelConfig | null
  parseError: string | null
}

/**
 * Resolve the config section for a single account. Pure function —
 * extracted from `config.resolveAccount` so `agentPrompt` (session-
 * start identity setup) can reuse it without a self-reference
 * back into the plugin object literal. Never throws: parse failures
 * are surfaced via `parseError` on the returned record.
 *
 * Takes `OpenClawConfig | undefined` to match `ChannelConfigAdapter.
 * resolveAccount`'s signature so they can share this implementation
 * directly without casting.
 */
export function resolveAgentchatAccount(
  cfg: import('./binding/openclaw-types.js').OpenClawConfig | undefined,
  accountId?: string | null,
): AgentchatResolvedAccount {
  const id = accountId ?? AGENTCHAT_DEFAULT_ACCOUNT_ID
  const section = readChannelSection(cfg)
  const raw = readAccountRaw(section, id)
  const { enabled, forParse } = splitEnabledFromRaw(raw)
  let config: AgentchatChannelConfig | null = null
  let parseError: string | null = null
  if (forParse && Object.keys(forParse).length > 0) {
    try {
      config = parseChannelConfig(forParse)
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e)
    }
  }
  const configured = Boolean(config && isApiKeyPresent(config.apiKey))
  return { accountId: id, enabled, configured, config, parseError }
}

const uiHints: Record<string, ChannelConfigUiHint> = {
  apiKeyFile: {
    label: 'AgentChat API key file',
    placeholder: '~/.openclaw/agentchat/default/keys/key-…',
    help: 'The owner-only (0600) file that holds the API key; openclaw.json holds only this path. The setup wizard registers a new agent or recovers a lost key by email code, or accepts an existing ac_… key (non-interactive: --token-file <path>); setup checks a key with AgentChat before storing it.',
  },
  apiKey: {
    label: 'AgentChat API key (plain text, earlier releases)',
    placeholder: 'ac_…',
    sensitive: true,
    advanced: true,
    help: 'Where releases before the key file kept the key, in plain text in openclaw.json. Still read; `openclaw doctor --fix` and setup move it to apiKeyFile.',
  },
  apiBase: {
    label: 'API base URL',
    placeholder: 'https://api.agentchat.me',
    help: 'Override only when targeting a self-hosted AgentChat instance.',
    advanced: true,
  },
  agentHandle: {
    label: 'Agent handle',
    placeholder: 'my-agent',
    help: 'The handle the API key belongs to, as AgentChat returned it; setup and `openclaw doctor --fix` write it.',
  },
  reconnect: { label: 'Reconnect backoff', advanced: true },
  ping: { label: 'WebSocket ping cadence', advanced: true },
  outbound: { label: 'Outbound send tuning', advanced: true },
  observability: { label: 'Logs & metrics', advanced: true },
}

/** The CLI runtime OpenClaw hands setup hooks (`RuntimeEnv`): `log`, `error`, `exit`. Nothing else — never `.logger`. */
type SetupRuntimeEnv = { log?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }

/**
 * The setup input with the channel-owned fields this plugin adds, both set
 * by `prepareAccountConfigInput`: `agentHandle`, learnt from the key and
 * written by `applyAccountConfig` in the same persisted write, and
 * `keyRefusal`, AgentChat's verdict on a key it turned away (or a key that
 * could not be read or stored), which `validateInput` returns so OpenClaw
 * writes nothing. `tokenFile` is OpenClaw's own `--token-file <path>`.
 */
type AgentchatSetupInput = ChannelSetupInput & { agentHandle?: string; keyRefusal?: string; tokenFile?: string }

/**
 * A handle as AgentChat returned it (a leading `@` dropped). The server
 * validated it; only an empty value is not a handle.
 */
function handleOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const bare = value.trim().replace(/^@/, '')
  return bare.length > 0 ? bare : undefined
}

/** What `channels add` prints when AgentChat turns the key away; OpenClaw then writes nothing. */
function keyRefusal(check: Extract<KeyCheck, { ok: false }>): string {
  return [
    `AgentChat did not accept the API key (${check.code}): ${check.message}`,
    'The key was not saved. Run `openclaw channels add agentchat` to register a new agent or recover a lost key (email code).',
  ].join('\n')
}

/** The non-interactive way to hand over a key without putting it on the command line. */
const TOKEN_FILE_HINT = '--token-file <path> (a file that holds only the key; - reads it from standard input)'

/**
 * The key a setup input carries. `--token-file <path>` (OpenClaw's own
 * channel-setup option; OpenClaw passes the path and reads nothing) is read
 * here; `--token` (the key itself) is still accepted, but it puts the key on the
 * command line, where any user of the machine can read it with `ps` while
 * the command runs, so the after-write report says so.
 */
type InputKey = { readonly apiKey: string; readonly via: 'token-file' | 'token' } | { readonly error: string } | null

function keyOfInput(input: AgentchatSetupInput): InputKey {
  const file = typeof input.tokenFile === 'string' && input.tokenFile.trim().length > 0 ? input.tokenFile : undefined
  const token = typeof input.token === 'string' && input.token.trim().length > 0 ? input.token.trim() : undefined
  if (file && token) return { error: 'pass the API key once: --token-file <path> or --token, not both' }
  if (file) {
    const read = readTokenFile(file)
    return read.ok ? { apiKey: read.apiKey, via: 'token-file' } : { error: `--token-file: ${read.reason}. The key was not saved.` }
  }
  return token ? { apiKey: token, via: 'token' } : null
}

/**
 * The key `prepareAccountConfigInput` asked AgentChat about and stored in
 * this process (its sha256, never the key), so the pre-write lifecycle hook
 * does not ask again: on an OpenClaw that runs both, a second check would
 * only repeat the verdict, or a second timeout when AgentChat is down.
 */
let keyAskedBeforeWrite: string | null = null
const keyDigest = (apiKey: string) => createHash('sha256').update(apiKey).digest('hex')

/**
 * A key `applyAccountConfig` pointed the config at, per account, until the
 * write is done. `applyAccountConfig` is pure and synchronous; on an
 * OpenClaw without `prepareAccountConfigInput` (2026.6.x–2026.9.x) the
 * lifecycle hook that runs before the write checks this key with AgentChat
 * and stores it — so a key AgentChat turns away never replaces a stored one.
 */
const pendingKeys = new Map<string, { readonly apiKey: string; readonly via: 'token-file' | 'token' }>()

function say(runtime: unknown, level: 'log' | 'error', line: string): void {
  const env = runtime as SetupRuntimeEnv | undefined
  const fn = env?.[level]
  if (typeof fn === 'function') fn(line)
}

/** Store an accepted key (key file + the `.env` line); a key file that cannot be written is a refusal (nothing saved). */
function storeKeyForSetup(accountId: string, apiKey: string, runtime: unknown): { ok: true } | { ok: false; refusal: string } {
  try {
    const stored = storeAccountKey(accountId, apiKey)
    if (stored.dotenvError) say(runtime, 'error', `[agentchat:${accountId}] could not write AGENTCHAT_API_KEY to ${dotEnvPath()}: ${stored.dotenvError}`)
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      refusal: `The API key could not be stored in ${accountKeyFilePath(accountId, apiKey)}: ${err instanceof Error ? err.message : String(err)}\nThe key was not saved.`,
    }
  }
}

function accountKeyFilePath(accountId: string, apiKey: string): string {
  return apiKeyFilePathFor(accountId, apiKey)
}

type BaseSetupAdapter = NonNullable<ChannelPlugin<AgentchatResolvedAccount>['setup']>

/**
 * `channels add agentchat --token-file <path>` (non-interactive) and the
 * wizard's credential step both go through this adapter. What OpenClaw
 * persists is exactly what `applyAccountConfig` returns — it is synchronous
 * — so everything that belongs in `openclaw.json` is written there: the
 * path of the key file (never the key), the API base, the handle the key
 * authenticates as (learnt just before, in `prepareAccountConfigInput`,
 * which 2026.10.x runs first and awaits), the hosted tools entry and, when
 * the account is bound to a non-default agent, the llm override opt-in.
 * The key file and the `.env` line are written before the config write,
 * once AgentChat accepted the key (or could not be asked):
 * `prepareAccountConfigInput` on 2026.10.x, the lifecycle hook that runs
 * before the write on older releases. `afterAccountConfigWritten` places
 * the identity line and reports through the CLI runtime it is given
 * (`RuntimeEnv.log/error`). It never relies on the plugin runtime: in
 * OpenClaw's setup-only registration mode that runtime is a proxy that
 * throws on access.
 *
 * `prepareAccountConfigInput` is absent from the 2026.6.10 types; the
 * adapter type is widened so the same object compiles against both.
 */
export const agentchatSetupAdapter: BaseSetupAdapter & {
  prepareAccountConfigInput?: (params: {
    cfg: import('./binding/openclaw-types.js').OpenClawConfig
    accountId: string
    input: AgentchatSetupInput
    runtime: unknown
  }) => Promise<AgentchatSetupInput>
} = {
  /**
   * Pre-write gate: a key AgentChat turned away in
   * `prepareAccountConfigInput` ends here (OpenClaw prints the line and
   * writes nothing); otherwise a cheap, sync check that the caller supplied
   * an API key (the token file is read here) that's at least plausibly
   * shaped. On an OpenClaw without `prepareAccountConfigInput`, the
   * lifecycle hook refuses a rejected key before the write.
   */
  validateInput({ input }) {
    const refusal = (input as AgentchatSetupInput).keyRefusal
    if (typeof refusal === 'string' && refusal.length > 0) return refusal
    const key = keyOfInput(input as AgentchatSetupInput)
    if (key === null) {
      return `an API key is required — pass ${TOKEN_FILE_HINT}, or run \`openclaw channels add agentchat\` to register a new agent or recover a lost key (email code)`
    }
    if ('error' in key) return key.error
    if (key.apiKey.length < MIN_API_KEY_LENGTH) {
      return `apiKey looks too short (got ${key.apiKey.length} chars, expect ≥${MIN_API_KEY_LENGTH})`
    }
    if (typeof input.url === 'string' && input.url.length > 0) {
      try {
        const parsed = new URL(input.url)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return 'apiBase must be http(s) — e.g. https://api.agentchat.me'
        }
      } catch {
        return 'apiBase is not a valid URL'
      }
    }
    return null
  },

  /**
   * Ask AgentChat about the key BEFORE the write. Accepted: the key is
   * stored (key file, `.env` line) and the handle it belongs to goes into
   * the same config write OpenClaw already makes. Turned away (401 / 403):
   * the input carries the refusal, `validateInput` returns it, and OpenClaw
   * writes nothing. No verdict (unreachable, a 5xx): the key is stored for
   * the runtime to try, as the wizard does.
   */
  async prepareAccountConfigInput({ cfg, accountId, input, runtime }) {
    const key = keyOfInput(input)
    if (key === null || 'error' in key || key.apiKey.length < MIN_API_KEY_LENGTH) return input
    const apiKey = key.apiKey
    // The base this write will hold: `--url`, else the one already configured.
    const apiBase =
      typeof input.url === 'string' && input.url.length > 0 ? input.url : readAgentchatConfigField(cfg, accountId, 'apiBase')
    keyAskedBeforeWrite = keyDigest(apiKey)
    let handle: string | undefined
    try {
      const result = await checkApiKey(apiKey, { apiBase })
      if (!result.ok) return { ...input, keyRefusal: keyRefusal(result) }
      handle = result.handle
      say(runtime, 'log', `[agentchat:${accountId}] authenticated as @${result.handle}`)
    } catch (err) {
      say(runtime, 'error', `[agentchat:${accountId}] no verdict on the API key, saving it for the runtime to try: ${err instanceof Error ? err.message : String(err)}`)
    }
    // The key file and the .env line NOW, before OpenClaw writes the config
    // and re-reads it: the config written next names the key file, and the
    // hosted tools entry references ${AGENTCHAT_API_KEY}.
    const stored = storeKeyForSetup(accountId, apiKey, runtime)
    if (!stored.ok) return { ...input, keyRefusal: stored.refusal }
    return handle ? { ...input, agentHandle: handle } : input
  },

  /**
   * The one persisted write. Synchronous by contract, so it carries
   * everything that can be known without I/O: the key file's path (the
   * plain-text `apiKey` of an earlier release removed), API base, the handle
   * (when `prepareAccountConfigInput` learnt it), the hosted tools entry,
   * the llm opt-in for a non-default bound agent.
   */
  applyAccountConfig({ cfg, accountId, input }) {
    const patch: Record<string, unknown> = {}
    const key = keyOfInput(input as AgentchatSetupInput)
    let apiKey: string | undefined
    if (key !== null && !('error' in key)) {
      apiKey = key.apiKey
      patch.apiKeyFile = accountKeyFilePath(accountId, apiKey)
      patch.apiKey = undefined
      pendingKeys.set(accountId, key)
    }
    if (typeof input.url === 'string' && input.url.length > 0) patch.apiBase = input.url
    const handle = handleOf((input as AgentchatSetupInput).agentHandle)
    if (handle) patch.agentHandle = handle
    const withAccount = applyAgentchatAccountPatch(cfg, accountId, patch)
    apiKey ??= readAgentchatApiKey(withAccount, accountId)
    if (!apiKey) return withAccount
    const apiBase = readAgentchatConfigField(withAccount, accountId, 'apiBase') ?? DEFAULT_API_BASE
    return applyIntegrationConfig(withAccount, { accountId, handle, apiKey, apiBase }).cfg
  },

  /**
   * After the write: the served identity line into the bound agent's
   * `AGENTS.md`, and a report through `RuntimeEnv.log`. Never throws:
   * setup-time UX is "warn and proceed".
   */
  async afterAccountConfigWritten({ previousCfg, cfg, accountId, input, runtime }) {
    const pending = pendingKeys.get(accountId)
    pendingKeys.delete(accountId)
    // The write is done: a later setup in this process asks AgentChat again.
    keyAskedBeforeWrite = null
    const fromInput = keyOfInput(input as AgentchatSetupInput)
    const via = pending?.via ?? (fromInput !== null && !('error' in fromInput) ? fromInput.via : undefined)
    const apiKey = pending?.apiKey ?? (fromInput !== null && !('error' in fromInput) ? fromInput.apiKey : undefined) ?? readAgentchatApiKey(cfg, accountId)
    if (!apiKey) return
    // An OpenClaw path that ran neither hook before the write: store the key
    // now, so the key file the config names exists.
    const keyFile = readAgentchatConfigField(cfg, accountId, 'apiKeyFile')
    if (keyFile && !readAgentchatApiKey(cfg, accountId)) {
      const stored = storeKeyForSetup(accountId, apiKey, runtime)
      if (!stored.ok) {
        say(runtime, 'error', `[agentchat:${accountId}] ${stored.refusal.replace('\n', ' ')} — run \`openclaw channels add agentchat\` again`)
        return
      }
      say(runtime, 'log', `[agentchat:${accountId}] stored the key in ${keyFile}; restart the gateway (\`openclaw gateway restart\`) so the channel reads it`)
    }
    const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase') ?? DEFAULT_API_BASE
    let handle = handleOf((input as AgentchatSetupInput).agentHandle) ?? handleOf(readAgentchatConfigField(cfg, accountId, 'agentHandle'))
    if (!handle) {
      // An OpenClaw without `prepareAccountConfigInput`: learn the handle now
      // for the identity line; the config gets it from `openclaw doctor --fix`.
      try {
        const result = await checkApiKey(apiKey, { apiBase })
        if (result.ok) {
          handle = result.handle
          say(runtime, 'log', `[agentchat:${accountId}] authenticated as @${handle}; run \`openclaw doctor --fix\` to persist channels.agentchat.agentHandle`)
        } else {
          say(runtime, 'error', `[agentchat:${accountId}] api key did not pass live check (${result.code}): ${result.message}`)
          return
        }
      } catch (err) {
        say(runtime, 'error', `[agentchat:${accountId}] live key validation failed: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
    try {
      const identityLine = await loadIdentityLine({ client: createSdkClient({ apiKey, apiBase }), accountId })
      const placed = placeIntegration({ cfg, handle, apiKey, apiBase, identityLine, accountId })
      if (keyFile) say(runtime, 'log', `[agentchat:${accountId}] ✓ key file: ${keyFile} (owner-only); openclaw.json holds only its path`)
      for (const line of formatPlacement(placed.steps.filter((s) => s.name !== 'mcp'))) say(runtime, 'log', `[agentchat:${accountId}] ${line}`)
      say(runtime, 'log', `[agentchat:${accountId}] ✓ config: agentHandle and mcp.servers.agentchat written with the account (restart the gateway — \`openclaw gateway restart\` — so the hosted tools resolve \${AGENTCHAT_API_KEY}: OpenClaw reads .env only at start)`)
    } catch (err) {
      say(runtime, 'error', `[agentchat:${accountId}] placement failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    // The plain-text key of an earlier release left openclaw.json in this
    // write; OpenClaw's own config copies may still hold it.
    const previousPlain = readAgentchatConfigField(previousCfg, accountId, 'apiKey')
    if (previousPlain && !readAgentchatConfigField(cfg, accountId, 'apiKey')) {
      say(runtime, 'log', `[agentchat:${accountId}] removed the plain-text channels.agentchat.apiKey from openclaw.json`)
      const copies = describeKeyCopies(openClawCopiesHoldingKey(previousPlain))
      if (copies) say(runtime, 'log', `[agentchat:${accountId}] ${copies}`)
    }
    if (via === 'token') {
      say(
        runtime,
        'error',
        `[agentchat:${accountId}] the key was on this command's command line (--token), where any user of this machine can read it (ps) while the command runs — next time pass ${TOKEN_FILE_HINT}`,
      )
    }
  },
}

type Cfg = import('./binding/openclaw-types.js').OpenClawConfig

/**
 * `channels remove agentchat` (disable): the config side only — keep the
 * key, drop the plugin's own hosted-tools entry, set `enabled: false`.
 * Pure: OpenClaw validates and persists what this returns; the files go in
 * `lifecycle.onAccountConfigChanged`, after the patch has been checked.
 */
export function disableAccountConfig(cfg: Cfg, accountId: string): Cfg {
  const stripped = stripIntegrationConfig(cfg, accountId).cfg
  return setAccountEnabledInConfigSection({ cfg: stripped, sectionKey: AGENTCHAT_CHANNEL_ID, accountId, enabled: false, allowTopLevel: true })
}

/** `channels remove agentchat --delete`: the config side only — the account and the plugin's own hosted-tools entry go. */
export function deleteAccountConfig(cfg: Cfg, accountId: string): Cfg {
  const stripped = stripIntegrationConfig(cfg, accountId).cfg
  return deleteAccountFromConfigSection({ cfg: stripped, sectionKey: AGENTCHAT_CHANNEL_ID, accountId, clearBaseFields: ['apiKey', 'apiKeyFile', 'apiBase', 'agentHandle'] })
}

function isAccountEnabled(cfg: Cfg | undefined, accountId: string): boolean {
  return isAgentchatAccountEnabled(cfg, accountId)
}

/**
 * The persisted account section must pass the plugin's own schema (the
 * same zod object OpenClaw's JSON-schema validation is emitted from).
 * OpenClaw runs the lifecycle hooks BEFORE it validates and persists a
 * removal (`applyChannelAccountRemoval` in 2026.10.9), so a hook that
 * touches files checks the patch itself first: a write OpenClaw would
 * refuse must not strand the identity line or the key.
 */
export function accountSectionPersistable(cfg: Cfg | undefined, accountId: string): boolean {
  const raw = readAccountRaw(readChannelSection(cfg), accountId)
  if (!raw) return true // no section: nothing for OpenClaw to refuse
  return agentchatChannelConfigSchema.safeParse(raw).success
}

/**
 * A new key on its way into the config (`channels add agentchat
 * --token-file` on an OpenClaw without `prepareAccountConfigInput`, which
 * runs this hook before the write): ask AgentChat first. Turned away
 * (401 / 403): say so and end the command, so nothing is written and the
 * key file the config named before stays as it was. Accepted, or no
 * verdict: the key is stored (key file, `.env` line) before OpenClaw
 * writes the config that names it. A key the prepare hook already asked
 * about and stored is not asked again. A plain-text `apiKey` written by
 * some other path is checked the same way.
 */
async function refuseRejectedKey(prevCfg: Cfg, nextCfg: Cfg, accountId: string, runtime: unknown): Promise<void> {
  const pending = pendingKeys.get(accountId)
  const pendingNamed = pending !== undefined && readAgentchatConfigField(nextCfg, accountId, 'apiKeyFile') === apiKeyFilePathFor(accountId, pending.apiKey)
  const inline = readAgentchatConfigField(nextCfg, accountId, 'apiKey')
  const apiKey = pendingNamed ? pending.apiKey : inline
  if (!apiKey) return
  if (!pendingNamed && apiKey === readAgentchatConfigField(prevCfg, accountId, 'apiKey')) return
  if (keyAskedBeforeWrite === keyDigest(apiKey)) return
  let check: KeyCheck | null
  try {
    check = await checkApiKey(apiKey, { apiBase: readAgentchatConfigField(nextCfg, accountId, 'apiBase') })
  } catch (err) {
    say(runtime, 'error', `[agentchat:${accountId}] no verdict on the API key, saving it for the runtime to try: ${err instanceof Error ? err.message : String(err)}`)
    check = null
  }
  if (check !== null && !check.ok) {
    say(runtime, 'error', keyRefusal(check))
    pendingKeys.delete(accountId)
    // OpenClaw's commands end on a cancelled setup without writing.
    throw new WizardCancelledError('AgentChat did not accept the API key')
  }
  if (!pendingNamed) return
  const stored = storeKeyForSetup(accountId, apiKey, runtime)
  if (!stored.ok) {
    say(runtime, 'error', stored.refusal)
    pendingKeys.delete(accountId)
    throw new WizardCancelledError('the API key could not be stored')
  }
  keyAskedBeforeWrite = keyDigest(apiKey)
}

/**
 * ChannelLifecycleAdapter — the file side of disable / re-enable / delete,
 * run by OpenClaw after the config adapters and before the write.
 * Best-effort; reports through the CLI runtime it is given.
 *
 * enabled → disabled: the identity line goes (the key stays — a pause).
 * disabled → enabled: the identity line for the configured `agentHandle`
 * comes back, the mirror of disable. OpenClaw 2026.10.9 does not load a
 * disabled channel's plugin, so a re-enable through
 * `openclaw config set channels.agentchat.enabled true` never reaches this
 * hook; `openclaw doctor --fix` places a missing identity line for that path.
 */
export const agentchatLifecycleAdapter: NonNullable<ChannelPlugin<AgentchatResolvedAccount>['lifecycle']> = {
  async onAccountConfigChanged({ prevCfg, nextCfg, accountId, runtime }) {
    await refuseRejectedKey(prevCfg, nextCfg, accountId, runtime)
    const wasEnabled = isAccountEnabled(prevCfg, accountId)
    const isEnabled = isAccountEnabled(nextCfg, accountId)
    if (wasEnabled === isEnabled) return
    if (!accountSectionPersistable(nextCfg, accountId)) {
      say(
        runtime,
        'error',
        isEnabled
          ? `[agentchat:${accountId}] the re-enabled config does not pass the channel schema — not placing the identity line`
          : `[agentchat:${accountId}] the disabled config does not pass the channel schema — leaving the identity line and the key in place`,
      )
      return
    }
    if (!isEnabled) {
      for (const line of removeIntegrationFiles(nextCfg, accountId, { clearKey: false })) say(runtime, 'log', `[agentchat:${accountId}] ${line}`)
      return
    }
    const handle = handleOf(readAgentchatConfigField(nextCfg, accountId, 'agentHandle'))
    if (!handle) {
      say(runtime, 'log', `[agentchat:${accountId}] agentHandle not in config — run \`openclaw doctor --fix\` to learn it from the key and place the identity line`)
      return
    }
    const apiKey = readAgentchatApiKey(nextCfg, accountId)
    const apiBase = readAgentchatConfigField(nextCfg, accountId, 'apiBase') ?? DEFAULT_API_BASE
    const identityLine = apiKey ? await loadIdentityLine({ client: createSdkClient({ apiKey, apiBase }), accountId }) : null
    const restored = restoreIdentityLine(nextCfg, accountId, handle, identityLine)
    if (restored.outcome === 'placed') say(runtime, 'log', `[agentchat:${accountId}] placed the identity line for @${handle} in ${restored.path}`)
    else if (restored.outcome === 'skipped') say(runtime, 'log', `[agentchat:${accountId}] identity line for @${handle} not placed: ${restored.detail ?? 'the served text is not available'}`)
    else if (restored.outcome === 'failed') say(runtime, 'error', `[agentchat:${accountId}] could not place the identity line for @${handle}: ${restored.detail ?? 'unknown error'} — run \`openclaw doctor --fix\` after fixing the path`)
  },

  async onAccountRemoved({ prevCfg, accountId, runtime }) {
    for (const line of removeIntegrationFiles(prevCfg, accountId, { clearKey: true })) say(runtime, 'log', `[agentchat:${accountId}] ${line}`)
  },
}

export const agentchatPlugin: ChannelPlugin<AgentchatResolvedAccount, AgentchatProbeResult> = {
  id: AGENTCHAT_CHANNEL_ID,

  meta: {
    id: AGENTCHAT_CHANNEL_ID,
    label: 'AgentChat',
    selectionLabel: 'AgentChat (messaging platform for agents)',
    detailLabel: 'AgentChat',
    docsPath: '/channels/agentchat',
    docsLabel: 'agentchat',
    blurb:
      'the AgentChat integration — your agent gets a permanent @handle on the messaging network for AI agents, is woken when a peer writes, and decides for itself with its own model whether to reply through the hosted AgentChat tools.',
    systemImage: 'message',
    markdownCapable: true,
    order: 100,
  },

  // What the network offers. The channel itself routes nothing outbound:
  // every action goes through the hosted MCP tools, so OpenClaw's `message`
  // tool does not target AgentChat.
  capabilities: {
    chatTypes: ['direct', 'group'],
    media: false,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    threads: false,
    nativeCommands: false,
  },

  // OpenClaw matches a reload prefix as `path === prefix` or `path` starting
  // with `prefix.` (src/gateway/config-reload-plan.ts), so the prefix carries
  // no trailing dot: `channels.agentchat.` matched nothing, and every
  // channels.agentchat change restarted the gateway (2026.6.x–2026.8.x) or
  // reloaded the plugin (2026.11.x). With this one OpenClaw restarts just the
  // channel, after a running turn has ended.
  reload: {
    configPrefixes: [`channels.${AGENTCHAT_CHANNEL_ID}`],
  },

  configSchema: buildChannelConfigSchema(agentchatChannelConfigSchema, { uiHints }),

  setupWizard: agentchatSetupWizard,

  config: {
    listAccountIds(cfg) {
      const section = readChannelSection(cfg)
      if (!section) return []
      const { accounts } = section
      if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
        const ids = Object.keys(accounts as Record<string, unknown>)
        if (ids.length > 0) return ids
      }
      const hasFlatFields =
        typeof section.apiKey === 'string' ||
        typeof section.apiKeyFile === 'string' ||
        typeof section.apiBase === 'string' ||
        typeof section.agentHandle === 'string'
      return hasFlatFields ? [AGENTCHAT_DEFAULT_ACCOUNT_ID] : []
    },

    resolveAccount(cfg, accountId) {
      return resolveAgentchatAccount(cfg, accountId)
    },

    defaultAccountId() {
      return AGENTCHAT_DEFAULT_ACCOUNT_ID
    },

    // `openclaw channels remove agentchat` → disable; `--delete` → delete.
    // OpenClaw routes both here (not through the wizard's `disable`, which
    // only the interactive setup flow reaches). Shared strip logic with it.
    setAccountEnabled({ cfg, accountId, enabled }) {
      if (enabled) return setAccountEnabledInConfigSection({ cfg, sectionKey: AGENTCHAT_CHANNEL_ID, accountId, enabled: true, allowTopLevel: true })
      return disableAccountConfig(cfg, accountId)
    },

    deleteAccount({ cfg, accountId }) {
      return deleteAccountConfig(cfg, accountId)
    },

    isEnabled(account) {
      return account.enabled
    },

    disabledReason(account) {
      return account.enabled ? '' : 'channel disabled via channels.agentchat.enabled=false'
    },

    isConfigured(account) {
      return account.configured
    },

    unconfiguredReason(account) {
      if (account.parseError) return `config invalid: ${account.parseError}`
      if (!account.config) return 'missing channels.agentchat configuration'
      if (!isApiKeyPresent(account.config.apiKey)) return 'missing or too-short API key (channels.agentchat.apiKeyFile)'
      return ''
    },

    hasConfiguredState({ cfg }) {
      const section = readChannelSection(cfg)
      if (!section) return false
      const { accounts } = section
      if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
        for (const entry of Object.values(accounts as Record<string, unknown>)) {
          if (entry && typeof entry === 'object' && namesApiKey(entry as Record<string, unknown>)) return true
        }
      }
      return namesApiKey(section)
    },

    describeAccount(account) {
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        linked: account.configured,
      }
    },
  },

  setup: agentchatSetupAdapter,

  // ─── OpenClaw ↔ AgentChat binding ─────────────────────────────────────
  //
  // gateway — holds the socket, wakes, gates, starts turns (the integration).
  // status  — the doctor-style probe: key, hosted MCP reachability, placement.
  // doctor  — `openclaw doctor` warnings and the mcp.servers.agentchat repair.
  //
  // Deliberately absent: `outbound`, `messaging`, `actions`, `directory`,
  // `resolver`, `agentTools`. Tools are defined once, in the hosted MCP
  // server; the plugin places that server and nothing else. `agentPrompt` is
  // absent too — it only fires on AgentChat-triggered runs, while the
  // identity line must be present on every turn (AGENTS.md).

  gateway: agentchatGatewayAdapter,
  status: agentchatStatusAdapter,
  doctor: agentchatDoctorAdapter,
  lifecycle: agentchatLifecycleAdapter,
}

/**
 * Canonical channel-entry descriptor consumed by OpenClaw's extension loader.
 * Exported as `default` because `openclaw.extensions` in package.json points to
 * this module and the loader reads the default export.
 *
 * The explicit `ReturnType<...>` annotation pins the emitted `.d.ts` to the
 * function signature instead of the structural shape — otherwise the inferred
 * type references `ChannelConfigSchema` through a non-exported path and TS
 * fails with TS2742 ("cannot be named without a reference to ...").
 */
export const agentchatChannelEntry: ReturnType<
  typeof defineChannelPluginEntry<typeof agentchatPlugin>
> = defineChannelPluginEntry({
  id: AGENTCHAT_CHANNEL_ID,
  name: 'AgentChat',
  description: 'The AgentChat integration: wakes your OpenClaw agent when a peer writes on the messaging network for AI agents.',
  plugin: agentchatPlugin,
  // Called in every registration mode except cli-metadata and tool-discovery
  // (docs.openclaw.ai/plugins/sdk-entrypoints/define-channel-plugin-entry).
  // The integration reads `runtime.llm.complete` (the gate on the agent's own
  // model) and `runtime.subagent.run` (one turn, `deliver: false`) from it.
  setRuntime: (runtime) => setPluginRuntime(runtime),
  // `openclaw agentchat release <conversation_id>`: the CLI half is
  // registered for every CLI (parse-time metadata), the gateway half only
  // where the integration runs.
  registerCliMetadata: (api) => registerReleaseCli(api),
  registerFull: (api) => {
    registerReleaseGatewayMethod(api)
    registerRunObserver(api)
  },
})

export default agentchatChannelEntry

export { parseChannelConfig }
export type { AgentchatChannelConfig }
