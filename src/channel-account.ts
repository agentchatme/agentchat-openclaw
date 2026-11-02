/**
 * Account-config primitives for the AgentChat channel plugin.
 *
 * This module owns the smallest set of shared pieces that both the plugin
 * definition (`channel.ts`) and the interactive setup wizard
 * (`channel.wizard.ts`) need to read or mutate the `channels.agentchat.*`
 * section of the OpenClaw config. Keeping them in a leaf file (no imports
 * from other channel-* modules) breaks the channel.ts ↔ channel.wizard.ts
 * import cycle — without it, the wizard literal's `channel:` field resolves
 * to the temporal-dead-zone value of `AGENTCHAT_CHANNEL_ID` at module-init
 * time, which bundlers emit as `undefined`.
 *
 * Invariants:
 *   - Flat form (`channels.agentchat.{apiKey,...}`) is the default-account
 *     layout when no `accounts` key is present. Once a named account is
 *     written, flat form is never used again for the default account.
 *   - The `enabled` flag is section-level (not per-account) and is kept out
 *     of the Zod-parsed account shape because the schema is `.strict()`.
 */
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core'

export const AGENTCHAT_CHANNEL_ID = 'agentchat' as const
export const AGENTCHAT_DEFAULT_ACCOUNT_ID = 'default'

export const MIN_API_KEY_LENGTH = 20

export type ChannelSectionRaw = Record<string, unknown> & {
  accounts?: Record<string, unknown>
  enabled?: unknown
  apiKey?: unknown
  apiBase?: unknown
  agentHandle?: unknown
}

export function readChannelSection(cfg: OpenClawConfig | undefined): ChannelSectionRaw | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels
  const section = channels?.[AGENTCHAT_CHANNEL_ID]
  return section && typeof section === 'object' && !Array.isArray(section)
    ? (section as ChannelSectionRaw)
    : undefined
}

export function readAccountRaw(
  section: ChannelSectionRaw | undefined,
  accountId: string,
): Record<string, unknown> | undefined {
  if (!section) return undefined
  const { accounts } = section
  if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
    const entry = (accounts as Record<string, unknown>)[accountId]
    if (entry && typeof entry === 'object') return entry as Record<string, unknown>
  }
  // Single-account fallback: treat section-level fields as the 'default' account,
  // stripping the `accounts` subsection (but preserving `enabled`, which the
  // caller extracts before Zod parsing).
  if (accountId === AGENTCHAT_DEFAULT_ACCOUNT_ID) {
    const { accounts: _accounts, ...rest } = section
    void _accounts
    return rest as Record<string, unknown>
  }
  return undefined
}

/**
 * Pulls the `enabled` flag out of a raw account record and returns a copy
 * safe to feed into `parseChannelConfig` (which enforces `.strict()` — an
 * unknown `enabled` key would otherwise reject).
 */
export function splitEnabledFromRaw(
  raw: Record<string, unknown> | undefined,
): { enabled: boolean; forParse: Record<string, unknown> | undefined } {
  if (!raw) return { enabled: true, forParse: undefined }
  const { enabled, ...rest } = raw
  return { enabled: enabled !== false, forParse: rest }
}

/**
 * Whether OpenClaw treats this account as enabled: neither the section-level
 * `channels.agentchat.enabled` nor the account's own `enabled` is `false`.
 * (For the flat default account the two are the same field.)
 */
export function isAgentchatAccountEnabled(cfg: OpenClawConfig | undefined, accountId: string): boolean {
  const section = readChannelSection(cfg)
  if (!section) return true
  if (section.enabled === false) return false
  const raw = readAccountRaw(section, accountId)
  return raw?.enabled !== false
}

/**
 * The config path whose `false` keeps this account disabled — the one
 * `openclaw config set <path> true` must flip. The section-level flag
 * first: while it is `false` OpenClaw does not load the plugin at all.
 */
export function agentchatEnabledConfigPath(cfg: OpenClawConfig | undefined, accountId: string): string {
  const section = readChannelSection(cfg)
  const sectionPath = `channels.${AGENTCHAT_CHANNEL_ID}.enabled`
  if (!section || section.enabled === false) return sectionPath
  const { accounts } = section
  const entry = accounts && typeof accounts === 'object' && !Array.isArray(accounts) ? (accounts as Record<string, unknown>)[accountId] : undefined
  if (entry && typeof entry === 'object') return `channels.${AGENTCHAT_CHANNEL_ID}.accounts.${accountId}.enabled`
  return sectionPath
}

/**
 * The remedy for anything missing on a DISABLED account. Never
 * `channels add`: OpenClaw (2026.10.9) does not load a disabled channel's
 * plugin, so `channels add` treats AgentChat as a missing plugin, downloads
 * `@agentchatme/openclaw` from npm and asks to install it over this one.
 * `config set … true` re-enables in place ("applies without restarting the
 * gateway"); `doctor --fix` then restores the hosted tools entry and the
 * identity line.
 */
