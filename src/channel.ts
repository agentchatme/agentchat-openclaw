/**
 * AgentChat channel plugin — entry point.
 *
 * The plugin is a doorbell (docs/decisions, "the main line"): it holds the
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

import {
  AGENTCHAT_CHANNEL_ID,
  AGENTCHAT_DEFAULT_ACCOUNT_ID,
  MIN_API_KEY_LENGTH,
  applyAgentchatAccountPatch,
  isApiKeyPresent,
  readAccountRaw,
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
import { placeDoorbell, formatPlacement } from './doorbell/placement.js'
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

  setup: {
    /**
     * Pre-write gate: cheap, sync check that the caller supplied an API key
     * that's at least plausibly shaped. Real authentication happens in
     * `afterAccountConfigWritten` via a live /agents/me probe.
     */
    validateInput({ input }) {
      // The non-interactive path takes a key and nothing else. Registration
      // and recovery both need an email OTP round-trip (and recovery needs
      // the handle + email pair), so they live in the interactive wizard —
      // name it here so a scripted invocation knows where to go.
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

    applyAccountConfig({ cfg, accountId, input }) {
      const patch: Record<string, unknown> = {}
      if (typeof input.token === 'string' && input.token.length > 0) patch.apiKey = input.token
      if (typeof input.url === 'string' && input.url.length > 0) patch.apiBase = input.url
      return applyAgentchatAccountPatch(cfg, accountId, patch)
    },

    /**
     * Post-write probe: call `GET /v1/agents/me` with the key we just wrote
     * so the operator sees a clear "✓ authenticated as @handle" on success
     * — or a specific failure reason (invalid, revoked, unreachable) they
     * can act on *before* the runtime starts flapping reconnects in prod.
     *
     * Never throws: setup-time UX is "warn and proceed". If the probe can't
     * reach the API (airgapped CI, corp proxy during first boot), we still
     * want the config written so the user can retry without reconfiguring.
     */
    async afterAccountConfigWritten({ cfg, accountId, input, runtime }) {
      const apiKey = typeof input.token === 'string' ? input.token : undefined
      if (!apiKey) return
      const apiBase = typeof input.url === 'string' && input.url.length > 0 ? input.url : undefined
      const logger = (runtime as { logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } } | undefined)?.logger
      try {
        const result = await validateApiKey(apiKey, { apiBase })
        if (result.ok) {
          logger?.info?.(
            `[agentchat:${accountId}] authenticated as @${result.agent.handle} (${result.agent.email})`,
          )
          // Non-interactive twin of the wizard's `finalize` placement. This
          // path (`openclaw setup --channel agentchat --token <key>`) has no
          // wizard UX, but the agent still needs the key in the gateway
          // environment, the identity line in AGENTS.md and the hosted tools
          // registered. The config patch (mcp.servers.agentchat) cannot be
          // returned from this hook; the doctor's repair adds it, and the
          // log line says so.
          try {
            const placed = placeDoorbell({ cfg, handle: result.agent.handle, apiKey, apiBase: apiBase ?? DEFAULT_API_BASE })
            for (const line of formatPlacement(placed.steps)) logger?.info?.(`[agentchat:${accountId}] ${line}`)
            if (placed.mcp === 'added') {
              logger?.warn?.(
                `[agentchat:${accountId}] mcp.servers.agentchat is not in the config yet — run \`openclaw doctor --fix\` or \`openclaw channels add agentchat\` to register the hosted tools`,
              )
            }
          } catch (err) {
            logger?.warn?.(`[agentchat:${accountId}] placement failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        } else {
          logger?.warn?.(
            `[agentchat:${accountId}] api key did not pass live check (${result.reason}): ${result.message}`,
          )
        }
      } catch (err) {
        logger?.warn?.(
          `[agentchat:${accountId}] live key validation failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  },

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
