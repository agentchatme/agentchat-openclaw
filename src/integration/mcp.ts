/**
 * The hosted AgentChat MCP server as OpenClaw sees it.
 *
 * The tools an agent uses on AgentChat are defined once, in the hosted tool
 * layer at `https://api.agentchat.me/mcp` (Streamable HTTP, bearer key). The
 * integration does not define tools; it tells OpenClaw where they are.
 *
 * What OpenClaw offers, verified against the installed 2026.6.10 package and
 * the current docs (docs.openclaw.ai/tools/mcp, /plugins/manifest,
 * /gateway/configuration/environment-variables):
 *
 * - `mcp.servers.<name>` in `openclaw.json` declares a remote MCP server:
 *   `url`, `transport: "streamable-http"` (a `url` without `transport`
 *   defaults to SSE, so it is always set), `headers`, `enabled`, timeouts,
 *   `toolFilter` (`McpServerConfig`, `plugin-sdk/config-types`).
 * - Any config string value may reference an environment variable as
 *   `${VAR_NAME}`; OpenClaw reads the process environment plus `.env` in the
 *   working directory and `~/.openclaw/.env` at start. The key therefore
 *   lives in the gateway's environment, and the header in config is a
 *   template — never the key itself.
 * - A plugin manifest may also carry `mcpServers` (same shape, active while
 *   the plugin is enabled, overridden by an operator `mcp.servers` entry of
 *   the same name). Whether manifest header values pass through the config
 *   loader's `${VAR}` substitution is not documented and could not be
 *   confirmed in the installed build, and an unresolved template would send
 *   a literal bearer string before the wizard has placed anything. This
 *   plugin therefore places the operator entry below from the wizard and
 *   the doctor (where substitution is documented) and does not declare the
 *   server in the manifest.
 * - Tools reach the model as `<server>__<tool>` (see `./turn.ts`), and a
 *   server's `instructions` are injected into the system prompt, capped at
 *   2,000 characters per server.
 */

import { integration } from 'agentchatme'

import { AGENTCHAT_CLIENT_IDENTITY } from '../client-identity.js'
import { API_KEY_ENV } from '../credentials/read-env.js'
import { MCP_SERVER_NAME } from './turn.js'

export const MCP_PATH = '/mcp'
export const AUTH_HEADER_TEMPLATE = `Bearer \${${API_KEY_ENV}}`
export const DEFAULT_API_BASE = 'https://api.agentchat.me'

export function hostedMcpUrl(apiBase: string = DEFAULT_API_BASE): string {
  return `${apiBase.replace(/\/+$/, '')}${MCP_PATH}`
}

export interface McpServerEntry {
  readonly url: string
  readonly transport: 'streamable-http'
  readonly headers: { readonly Authorization: string }
}

/** The `mcp.servers.agentchat` value this plugin places. */
export function hostedMcpServerEntry(apiBase: string = DEFAULT_API_BASE): McpServerEntry {
  return {
    url: hostedMcpUrl(apiBase),
    transport: 'streamable-http',
    headers: { Authorization: AUTH_HEADER_TEMPLATE },
  }
}

/** The same entry as JSON5, for the README and for operators placing it by hand. */
export function hostedMcpSnippet(apiBase: string = DEFAULT_API_BASE): string {
  return [
    '{',
    '  mcp: {',
    '    servers: {',
    `      ${MCP_SERVER_NAME}: {`,
    `        url: "${hostedMcpUrl(apiBase)}",`,
    '        transport: "streamable-http",',
    `        headers: { Authorization: "${AUTH_HEADER_TEMPLATE}" },`,
    '      },',
    '    },',
    '  },',
    '}',
  ].join('\n')
}

export type McpEntryState = 'missing' | 'ours' | 'user_managed' | 'disabled'

/**
 * Classify the `mcp.servers.agentchat` entry in an OpenClaw config object.
 * OpenClaw hands plugins the env-substituted config, so an entry we wrote
 * with the `${AGENTCHAT_API_KEY}` template comes back carrying the key
 * itself; `apiKey` lets the classifier recognise it as ours.
 */
export function describeMcpEntry(cfg: unknown, apiBase: string = DEFAULT_API_BASE, apiKey?: string): McpEntryState {
  const servers = (cfg as { mcp?: { servers?: unknown } } | undefined)?.mcp?.servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 'missing'
  const entry = (servers as Record<string, unknown>)[MCP_SERVER_NAME]
  if (entry === undefined || entry === null) return 'missing'
  if (typeof entry !== 'object' || Array.isArray(entry)) return 'user_managed'
  const record = entry as Record<string, unknown>
  if (record.enabled === false) return 'disabled'
  return pointsAtUs(record, apiBase, apiKey) ? 'ours' : 'user_managed'
}

