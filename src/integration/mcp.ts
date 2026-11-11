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
 * - `headers` takes any static string header (`McpServerSchema` in
 *   openclaw/openclaw `src/config/zod-schema.mcp-server.ts`, a record of
 *   string to string | number | boolean, on 2026.6.10 and 2026.11.3 alike),
 *   and an `mcp.*` change is applied hot: the gateway drops its MCP clients
 *   and reconnects, no restart (`src/gateway/config-reload-plan.ts`, rule
 *   `mcp` → dispose MCP runtimes).
 *
 * The entry names this client to the hosted tools: `X-AgentChat-Client:
 * openclaw`, the header AgentChat reads on `/mcp` (it does not read MCP's
 * `clientInfo`). Without it the agent is an unknown client: AgentChat lists
 * the wake-webhook tools and tells it to register a webhook, a second wake
 * path next to this plugin's socket. The entry is static — the same in
 * every release, no version in it (AgentChat learns the plugin's version
 * from its socket and REST traffic) — so an install is brought up to date
 * at most once and the plugin never rewrites the operator's config on an
 * upgrade. An entry an earlier release wrote (bearer only) is still ours
 * and gains the header in place — at the gateway's start, by setup and by
 * `openclaw doctor --fix`; a hand-written or disabled entry is never
 * touched, and doctor and status say when a hand-written one does not name
 * the client.
 */

import { integration } from 'agentchatme'

import { AGENTCHAT_CLIENT_IDENTITY, AGENTCHAT_CLIENT_NAME } from '../client-identity.js'
import { API_KEY_ENV } from '../credentials/read-env.js'
import { MCP_SERVER_NAME } from './turn.js'

export const MCP_PATH = '/mcp'
export const AUTH_HEADER_TEMPLATE = `Bearer \${${API_KEY_ENV}}`
export const DEFAULT_API_BASE = 'https://api.agentchat.me'

export function hostedMcpUrl(apiBase: string = DEFAULT_API_BASE): string {
  return `${apiBase.replace(/\/+$/, '')}${MCP_PATH}`
}

/** The header that names the calling client to AgentChat (the server reads it case-insensitively). */
export const CLIENT_HEADER = 'X-AgentChat-Client'

export interface McpServerEntry {
  readonly url: string
  readonly transport: 'streamable-http'
  readonly headers: {
    readonly Authorization: string
    readonly [CLIENT_HEADER]: string
  }
}

/** The identity header the entry carries: the client's name, the same in every release. */
export function clientIdentityHeaders(): { readonly [CLIENT_HEADER]: string } {
  return { [CLIENT_HEADER]: AGENTCHAT_CLIENT_NAME }
}

/** `X-AgentChat-Client: openclaw` — for log and status lines. */
export function clientIdentityText(): string {
  return `${CLIENT_HEADER}: ${AGENTCHAT_CLIENT_NAME}`
}

/** The `mcp.servers.agentchat` value this plugin places. */
export function hostedMcpServerEntry(apiBase: string = DEFAULT_API_BASE): McpServerEntry {
  return {
    url: hostedMcpUrl(apiBase),
    transport: 'streamable-http',
    headers: { Authorization: AUTH_HEADER_TEMPLATE, ...clientIdentityHeaders() },
  }
}

