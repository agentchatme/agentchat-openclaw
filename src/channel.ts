/**
 * AgentChat channel plugin — entry point.
 *
 * The plugin is a doorbell (AgentChat's main-line decision record): it holds the
 * socket for the account, shows the server's cards and question to the
 * agent's own model, starts one turn when the answer is reply, and places
 * the key, the identity line, the hosted tools and the manual where OpenClaw
 * loads them. Nothing of the product lives here — no tools, no gate wording,
 * no message parsing, no delivery semantics. The channel therefore carries
 * only `gateway`, `status` and `doctor` adapters: the agent's send is the
 * hosted `agentchat__agentchat_send_message` tool, not OpenClaw's `message`
 * tool, so there is no outbound adapter to route to.
 *
 * Wires the real OpenClaw SDK contracts — builds a
 * `ChannelPlugin<AgentchatResolvedAccount>` with id / meta / capabilities /
 * config-adapter / config-schema / setup + setupWizard, and wraps it via
 * `defineChannelPluginEntry(...)` for OpenClaw's extension loader. The
 * entry's `setRuntime` hands the doorbell OpenClaw's `PluginRuntime`
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
import type { ChannelSetupInput } from 'openclaw/plugin-sdk/setup'

import {
  AGENTCHAT_CHANNEL_ID,
  AGENTCHAT_DEFAULT_ACCOUNT_ID,
  MIN_API_KEY_LENGTH,
  applyAgentchatAccountPatch,
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
import { validateApiKey } from './setup-client.js'

import {
  agentchatGatewayAdapter,
  agentchatStatusAdapter,
  agentchatDoctorAdapter,
  type AgentchatProbeResult,
} from './binding/index.js'
import { placeDoorbell, formatPlacement, applyDoorbellConfig, stripDoorbellConfig, removeDoorbellFiles } from './doorbell/placement.js'
import { setPluginRuntime } from './doorbell/runtime-holder.js'
import { DEFAULT_API_BASE } from './doorbell/mcp.js'

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
  apiKey: {
    label: 'AgentChat API key',
    placeholder: 'ac_live_...',
    sensitive: true,
    help: 'The setup wizard registers you via email OTP and mints a key, recovers a lost key (handle + email OTP), or accepts an existing ac_live_… key.',
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
    help: '3–30 chars, lowercase letters/digits/hyphens; must start with a letter.',
  },
  reconnect: { label: 'Reconnect backoff', advanced: true },
  ping: { label: 'WebSocket ping cadence', advanced: true },
  outbound: { label: 'Outbound send tuning', advanced: true },
  observability: { label: 'Logs & metrics', advanced: true },
}

/** The CLI runtime OpenClaw hands setup hooks (`RuntimeEnv`): `log`, `error`, `exit`. Nothing else — never `.logger`. */
type SetupRuntimeEnv = { log?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }

/**
 * The setup input with the one channel-owned field this plugin adds:
 * `agentHandle`, learnt from the key by `prepareAccountConfigInput` and
 * written by `applyAccountConfig` in the same persisted write.
 */
type AgentchatSetupInput = ChannelSetupInput & { agentHandle?: string }

const HANDLE_SHAPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
function validHandle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const bare = value.trim().replace(/^@/, '')
  return bare.length >= 3 && bare.length <= 30 && HANDLE_SHAPE.test(bare) ? bare : undefined
}

function say(runtime: unknown, level: 'log' | 'error', line: string): void {
  const env = runtime as SetupRuntimeEnv | undefined
  const fn = env?.[level]
  if (typeof fn === 'function') fn(line)
}

type BaseSetupAdapter = NonNullable<ChannelPlugin<AgentchatResolvedAccount>['setup']>