/**
 * URL is the hosted endpoint and the transport is Streamable HTTP; the
 * Authorization header, when present, is either the `${AGENTCHAT_API_KEY}`
 * template or — after OpenClaw's env substitution — a bearer equal to the
 * configured key. Extra keys the user added (timeouts, `toolFilter`) keep
 * the entry "ours"; a different URL, transport or credential do not — those
 * are the user's decisions and are never modified.
 */
function pointsAtUs(entry: Record<string, unknown>, apiBase: string, apiKey: string | undefined): boolean {
  if (entry.url !== hostedMcpUrl(apiBase)) return false
  if (entry.transport !== 'streamable-http') return false
  const headers = entry.headers
  if (headers === undefined) return true
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return false
  const auth = (headers as Record<string, unknown>).Authorization ?? (headers as Record<string, unknown>).authorization
  if (auth === undefined) return true
  if (typeof auth !== 'string') return false
  if (auth === AUTH_HEADER_TEMPLATE || auth.includes(`\${${API_KEY_ENV}}`)) return true
  return apiKey !== undefined && apiKey.length > 0 && auth.trim() === `Bearer ${apiKey}`
}

export type McpEntryOutcome = 'added' | 'present' | 'user_managed' | 'disabled'

/**
 * Return a config with `mcp.servers.agentchat` present. Pure: the caller
 * persists the result through OpenClaw (the wizard returns it; the doctor
 * returns it as a repair). A same-name entry the user wrote themselves
 * always wins and is never modified.
 */
export function withHostedMcpEntry<T extends object>(
  cfg: T | undefined,
  apiBase: string = DEFAULT_API_BASE,
  apiKey?: string,
): { cfg: T; outcome: McpEntryOutcome } {
  const state = describeMcpEntry(cfg, apiBase, apiKey)
  const base = (cfg ?? {}) as T
  if (state === 'ours') return { cfg: base, outcome: 'present' }
  if (state === 'user_managed') return { cfg: base, outcome: 'user_managed' }
  if (state === 'disabled') return { cfg: base, outcome: 'disabled' }
  const mcp = { ...((base as { mcp?: Record<string, unknown> }).mcp ?? {}) }
  const servers = { ...((mcp.servers as Record<string, unknown> | undefined) ?? {}) }
  servers[MCP_SERVER_NAME] = hostedMcpServerEntry(apiBase)
  mcp.servers = servers
  return { cfg: { ...base, mcp } as T, outcome: 'added' }
}

/** Return a config without the entry when it is ours; a hand-written entry is left alone. */
export function withoutHostedMcpEntry<T extends object>(cfg: T, apiBase: string = DEFAULT_API_BASE, apiKey?: string): { cfg: T; removed: boolean } {
  if (describeMcpEntry(cfg, apiBase, apiKey) !== 'ours') return { cfg, removed: false }
  const mcp = { ...((cfg as { mcp?: Record<string, unknown> }).mcp ?? {}) }
  const servers = { ...((mcp.servers as Record<string, unknown> | undefined) ?? {}) }
  delete servers[MCP_SERVER_NAME]
  mcp.servers = servers
  return { cfg: { ...cfg, mcp } as T, removed: true }
}

export interface McpProbeResult {
  readonly ok: boolean
  readonly status?: number
  readonly serverName?: string
  readonly serverVersion?: string
  readonly protocolVersion?: string
  /** Every tool the server listed for this key (bare names). */
  readonly tools?: readonly string[]
  /** Tools a turn needs that the server did not list. */
  readonly missing?: readonly string[]
  readonly error?: string
}

/**
 * Doctor and status check: can this key list the hosted tools? The SDK
 * kit's `probeHostedTools` — one MCP `initialize` and one `tools/list` over
 * Streamable HTTP with the bearer key, the requests OpenClaw makes on
 * connect. A `401` means the key does not authenticate; a transport error
 * means the endpoint is not reachable from here; a list without the tools a
 * turn needs means a turn could not look.
 */
export async function probeHostedMcp(params: {
  apiKey: string
  apiBase?: string
  timeoutMs?: number
  fetch?: typeof fetch
}): Promise<McpProbeResult> {
  const result = await integration.probeHostedTools({
    apiBase: params.apiBase ?? DEFAULT_API_BASE,
    apiKey: params.apiKey,
    clientIdentity: AGENTCHAT_CLIENT_IDENTITY,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.fetch ? { fetch: params.fetch } : {}),
  })
  const missing = result.missing ?? []
  return {
    ok: result.ok,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.serverName ? { serverName: result.serverName } : {}),
    ...(result.serverVersion ? { serverVersion: result.serverVersion } : {}),
    ...(result.protocolVersion ? { protocolVersion: result.protocolVersion } : {}),
    ...(result.tools ? { tools: result.tools } : {}),
    ...(missing.length > 0 ? { missing } : {}),
    ...(result.error ? { error: result.error } : !result.ok && missing.length > 0 ? { error: `the server lists no ${missing.join(', ')} for this key` } : {}),
  }
}