export function agentchatReenableHint(cfg: OpenClawConfig | undefined, accountId: string): string {
  return (
    `the account is disabled — re-enable it with \`openclaw config set ${agentchatEnabledConfigPath(cfg, accountId)} true\`, then run \`openclaw doctor --fix\` ` +
    '(not `openclaw channels add`: OpenClaw does not load a disabled channel\'s plugin and would install @agentchatme/openclaw from npm over this one)'
  )
}

/**
 * Every account id the config declares: the keys of `accounts.*` when
 * present, else `default` when the flat section carries an `apiKey`. Shared
 * by the config adapter, the gateway's single-account check and the doctor.
 */
export function listConfiguredAccountIds(cfg: OpenClawConfig | undefined): string[] {
  const section = readChannelSection(cfg)
  if (!section) return []
  const { accounts } = section
  if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
    const ids = Object.keys(accounts as Record<string, unknown>)
    if (ids.length > 0) return ids
  }
  return typeof section.apiKey === 'string' ? [AGENTCHAT_DEFAULT_ACCOUNT_ID] : []
}

/**
 * This release runs ONE AgentChat account per gateway. The hosted tools are
 * one `mcp.servers.agentchat` entry whose bearer header is a template on one
 * environment variable (`AGENTCHAT_API_KEY`), so a second account's turn
 * would call the tools as the first account. The doorbell refuses to start
 * when more than one account is configured, and `channels status` says so.
 *
 * TODO (per-account doorbells): one MCP entry per account
 * (`mcp.servers.agentchat-<accountId>`, bearer template on
 * `AGENTCHAT_API_KEY_<ACCOUNT>`), the turn prompt naming that account's tool
 * prefix (`agentchat-<accountId>__…`), the identity line per agent workspace,
 * and the key placed under its own variable name in `.env`.
 */
export function multiAccountRefusal(cfg: OpenClawConfig | undefined): string | null {
  const ids = listConfiguredAccountIds(cfg)
  if (ids.length <= 1) return null
  return (
    `${ids.length} AgentChat accounts are configured (${ids.join(', ')}); this release runs one account per gateway ` +
    '— the hosted tools are one mcp.servers.agentchat entry on one AGENTCHAT_API_KEY, so a second account would act as the first. ' +
    'Keep one account under channels.agentchat (or run a second gateway) until per-account doorbells ship.'
  )
}

export function isApiKeyPresent(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_API_KEY_LENGTH
}

/**
 * Read a string-valued field from the resolved account record. Mirrors the
 * fallback logic of `resolveAccount` — accounts.<id>.<field> when present,
 * falling back to the flat section for the default account.
 *
 * Used by the setup wizard so it can render live config state without
 * re-running the Zod parser (which would reject partial work-in-progress
 * inputs during the interactive flow).
 */
export function readAgentchatConfigField(
  cfg: OpenClawConfig | undefined,
  accountId: string,
  field: 'apiKey' | 'apiBase' | 'agentHandle',
): string | undefined {
  const section = readChannelSection(cfg)
  const raw = readAccountRaw(section, accountId)
  if (!raw) return undefined
  const value = raw[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Shared writer for both the non-interactive `setup.applyAccountConfig`
 * adapter and the interactive wizard. Maintains the same flat-vs-accounts
 * invariant: default account uses flat form iff no `accounts` key is present;
 * named accounts always nest under `accounts.<id>`.
 */
export function applyAgentchatAccountPatch(
  cfg: OpenClawConfig | undefined,
  accountId: string,
  patch: Record<string, unknown>,
): OpenClawConfig {
  const channels: Record<string, unknown> = {
    ...((cfg as { channels?: Record<string, unknown> } | undefined)?.channels ?? {}),
  }
  const currentSection = channels[AGENTCHAT_CHANNEL_ID]
  const section: ChannelSectionRaw =
    currentSection && typeof currentSection === 'object' && !Array.isArray(currentSection)
      ? { ...(currentSection as ChannelSectionRaw) }
      : {}

  if (accountId === AGENTCHAT_DEFAULT_ACCOUNT_ID && !section.accounts) {
    Object.assign(section, patch)
  } else {
    const accounts: Record<string, unknown> = {
      ...((section.accounts as Record<string, unknown> | undefined) ?? {}),
    }
    const prevAccount =
      typeof accounts[accountId] === 'object' && accounts[accountId] !== null
        ? (accounts[accountId] as Record<string, unknown>)
        : {}
    accounts[accountId] = { ...prevAccount, ...patch }
    section.accounts = accounts
  }

  channels[AGENTCHAT_CHANNEL_ID] = section
  return { ...(cfg ?? {}), channels } as OpenClawConfig
}
