/**
 * Placing the four things the main line authored where OpenClaw loads them.
 *
 * 1. **The key** — `AGENTCHAT_API_KEY=…` in OpenClaw's state-dir `.env`
 *    (`~/.openclaw/.env`, or `$OPENCLAW_STATE_DIR/.env`), which OpenClaw
 *    reads at start as its global environment fallback. The hosted MCP
 *    server's bearer header is a template on that variable, so the key is
 *    never written into `openclaw.json` as part of the tool declaration.
 *    (The channel's own `channels.agentchat.apiKey` keeps holding the key
 *    for the socket, as before.)
 * 2. **The identity line** — the manual's anchor text in the workspace
 *    `AGENTS.md`, loaded into every turn (`../binding/agents-anchor.ts`).
 * 3. **The manual** — `https://agentchat.me/skill.md` verbatim, bundled as
 *    the `agentchat` skill. Nothing to write; verified present.
 * 4. **The tools** — `mcp.servers.agentchat` in `openclaw.json` (`./mcp.ts`),
 *    returned as a config patch for OpenClaw to persist.
 *
 * Every placer is idempotent and reports what it did; the wizard prints the
 * report, the status probe and the doctor run the checks again.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { API_KEY_ENV } from '../credentials/read-env.js'
import { resolveBoundAgentId, resolveOpenClawDefaultAgentId, resolveOpenClawStateDir } from '../openclaw-layout.js'
import { describeMcpEntry, hostedMcpUrl, withHostedMcpEntry, withoutHostedMcpEntry, type McpEntryOutcome } from './mcp.js'
import { LLM_AGENT_OVERRIDE_PATH, withLlmAgentOverrideOptIn } from './model.js'
import { writeAgentsAnchor, agentsAnchorPath, hasAgentsAnchorFor, removeAgentsAnchor } from '../binding/agents-anchor.js'
import { AGENTCHAT_CHANNEL_ID, AGENTCHAT_DEFAULT_ACCOUNT_ID, applyAgentchatAccountPatch, readAgentchatConfigField } from '../channel-account.js'

const HANDLE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
function isValidHandleShape(value: string): boolean {
  return value.length >= 3 && value.length <= 30 && HANDLE_PATTERN.test(value)
}

export type PlacementStatus = 'ok' | 'changed' | 'skipped' | 'failed'

export interface PlacementStep {
  readonly name: 'key' | 'anchor' | 'manual' | 'mcp'
  readonly status: PlacementStatus
  readonly detail: string
}

const DOTENV_NAME = '.env'

export { resolveOpenClawStateDir }

export function dotEnvPath(stateDir: string = resolveOpenClawStateDir()): string {
  return path.join(stateDir, DOTENV_NAME)
}

/**
 * Upsert `AGENTCHAT_API_KEY=<key>` in the state-dir `.env`. Other lines are
 * kept byte for byte; the file is created `0600` when absent. Returns the
 * path and whether the content changed.
 */
export function placeApiKeyInDotEnv(apiKey: string, stateDir: string = resolveOpenClawStateDir()): { path: string; changed: boolean } {
  const trimmed = apiKey.trim()
  if (!trimmed) throw new Error('placeApiKeyInDotEnv: key is empty')
  if (/[\r\n]/.test(trimmed)) throw new Error('placeApiKeyInDotEnv: key contains a line break')
  const file = dotEnvPath(stateDir)
  fs.mkdirSync(stateDir, { recursive: true })
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const next = upsertDotEnvLine(existing, API_KEY_ENV, trimmed)
  if (next === existing) return { path: file, changed: false }
  fs.writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Best effort: a filesystem without POSIX modes keeps its own defaults.
  }
  return { path: file, changed: true }
}

/** Blank the key line (keeps the variable name so a later placement finds its slot). */
export function clearApiKeyInDotEnv(stateDir: string = resolveOpenClawStateDir()): { path: string; changed: boolean } {
  const file = dotEnvPath(stateDir)
  if (!fs.existsSync(file)) return { path: file, changed: false }
  const existing = fs.readFileSync(file, 'utf8')
  const next = existing
    .split(/\r?\n/)
    .filter((line) => !lineSetsVariable(line, API_KEY_ENV))
    .join('\n')
  if (next === existing) return { path: file, changed: false }
  fs.writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 })
  return { path: file, changed: true }
}