/** The same entry as JSON5, for the README and for operators placing it by hand. */
export function hostedMcpSnippet(apiBase: string = DEFAULT_API_BASE): string {
  const identity = clientIdentityHeaders()
  return [
    '{',
    '  mcp: {',
    '    servers: {',
    `      ${MCP_SERVER_NAME}: {`,
    `        url: "${hostedMcpUrl(apiBase)}",`,
    '        transport: "streamable-http",',
    '        headers: {',
    `          Authorization: "${AUTH_HEADER_TEMPLATE}",`,
    `          "${CLIENT_HEADER}": "${identity[CLIENT_HEADER]}",`,
    '        },',
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
  // Any casing; two spellings of the header are not something this plugin wrote.
  const auths = headerValues(headers as Record<string, unknown>, 'Authorization')
  if (auths.length > 1) return false
  const auth = auths[0]
  if (auth === undefined) return true
  if (typeof auth !== 'string') return false
  if (auth === AUTH_HEADER_TEMPLATE || auth.includes(`\${${API_KEY_ENV}}`)) return true
  return apiKey !== undefined && apiKey.length > 0 && auth.trim() === `Bearer ${apiKey}`
}

/**
 * Whether the `mcp.servers.agentchat` entry names this client:
 * - `current` — one `X-AgentChat-Client: openclaw` (any other header, a
 *   version header included, is the entry's business and left alone);
 * - `missing` — no `X-AgentChat-Client`, another client's name, or two
 *   spellings of it (there is no entry at all, or it is not an object, is
 *   `missing` too).
 * Header names are matched without regard to case, as HTTP does.
 */
export type McpIdentityState = 'current' | 'missing'

export function describeMcpIdentity(cfg: unknown): McpIdentityState {
  const entry = agentchatEntry(cfg)
  const headers = entry && isRecord(entry.headers) ? entry.headers : undefined
  if (!headers) return 'missing'
  const want = clientIdentityHeaders()
  // Two spellings of one header reach the server joined ("openclaw, openclaw"),
  // which names no client it knows: as good as none.
  const clients = headerValues(headers, CLIENT_HEADER)
  const client = clients[0]
  return clients.length === 1 && typeof client === 'string' && client.trim().toLowerCase() === want[CLIENT_HEADER] ? 'current' : 'missing'
}

export type McpEntryOutcome = 'added' | 'updated' | 'present' | 'user_managed' | 'disabled'

/**
 * Return a config with `mcp.servers.agentchat` present and naming this
 * client. Pure: the caller persists the result through OpenClaw (the wizard
 * returns it; the doctor returns it as a repair). Our entry from an earlier
 * release is brought up to date in place (`updated`, see
 * `upgradedHostedMcpEntry`). A same-name entry the user wrote themselves, or
 * disabled, always wins and is never modified.
 */
export function withHostedMcpEntry<T extends object>(
  cfg: T | undefined,
  apiBase: string = DEFAULT_API_BASE,
  apiKey?: string,
): { cfg: T; outcome: McpEntryOutcome } {
  const state = describeMcpEntry(cfg, apiBase, apiKey)
  const base = (cfg ?? {}) as T
  if (state === 'user_managed') return { cfg: base, outcome: 'user_managed' }
  if (state === 'disabled') return { cfg: base, outcome: 'disabled' }
  if (state === 'ours' && describeMcpIdentity(base) === 'current') return { cfg: base, outcome: 'present' }
  const mcp = { ...((base as { mcp?: Record<string, unknown> }).mcp ?? {}) }
  const servers = { ...((mcp.servers as Record<string, unknown> | undefined) ?? {}) }
  const existing = servers[MCP_SERVER_NAME]
  servers[MCP_SERVER_NAME] = state === 'ours' && isRecord(existing) ? upgradedHostedMcpEntry(existing, apiBase) : hostedMcpServerEntry(apiBase)
  mcp.servers = servers
  return { cfg: { ...base, mcp } as T, outcome: state === 'ours' ? 'updated' : 'added' }
}

/**
 * Our entry, brought up to date: one `X-AgentChat-Client: openclaw` (every
 * other spelling of it dropped), and everything else exactly as it was —
 * the bearer included (same header name, same value), timeouts,
 * `toolFilter`, other headers. The bearer is never rewritten: the config OpenClaw hands a plugin
 * (and the draft `mutateConfigFile` gives it) is env-substituted, so the
 * value seen may be the key itself; written back unchanged, OpenClaw
 * restores the `${VAR}` reference the file had at that path, and an operator
 * who chose another variable, or a literal, keeps it.
 */
export function upgradedHostedMcpEntry(entry: Readonly<Record<string, unknown>>, apiBase: string = DEFAULT_API_BASE): Record<string, unknown> {
  const headers = isRecord(entry.headers) ? entry.headers : {}
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== CLIENT_HEADER.toLowerCase()))
  return {
    ...entry,
    url: hostedMcpUrl(apiBase),
    transport: 'streamable-http',
    headers: { ...kept, ...clientIdentityHeaders() },
  }
}

/**
 * In-place form of the upgrade, for OpenClaw's `mutateConfigFile` draft:
 * true when our entry was out of date and is now current. Classifies the
 * draft itself (the file as it is now, env-substituted like any config a
 * plugin sees — hence `apiKey`), so an entry the operator took over in the
 * meantime is left alone. Never adds a missing entry.
 */