/**
 * `channels add agentchat --token <key>` (non-interactive) and the wizard's
 * credential step both go through this adapter. What OpenClaw persists is
 * exactly what `applyAccountConfig` returns — it is synchronous — so
 * everything that belongs in `openclaw.json` is written there: the key, the
 * API base, the handle the key authenticates as (learnt just before, in
 * `prepareAccountConfigInput`, which 2026.10.x runs first and awaits), the
 * hosted tools entry and, when the account is bound to a non-default agent,
 * the llm override opt-in. `afterAccountConfigWritten` only places files
 * (the key in the state-dir `.env`, the identity line in `AGENTS.md`) and
 * reports through the CLI runtime it is given (`RuntimeEnv.log/error`).
 * It never relies on the plugin runtime: in OpenClaw's setup-only
 * registration mode that runtime is a proxy that throws on access.
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
   * Pre-write gate: cheap, sync check that the caller supplied an API key
   * that's at least plausibly shaped. Real authentication happens in
   * `prepareAccountConfigInput` / `afterAccountConfigWritten`.
   */
  validateInput({ input }) {
    if (typeof input.token !== 'string' || input.token.trim().length === 0) {
      return 'apiKey is required — pass via --token, or run `openclaw channels add agentchat` to register a new agent or recover a lost key (handle + email OTP)'
    }
    if (input.token.length < MIN_API_KEY_LENGTH) {
      return `apiKey looks too short (got ${input.token.length} chars, expect ≥${MIN_API_KEY_LENGTH})`
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
   * Learn the handle the key authenticates as BEFORE the write, so
   * `applyAccountConfig` persists it in the same config write OpenClaw
   * already makes. A key that does not validate leaves the input untouched
   * (the write still happens; the error line says what to fix).
   */
  async prepareAccountConfigInput({ accountId, input, runtime }) {
    const apiKey = typeof input.token === 'string' ? input.token : undefined
    if (!apiKey || apiKey.length < MIN_API_KEY_LENGTH) return input
    const apiBase = typeof input.url === 'string' && input.url.length > 0 ? input.url : undefined
    try {
      const result = await validateApiKey(apiKey, { apiBase })
      if (result.ok) {
        say(runtime, 'log', `[agentchat:${accountId}] authenticated as @${result.agent.handle} (${result.agent.email})`)
        return { ...input, agentHandle: result.agent.handle }
      }
      say(runtime, 'error', `[agentchat:${accountId}] api key did not pass live check (${result.reason}): ${result.message}`)
    } catch (err) {
      say(runtime, 'error', `[agentchat:${accountId}] live key validation failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return input
  },

  /**
   * The one persisted write. Synchronous by contract, so it carries
   * everything that can be known without I/O: key, API base, the handle
   * (when `prepareAccountConfigInput` learnt it), the hosted tools entry,
   * the llm opt-in for a non-default bound agent.
   */
  applyAccountConfig({ cfg, accountId, input }) {
    const patch: Record<string, unknown> = {}
    if (typeof input.token === 'string' && input.token.length > 0) patch.apiKey = input.token
    if (typeof input.url === 'string' && input.url.length > 0) patch.apiBase = input.url
    const handle = validHandle((input as AgentchatSetupInput).agentHandle)
    if (handle) patch.agentHandle = handle
    const withAccount = applyAgentchatAccountPatch(cfg, accountId, patch)
    const apiKey = readAgentchatConfigField(withAccount, accountId, 'apiKey')
    if (!apiKey) return withAccount
    const apiBase = readAgentchatConfigField(withAccount, accountId, 'apiBase') ?? DEFAULT_API_BASE
    return applyDoorbellConfig(withAccount, { accountId, handle, apiKey, apiBase }).cfg
  },

  /**
   * Files only: the key into OpenClaw's state-dir `.env`, the identity line
   * into the bound agent's `AGENTS.md`. Reports through `RuntimeEnv.log`.
   * Never throws: setup-time UX is "warn and proceed".
   */
  async afterAccountConfigWritten({ cfg, accountId, input, runtime }) {
    const apiKey = typeof input.token === 'string' ? input.token : readAgentchatConfigField(cfg, accountId, 'apiKey')
    if (!apiKey) return
    const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase') ?? DEFAULT_API_BASE
    let handle = validHandle((input as AgentchatSetupInput).agentHandle) ?? readAgentchatConfigField(cfg, accountId, 'agentHandle')
    if (!handle) {
      // An OpenClaw without `prepareAccountConfigInput`: learn the handle now
      // for the identity line; the config gets it from `openclaw doctor --fix`.
      try {
        const result = await validateApiKey(apiKey, { apiBase })
        if (result.ok) {
          handle = result.agent.handle
          say(runtime, 'log', `[agentchat:${accountId}] authenticated as @${handle}; run \`openclaw doctor --fix\` to persist channels.agentchat.agentHandle`)
        } else {
          say(runtime, 'error', `[agentchat:${accountId}] api key did not pass live check (${result.reason}): ${result.message}`)
          return
        }
      } catch (err) {
        say(runtime, 'error', `[agentchat:${accountId}] live key validation failed: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
    try {
      const placed = placeDoorbell({ cfg, handle, apiKey, apiBase, accountId })
      for (const line of formatPlacement(placed.steps.filter((s) => s.name !== 'mcp'))) say(runtime, 'log', `[agentchat:${accountId}] ${line}`)
      say(runtime, 'log', `[agentchat:${accountId}] ✓ config: agentHandle and mcp.servers.agentchat written with the account (restart the gateway, or reload its config, so \${AGENTCHAT_API_KEY} resolves)`)
    } catch (err) {
      say(runtime, 'error', `[agentchat:${accountId}] placement failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

/** `channels remove agentchat` (disable): keep the key, strip what tells the agent it is on AgentChat. */
function disableAccount(cfg: import('./binding/openclaw-types.js').OpenClawConfig, accountId: string): import('./binding/openclaw-types.js').OpenClawConfig {
  removeDoorbellFiles(cfg, accountId, { clearKey: false })
  const stripped = stripDoorbellConfig(cfg, accountId).cfg
  return setAccountEnabledInConfigSection({ cfg: stripped, sectionKey: AGENTCHAT_CHANNEL_ID, accountId, enabled: false, allowTopLevel: true })
}

/** `channels remove agentchat --delete`: strip everything, including the key line in `.env`. */
function deleteAccount(cfg: import('./binding/openclaw-types.js').OpenClawConfig, accountId: string): import('./binding/openclaw-types.js').OpenClawConfig {
  removeDoorbellFiles(cfg, accountId, { clearKey: true })
  const stripped = stripDoorbellConfig(cfg, accountId).cfg
  return deleteAccountFromConfigSection({ cfg: stripped, sectionKey: AGENTCHAT_CHANNEL_ID, accountId, clearBaseFields: ['apiKey', 'apiBase', 'agentHandle'] })
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
      'the AgentChat doorbell — your agent gets a permanent @handle on the messaging network for AI agents, is woken when a peer writes, and decides for itself with its own model whether to reply through the hosted AgentChat tools.',
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

  reload: {
    configPrefixes: [`channels.${AGENTCHAT_CHANNEL_ID}.`],
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
      return disableAccount(cfg, accountId)
    },

    deleteAccount({ cfg, accountId }) {
      return deleteAccount(cfg, accountId)
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
      if (!isApiKeyPresent(account.config.apiKey)) return 'missing or too-short channels.agentchat.apiKey'
      return ''
    },

    hasConfiguredState({ cfg }) {
      const section = readChannelSection(cfg)
      if (!section) return false
      const { accounts } = section
      if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
        for (const entry of Object.values(accounts as Record<string, unknown>)) {
          if (entry && typeof entry === 'object') {
            const candidate = (entry as Record<string, unknown>).apiKey
            if (isApiKeyPresent(candidate)) return true
          }
        }
      }
      return isApiKeyPresent(section.apiKey)
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
  // gateway — holds the socket, knocks, gates, starts turns (the doorbell).
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
  description: 'The AgentChat doorbell: wakes your OpenClaw agent when a peer writes on the messaging network for AI agents.',
  plugin: agentchatPlugin,
  // Called in every registration mode except cli-metadata and tool-discovery
  // (docs.openclaw.ai/plugins/sdk-entrypoints/define-channel-plugin-entry).
  // The doorbell reads `runtime.llm.complete` (the gate on the agent's own
  // model) and `runtime.subagent.run` (one turn, `deliver: false`) from it.
  setRuntime: (runtime) => setPluginRuntime(runtime),
})

export default agentchatChannelEntry

export { parseChannelConfig }
export type { AgentchatChannelConfig }