/** The value the state-dir `.env` holds for the key, if any. */
export function readApiKeyFromDotEnv(stateDir: string = resolveOpenClawStateDir()): string | undefined {
  const file = dotEnvPath(stateDir)
  if (!fs.existsSync(file)) return undefined
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!lineSetsVariable(line, API_KEY_ENV)) continue
    const value = line.slice(line.indexOf('=') + 1).trim()
    return stripQuotes(value) || undefined
  }
  return undefined
}

export function upsertDotEnvLine(content: string, name: string, value: string): string {
  const line = `${name}=${value}`
  const lines = content.length > 0 ? content.split(/\r?\n/) : []
  let replaced = false
  const out = lines.map((existing) => {
    if (!replaced && lineSetsVariable(existing, name)) {
      replaced = true
      return line
    }
    return existing
  })
  if (!replaced) {
    if (out.length > 0 && out[out.length - 1] !== '') out.push(line)
    else if (out.length > 0) out.splice(out.length - 1, 0, line)
    else out.push(line)
  }
  let next = out.join('\n')
  if (!next.endsWith('\n')) next += '\n'
  return next
}

function lineSetsVariable(line: string, name: string): boolean {
  const trimmed = line.trim()
  if (trimmed.startsWith('#')) return false
  const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
  return body.startsWith(`${name}=`)
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

// ─── the config side of placement (pure) ───────────────────────────────

export interface DoorbellConfigParams {
  readonly accountId: string
  /** The handle the key authenticates as; omitted when not yet known (an older OpenClaw without `prepareAccountConfigInput`). */
  readonly handle?: string | undefined
  readonly apiKey: string
  readonly apiBase: string
}

/**
 * Everything placement writes INTO `openclaw.json`, as one pure patch:
 * `channels.agentchat.agentHandle` (the handle the key authenticates as),
 * `mcp.servers.agentchat` (the hosted tools), and — only when the account
 * is bound to an agent other than OpenClaw's default —
 * `plugins.entries.agentchat.llm.allowAgentIdOverride`. Returns the config
 * and one line per change, for the wizard, the non-interactive hook (through
 * `runtime.config.mutateConfigFile`) and `doctor --fix` alike.
 */
export function applyDoorbellConfig<TCfg extends object>(cfg: TCfg, params: DoorbellConfigParams): { cfg: TCfg; changes: string[] } {
  const changes: string[] = []
  let next: TCfg = cfg
  const bareHandle = (params.handle ?? '').trim().replace(/^@/, '')
  if (bareHandle && readAgentchatConfigField(next as never, params.accountId, 'agentHandle') !== bareHandle && isValidHandleShape(bareHandle)) {
    next = applyAgentchatAccountPatch(next as never, params.accountId, { agentHandle: bareHandle }) as unknown as TCfg
    changes.push(`channels.agentchat${params.accountId === AGENTCHAT_DEFAULT_ACCOUNT_ID ? '' : `.accounts.${params.accountId}`}.agentHandle = ${bareHandle}`)
  }
  const mcp = withHostedMcpEntry(next, params.apiBase, params.apiKey)
  next = mcp.cfg
  if (mcp.outcome === 'added') changes.push(`mcp.servers.agentchat → ${hostedMcpUrl(params.apiBase)} (bearer template on ${API_KEY_ENV})`)
  const bound = resolveBoundAgentId(next, AGENTCHAT_CHANNEL_ID, params.accountId)
  const ambient = resolveOpenClawDefaultAgentId(next)
  if (bound && bound !== (ambient ?? bound)) {
    const optIn = withLlmAgentOverrideOptIn(next)
    next = optIn.cfg
    if (optIn.changed) changes.push(`${LLM_AGENT_OVERRIDE_PATH} = true (account bound to agent "${bound}", not the default)`)
  }
  return { cfg: next, changes }
}

/** The agent this account's identity line belongs to: the bound agent, else OpenClaw's default. */
export function resolvePlacementAgentId(cfg: object | undefined, accountId: string): string | undefined {
  return resolveBoundAgentId(cfg, AGENTCHAT_CHANNEL_ID, accountId) ?? resolveOpenClawDefaultAgentId(cfg)
}

/**
 * Undo the config side of placement for an account that is being disabled
 * or deleted: the plugin's own `mcp.servers.agentchat` entry goes (a
 * hand-written one stays). Pure; shared by `config.setAccountEnabled`,
 * `config.deleteAccount` and the wizard's `disable`.
 */
export function stripDoorbellConfig<TCfg extends object>(cfg: TCfg, accountId: string): { cfg: TCfg; changes: string[] } {
  const apiBase = readAgentchatConfigField(cfg as never, accountId, 'apiBase') ?? 'https://api.agentchat.me'
  const apiKey = readAgentchatConfigField(cfg as never, accountId, 'apiKey')
  const { cfg: next, removed } = withoutHostedMcpEntry(cfg, apiBase, apiKey)
  return { cfg: next, changes: removed ? ['removed mcp.servers.agentchat'] : [] }
}

/**
 * Undo the file side of placement: the identity line in the bound agent's
 * `AGENTS.md`, and — on delete — the key line in the state-dir `.env`.
 * Best-effort: a filesystem error never blocks a remove.
 */
export function removeDoorbellFiles(cfg: object | undefined, accountId: string, options: { clearKey: boolean; stateDir?: string }): string[] {
  const changes: string[] = []
  try {
    const removed = removeAgentsAnchor({ cfg: cfg as never, agentId: resolvePlacementAgentId(cfg, accountId) })
    if (removed.removed) changes.push(`removed the identity line from ${removed.path}`)
  } catch {
    // best effort
  }
  if (options.clearKey) {
    try {
      const cleared = clearApiKeyInDotEnv(options.stateDir)
      if (cleared.changed) changes.push(`removed ${API_KEY_ENV} from ${cleared.path}`)
    } catch {
      // best effort
    }
  }
  return changes
}

// ─── placement, as one report ──────────────────────────────────────────

export interface PlaceParams<TCfg extends object> {
  readonly cfg: TCfg | undefined
  readonly handle: string
  readonly apiKey: string
  readonly apiBase: string
  /** The channel account; selects the bound agent whose workspace holds the identity line. */
  readonly accountId?: string
  /** Explicit agent whose workspace holds the identity line; defaults to the bound agent, else OpenClaw's default. */
  readonly agentId?: string | undefined
  /** Test seam: where the state-dir `.env` lives. */
  readonly stateDir?: string
  /** Test seam: skip the `.env` write (e.g. a read-only CI). */
  readonly placeKey?: boolean
}

export interface PlaceResult<TCfg extends object> {
  readonly cfg: TCfg
  readonly steps: readonly PlacementStep[]
  readonly mcp: McpEntryOutcome
}

/**
 * Key, identity line, manual, tools — in that order. Never throws: each
 * step reports `failed` with the reason instead. Returns the config with
 * the tools entry applied for the caller to persist.
 */
export function placeDoorbell<TCfg extends object>(params: PlaceParams<TCfg>): PlaceResult<TCfg> {
  const steps: PlacementStep[] = []

  if (params.placeKey !== false) {
    try {
      const key = placeApiKeyInDotEnv(params.apiKey, params.stateDir)
      steps.push({
        name: 'key',
        status: key.changed ? 'changed' : 'ok',
        detail: `${API_KEY_ENV} in ${key.path}${key.changed ? ` (a gateway started before this needs a restart, or a config reload, to resolve \${${API_KEY_ENV}})` : ''}`,
      })
    } catch (err) {
      steps.push({ name: 'key', status: 'failed', detail: `could not write ${API_KEY_ENV} to the OpenClaw .env: ${describe(err)}` })
    }
  }

  const agentId = params.agentId ?? resolvePlacementAgentId(params.cfg, params.accountId ?? AGENTCHAT_DEFAULT_ACCOUNT_ID)
  try {
    const anchor = writeAgentsAnchor({ cfg: params.cfg as never, handle: params.handle, agentId })
    steps.push({ name: 'anchor', status: 'ok', detail: `identity line for @${params.handle.replace(/^@/, '')} in ${anchor.path}` })
  } catch (err) {
    steps.push({ name: 'anchor', status: 'failed', detail: `could not write the identity line to AGENTS.md: ${describe(err)}` })
  }

  steps.push({ name: 'manual', status: 'ok', detail: 'manual bundled as the agentchat skill (skills/agentchat/SKILL.md, https://agentchat.me/skill.md verbatim)' })

  const mcp = withHostedMcpEntry(params.cfg, params.apiBase, params.apiKey)
  steps.push(describeMcpOutcome(mcp.outcome, params.apiBase))

  return { cfg: mcp.cfg, steps, mcp: mcp.outcome }
}

export function describeMcpOutcome(outcome: McpEntryOutcome, apiBase: string): PlacementStep {
  switch (outcome) {
    case 'added':
      return { name: 'mcp', status: 'changed', detail: `hosted tools registered as mcp.servers.agentchat → ${hostedMcpUrl(apiBase)} (bearer template on ${API_KEY_ENV})` }
    case 'present':
      return { name: 'mcp', status: 'ok', detail: 'hosted tools already registered as mcp.servers.agentchat' }
    case 'disabled':
      return { name: 'mcp', status: 'skipped', detail: 'mcp.servers.agentchat exists but is disabled in openclaw.json — left alone' }
    case 'user_managed':
      return { name: 'mcp', status: 'skipped', detail: 'mcp.servers.agentchat is managed by hand in openclaw.json — left alone' }
  }
}

/** One line per step, for the wizard's note and the status pane. */
export function formatPlacement(steps: readonly PlacementStep[]): string[] {
  return steps.map((step) => `${step.status === 'failed' ? '✗' : step.status === 'skipped' ? '–' : '✓'} ${step.name}: ${step.detail}`)
}

// ─── checks (doctor / status) ──────────────────────────────────────────

export interface PlacementCheck {
  readonly name: 'key' | 'anchor' | 'manual' | 'mcp'
  readonly ok: boolean
  readonly detail: string
}

export function checkPlacement<TCfg extends object>(params: {
  cfg: TCfg | undefined
  handle: string | undefined
  apiKey: string | undefined
  apiBase: string
  agentId?: string | undefined
  stateDir?: string
  /** The gateway's own environment (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv
}): PlacementCheck[] {
  const checks: PlacementCheck[] = []
  const env = params.env ?? process.env

  // What this process can see: its own environment and the state-dir .env.
  // It cannot see the running gateway's environment (OpenClaw loads the
  // state-dir .env into every process, the CLI included), so the wording
  // never claims to.
  const inProcess = (env[API_KEY_ENV] ?? '').trim()
  const inDotEnv = readApiKeyFromDotEnv(params.stateDir)
  if (params.apiKey && (inProcess === params.apiKey || inDotEnv === params.apiKey)) {
    checks.push({
      name: 'key',
      ok: true,
      detail:
        `${API_KEY_ENV} ${inProcess === params.apiKey ? 'present in this process' : `in ${dotEnvPath(params.stateDir)}`}; ` +
        `a gateway started before the wizard placed it needs a restart (or a config reload) to resolve \${${API_KEY_ENV}}`,
    })
  } else if (inProcess || inDotEnv) {
    checks.push({ name: 'key', ok: false, detail: `${API_KEY_ENV} differs from the configured channel key — re-run the wizard to place the current key` })
  } else {
    checks.push({ name: 'key', ok: false, detail: `${API_KEY_ENV} is not placed — the hosted tools cannot authenticate; run openclaw channels add agentchat` })
  }

  if (params.handle) {
    const anchor = hasAgentsAnchorFor({ cfg: params.cfg as never, handle: params.handle, agentId: params.agentId })
    checks.push({
      name: 'anchor',
      ok: anchor.present,
      detail: anchor.present ? `identity line for @${params.handle} in ${anchor.path}` : `identity line for @${params.handle} missing from ${anchor.path} — run openclaw channels add agentchat`,
    })
  } else {
    checks.push({ name: 'anchor', ok: false, detail: 'agentHandle not in config — the identity line cannot be checked' })
  }

  checks.push({ name: 'manual', ok: true, detail: 'manual bundled as the agentchat skill' })

  const mcpState = describeMcpEntry(params.cfg, params.apiBase, params.apiKey)
  checks.push({
    name: 'mcp',
    ok: mcpState === 'ours' || mcpState === 'user_managed',
    detail:
      mcpState === 'ours'
        ? 'hosted tools registered as mcp.servers.agentchat'
        : mcpState === 'user_managed'
          ? 'mcp.servers.agentchat is managed by hand'
          : mcpState === 'disabled'
            ? 'mcp.servers.agentchat is disabled — the agent has no AgentChat tools'
            : 'mcp.servers.agentchat missing — run openclaw channels add agentchat or openclaw doctor --fix',
  })
  return checks
}

export { agentsAnchorPath }

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