export function upgradeHostedMcpEntryInPlace(draft: unknown, apiBase: string = DEFAULT_API_BASE, apiKey?: string): boolean {
  if (describeMcpEntry(draft, apiBase, apiKey) !== 'ours' || describeMcpIdentity(draft) === 'current') return false
  const servers = (draft as { mcp: { servers: Record<string, unknown> } }).mcp.servers
  const existing = servers[MCP_SERVER_NAME]
  if (!isRecord(existing)) return false
  servers[MCP_SERVER_NAME] = upgradedHostedMcpEntry(existing, apiBase)
  return true
}

/** What `mutateConfigFile` looks like on `runtime.config` (OpenClaw 2026.6.10 and later). */
export interface ConfigMutator {
  mutateConfigFile?: (params: { afterWrite: { mode: 'auto' }; mutate: (draft: never) => unknown }) => Promise<{ result?: unknown } | unknown>
}

export type McpRefreshOutcome = 'updated' | 'current' | 'not_ours' | 'unsupported' | 'failed'

/** Thrown from the mutate callback to abort a write that would change nothing. */
class NoChange extends Error {
  constructor(readonly outcome: 'current' | 'not_ours') {
    super(`no change (${outcome})`)
  }
}

/** OpenClaw's error for a config it may not write (Nix mode). */
export const NIX_MODE_ERROR_CODE = 'OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE'

/**
 * At the gateway's start: bring our `mcp.servers.agentchat` up to date when
 * the live config shows it does not name the client (an install from a
 * release before 0.10.1) — once per install, since the entry is the same in
 * every release from then on. One focused write through OpenClaw's
 * `runtime.config.mutateConfigFile` (its draft is the file as it is now,
 * env-substituted; OpenClaw restores `${VAR}` references on the paths left
 * unchanged), with `afterWrite: auto` — under the default reload mode
 * OpenClaw applies an `mcp.*` change hot. Nothing is written when the entry
 * is current, missing (setup and `doctor --fix` add it), disabled or
 * hand-written; `mutateConfigFile` commits whatever the callback leaves, so
 * a draft that needs no change aborts the write. Never throws.
 */
export async function refreshHostedMcpEntry(params: {
  liveCfg: unknown
  config: ConfigMutator | undefined
  apiBase?: string
  apiKey?: string
}): Promise<{ outcome: McpRefreshOutcome; error?: string; code?: string }> {
  const apiBase = params.apiBase ?? DEFAULT_API_BASE
  if (describeMcpEntry(params.liveCfg, apiBase, params.apiKey) !== 'ours') return { outcome: 'not_ours' }
  if (describeMcpIdentity(params.liveCfg) === 'current') return { outcome: 'current' }
  const mutate = params.config?.mutateConfigFile
  if (typeof mutate !== 'function') return { outcome: 'unsupported' }
  try {
    // The file can differ from the live read (an edit in between): the draft
    // is classified again, and an entry that is no longer ours is left alone.
    await mutate.call(params.config, {
      afterWrite: { mode: 'auto' },
      mutate: ((draft: unknown) => {
        if (describeMcpEntry(draft, apiBase, params.apiKey) !== 'ours') throw new NoChange('not_ours')
        if (!upgradeHostedMcpEntryInPlace(draft, apiBase, params.apiKey)) throw new NoChange('current')
      }) as (draft: never) => unknown,
    })
    return { outcome: 'updated' }
  } catch (err) {
    if (err instanceof NoChange) return { outcome: err.outcome }
    const code = (err as { code?: unknown } | null)?.code
    return {
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
      ...(typeof code === 'string' ? { code } : {}),
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function agentchatEntry(cfg: unknown): Record<string, unknown> | undefined {
  const servers = (cfg as { mcp?: { servers?: unknown } } | undefined)?.mcp?.servers
  if (!isRecord(servers)) return undefined
  const entry = servers[MCP_SERVER_NAME]
  return isRecord(entry) ? entry : undefined
}

/** Every value of a header, in any spelling of its name (HTTP names ignore case). */
function headerValues(headers: Readonly<Record<string, unknown>>, name: string): unknown[] {
  const wanted = name.toLowerCase()
  return Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === wanted)
    .map(([, value]) => value)
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
