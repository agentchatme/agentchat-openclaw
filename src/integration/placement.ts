/**
 * Placing the four things AgentChat authored where OpenClaw loads them.
 *
 * 1. **The key** — stored once, in a `0600` key file only this plugin reads
 *    (`../credentials/key-file.ts`); `openclaw.json` holds its path
 *    (`channels.agentchat.apiKeyFile`), never the key. The hosted tools
 *    need it too, and OpenClaw gives a static `mcp.servers` entry no other
 *    way to a credential than its config text or the gateway's environment
 *    (`headers` are plain strings with `${VAR}` substitution from the
 *    process environment; SecretRefs are not accepted there — OpenClaw
 *    `src/config/zod-schema.mcp-server.ts`). So `AGENTCHAT_API_KEY=…` is
 *    also placed in OpenClaw's state-dir `.env` (`~/.openclaw/.env`, or
 *    `$OPENCLAW_STATE_DIR/.env`), which OpenClaw loads at start, and the
 *    tools' bearer header is a template on that variable. Known limit: the
 *    gateway's environment is inherited by the commands its agent runs, so
 *    the key is in their environment as well; taking it out needs the tools
 *    connection held by this plugin, or OpenClaw support for secret
 *    references on MCP headers.
 * 2. **The identity line** — the served `identity_line` (`GET /v1/texts`,
 *    `../integration/texts.ts`) in the workspace `AGENTS.md`, loaded into
 *    every turn (`../binding/agents-anchor.ts`). The callers fetch the text
 *    (server, then the cached copy) and hand it in; with neither available
 *    the step is skipped and reported, never invented.
 * 3. **The manual** — the served one (`https://agentchat.me/skill.md`, as
 *    the texts announce it), kept current as the `agentchat` skill in
 *    OpenClaw's managed skills dir (`<config dir>/skills/agentchat/SKILL.md`,
 *    `./manual.ts`). The callers sync it (`placeManual`, async) and hand the
 *    outcome in; the copy bundled with the plugin is the floor.
 * 4. **The tools** — `mcp.servers.agentchat` in `openclaw.json` (`./mcp.ts`),
 *    returned as a config patch for OpenClaw to persist.
 *
 * Every placer is idempotent and reports what it did; the wizard prints the
 * report, the status probe and the doctor run the checks again.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { openclawCommand } from '../cli-command.js'
import { API_KEY_ENV, readApiKeyVariable } from '../credentials/read-env.js'
import {
  filesHoldingKey,
  listAccountKeyFiles,
  openClawConfigBackupRing,
  openClawConfigCopyPaths,
  writeApiKeyFile,
} from '../credentials/key-file.js'
import { resolveBoundAgentId, resolveOpenClawConfigPath, resolveOpenClawDefaultAgentId, resolveOpenClawStateDir } from '../openclaw-layout.js'
import { readAgentchatApiKey, resolveAgentchatApiKey, type ConfiguredKey } from '../channel-key.js'
import {
  CLIENT_HEADER,
  toolsUseOtherKey,
  clientIdentityHeaders,
  clientIdentityText,
  describeMcpEntry,
  describeMcpIdentity,
  hostedMcpUrl,
  withHostedMcpEntry,
  withoutHostedMcpEntry,
  type McpEntryOutcome,
} from './mcp.js'
import { LLM_AGENT_OVERRIDE_PATH, withLlmAgentOverrideOptIn } from './model.js'
import { bundledManual, checkManual, describeManualOutcome, latestManualOutcome, shadowLine, type ManualOutcome } from './manual.js'
import { cachedIdentityLine, cachedIdentityTemplate, cachedServedTexts } from './texts.js'
import type { integration } from 'agentchatme'

type ServedManual = integration.ServedManual
import {
  agentsAnchorPath,
  ANCHOR_END,
  ANCHOR_START,
  followAgentsAnchor,
  inspectAgentsAnchor,
  placeAgentsAnchor,
  removeAgentsAnchor,
  type AnchorResult,
  type FollowResult,
  type RemoveResult,
} from '../binding/agents-anchor.js'
import {
  AGENTCHAT_CHANNEL_ID,
  AGENTCHAT_DEFAULT_ACCOUNT_ID,
  agentchatReenableHint,
  applyAgentchatAccountPatch,
  isAgentchatAccountEnabled,
  readAgentchatConfigField,
} from '../channel-account.js'

const HANDLE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
function isValidHandleShape(value: string): boolean {
  return value.length >= 3 && value.length <= 30 && HANDLE_PATTERN.test(value)
}

/** `warned`: done as far as it could be, the agent works, but something needs a look (a stale manual, someone else's file). */
export type PlacementStatus = 'ok' | 'changed' | 'skipped' | 'warned' | 'failed'

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

// ─── the key: one key file, and the variable the hosted tools read ─────

export interface StoredKey {
  /** The key file (`0600`) the config's `apiKeyFile` names. */
  readonly file: string
  /** False when the file already held this key. */
  readonly created: boolean
  /** The state-dir `.env` line the hosted tools' bearer template reads; absent when it could not be written. */
  readonly dotenv?: { readonly path: string; readonly changed: boolean }
  /** Why the `.env` line could not be written (the key file was). */
  readonly dotenvError?: string
}

/**
 * Store an accepted key: the key file (the copy this plugin reads), and —
 * per `dotenv` — the `.env` line for the hosted tools. The key file is safe
 * to write before a config write that may not happen (its name follows from
 * the key, so no config's file changes); the `.env` line is not (a `.env`
 * holding a key the config does not name makes the gateway refuse to
 * start), so callers before a write pass `'if-absent'` (a first placement:
 * no account to contradict) or `'never'` and place it once the config is
 * written (`placeIntegration`). Throws when the key file cannot be written —
 * the caller must then not point the config at it; a failed `.env` write is
 * reported, not thrown.
 */
export function storeAccountKey(
  accountId: string,
  apiKey: string,
  options: { stateDir?: string; dotenv?: 'always' | 'if-absent' | 'never' } = {},
): StoredKey {
  const written = writeApiKeyFile(accountId, apiKey, options.stateDir)
  const mode = options.dotenv ?? 'always'
  if (mode === 'never' || (mode === 'if-absent' && readApiKeyFromDotEnv(options.stateDir) !== undefined)) {
    return { file: written.path, created: written.created }
  }
  try {
    const dotenv = placeApiKeyInDotEnv(apiKey, options.stateDir)
    return { file: written.path, created: written.created, dotenv }
  } catch (err) {
    return { file: written.path, created: written.created, dotenvError: describe(err) }
  }
}

/**
 * OpenClaw's own copies of `openclaw.json` (its backup ring, last-good and
 * pre-update copies) that still hold `apiKey` in plain text — paths only.
 * The plugin never edits them; the operator is told where they are.
 */
export function openClawCopiesHoldingKey(apiKey: string | undefined, configPath: string = resolveOpenClawConfigPath()): string[] {
  if (!apiKey) return []
  return filesHoldingKey(apiKey, openClawConfigCopyPaths(configPath))
}

/**
 * OpenClaw's copies that hold `apiKey` once OpenClaw has written
 * `openclaw.json` ONE more time — for a hook that runs before that write
 * and is followed by exactly one (`channels remove --delete`: OpenClaw runs
 * the removal hook, then writes the config once). The write rotates the
 * backup ring (`openClawConfigBackupRing`): the config as it is now becomes
 * `.bak`, each `.bak.N` becomes `.bak.N+1`, `.bak.4` is dropped; the
 * last-good, pre-update and rejected copies stay as they are. Paths only.
 */
export function openClawCopiesHoldingKeyAfterWrite(apiKey: string | undefined, configPath: string = resolveOpenClawConfigPath()): string[] {
  if (!apiKey) return []
  const ring = openClawConfigBackupRing(configPath)
  const others = openClawConfigCopyPaths(configPath).filter((file) => !ring.includes(file))
  const holding = new Set(filesHoldingKey(apiKey, [configPath, ...ring, ...others]))
  return [
    ...(holding.has(configPath) ? [ring[0]!] : []),
    ...ring.slice(0, -1).flatMap((file, index) => (holding.has(file) ? [ring[index + 1]!] : [])),
    ...others.filter((file) => holding.has(file)),
  ]
}

/**
 * One sentence naming OpenClaw's copies that hold the key, or null.
 * `when` says at what point the list is true (`once OpenClaw has written this removal`) when
 * that is not now.
 */
export function describeKeyCopies(paths: readonly string[], when?: string): string | null {
  if (paths.length === 0) return null
  return (
    `${when ? `${when.charAt(0).toUpperCase()}${when.slice(1)}, ` : ''}OpenClaw's own copies of openclaw.json still hold this key in plain text: ${paths.join(', ')} — ` +
    'OpenClaw writes and rotates them (its config backup ring and last-good copy) and the plugin does not edit them; ' +
    `delete them, or rotate the key (${openclawCommand('channels add --channel agentchat')} → Recover) if anyone else could have read them`
  )
}

/**
 * For a command that moves the key out of `openclaw.json` while its own
 * config writes are still to come (`openclaw doctor --fix`, the setup
 * wizard): OpenClaw decides how many writes follow, and each one rotates
 * the backup ring, so no list of files made now would still be right when
 * the command ends. The old config holding the key becomes a backup on the
 * first of them; a read-only check names the copies once it is done.
 */
export function keyCopiesAfterRunLine(): string {
  return (
    "OpenClaw's own backups of openclaw.json (openclaw.json.bak, .bak.1 … .bak.4, .last-good) keep the old plain-text key until they rotate out, " +
    `and this command's own config writes rotate them — once it is done, \`${openclawCommand('doctor --lint')}\` names the ones that still hold it; ` +
    `delete those, or rotate the key (${openclawCommand('channels add --channel agentchat')} → Recover) if anyone else could have read them`
  )
}

/**
 * Set once this process has taken a plain-text key out of the config (doctor
 * --fix): OpenClaw writes the config after that, so the copies are listed by
 * a later read-only run, not by this one (`keyAtRestWarnings`).
 */
let keyMovedInThisProcess = false

export function noteKeyMovedOutOfConfig(): void {
  keyMovedInThisProcess = true
}

/** Test seam. */
export function resetKeyMovedForTest(): void {
  keyMovedInThisProcess = false
}

// ─── the config side of placement (pure) ───────────────────────────────

export interface IntegrationConfigParams {
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
export function applyIntegrationConfig<TCfg extends object>(cfg: TCfg, params: IntegrationConfigParams): { cfg: TCfg; changes: string[] } {
  const changes: string[] = []
  let next: TCfg = cfg
  const bareHandle = (params.handle ?? '').trim().replace(/^@/, '')
  // The handle AgentChat returned for the key: the server validated it.
  if (bareHandle && readAgentchatConfigField(next as never, params.accountId, 'agentHandle') !== bareHandle) {
    next = applyAgentchatAccountPatch(next as never, params.accountId, { agentHandle: bareHandle }) as unknown as TCfg
    changes.push(`channels.agentchat${params.accountId === AGENTCHAT_DEFAULT_ACCOUNT_ID ? '' : `.accounts.${params.accountId}`}.agentHandle = ${bareHandle}`)
  }
  const mcp = withHostedMcpEntry(next, params.apiBase, params.apiKey)
  next = mcp.cfg
  if (mcp.outcome === 'added') changes.push(`mcp.servers.agentchat → ${hostedMcpUrl(params.apiBase)} (bearer template on ${API_KEY_ENV})`)
  if (mcp.outcome === 'updated') changes.push(`mcp.servers.agentchat names this client (${clientIdentityText()})`)
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
export function stripIntegrationConfig<TCfg extends object>(cfg: TCfg, accountId: string): { cfg: TCfg; changes: string[] } {
  const apiBase = readAgentchatConfigField(cfg as never, accountId, 'apiBase') ?? 'https://api.agentchat.me'
  const apiKey = readAgentchatApiKey(cfg as never, accountId)
  const { cfg: next, removed } = withoutHostedMcpEntry(cfg, apiBase, apiKey)
  return { cfg: next, changes: removed ? ['removed mcp.servers.agentchat'] : [] }
}

/**
 * Undo the file side of placement: the identity line in the bound agent's
 * `AGENTS.md`, and — on delete — the key line in the state-dir `.env`.
 *
 * Only the block AgentChat placed for this account's agent goes: the kit's
 * strict `owner` reading, against the configured `agentHandle` and the
 * cached served texts (`removeAgentsAnchor`). A block edited by hand (the
 * user's own words), another agent's, or several blocks stay, and the
 * report says so.
 *
 * The key file is NOT deleted: OpenClaw runs this before it commits the
 * removal (`applyChannelAccountRemoval`, `src/channels/plugins/
 * account-config-mutation.ts`) and may still refuse the write (its
 * size-drop guard does on a small config), which would leave the config
 * naming a key file that is gone — the only copy of the agent's key, lost.
 * The report names the key file instead, with how to delete it or add the
 * agent again from it; `.env` is a placement `openclaw doctor --fix`
 * restores from the key file. Copies of the key OpenClaw keeps itself (its
 * config backups) are named, never edited. Best-effort: a filesystem error
 * never blocks a remove.
 */
export async function removeIntegrationFiles(
  cfg: object | undefined,
  accountId: string,
  options: { clearKey: boolean; stateDir?: string; configPath?: string },
): Promise<string[]> {
  const changes: string[] = []
  const handle = readAgentchatConfigField(cfg as never, accountId, 'agentHandle')?.trim().replace(/^@/, '') || null
  try {
    const removed = await removeAgentsAnchor({
      cfg: cfg as never,
      agentId: resolvePlacementAgentId(cfg, accountId),
      handle,
      identityLine: cachedIdentityLine(accountId, options.stateDir),
      template: cachedIdentityTemplate(accountId, options.stateDir),
    })
    const line = removedAnchorLine(removed, handle)
    if (line) changes.push(line)
  } catch (err) {
    changes.push(`could not remove the identity line: ${describe(err)}; the rest of the removal goes on`)
  }
  if (options.clearKey) {
    // Read before anything is removed: the copies are found by the key itself.
    const apiKey = readAgentchatApiKey(cfg as never, accountId)
    const files = listAccountKeyFiles(accountId, options.stateDir)
    if (files.length > 0) {
      const one = files.length === 1
      changes.push(
        `kept the API key file${one ? '' : 's'} ${files.join(', ')} — ${one ? 'the copy of the key this plugin keeps' : 'the keys this plugin stored for this account'}, ` +
          'never deleted here because OpenClaw can still refuse this removal: ' +
          `delete ${one ? 'it' : 'them'} when you no longer need the agent, or add the agent again with ${openclawCommand('channels add --channel agentchat --token-file <the file>')}`,
      )
    }
    try {
      const cleared = clearApiKeyInDotEnv(options.stateDir)
      if (cleared.changed) changes.push(`removed ${API_KEY_ENV} from ${cleared.path}`)
    } catch {
      // best effort
    }
    // This hook runs before OpenClaw's one config write for the removal: name the copies as that write leaves them.
    const copies = describeKeyCopies(openClawCopiesHoldingKeyAfterWrite(apiKey, options.configPath), 'once OpenClaw has written this removal')
    if (copies) changes.push(copies)
  }
  return changes
}

/** What `removeIntegrationFiles` reports for the identity block; null when there was nothing to remove. */
function removedAnchorLine(removed: RemoveResult, handle: string | null): string | null {
  const byHand = 'remove it by hand if you no longer want it'
  switch (removed.outcome) {
    case 'removed':
      return `removed the identity line for @${handle ?? removed.claimed ?? '?'} from ${removed.path}`
    case 'absent':
      return null
    case 'hand_edited':
      return `left your edited AgentChat block in ${removed.path}; ${byHand}`
    case 'other_agent':
      return `left the AgentChat block in ${removed.path}: it is @${removed.claimed ?? '?'}'s, not @${handle ?? '?'}'s`
    case 'several_blocks':
      return `left the AgentChat blocks in ${removed.path}: there is more than one, so none is plainly this agent's; remove them by hand if you no longer want them`
    case 'no_handle':
      return `left the AgentChat block in ${removed.path}: agentHandle is not in the config, so it cannot be told to be this agent's; ${byHand}`
    case 'edited_meanwhile':
      return `left the AgentChat block in ${removed.path}: the file kept changing; ${byHand}`
  }
}

export interface IdentityLineRestore {
  /**
   * `placed`: there was no block, there is now; `updated`: this agent's block
   * now holds the served line; `present`: it already did; `left`: a block
   * that is not plainly this agent's (edited by hand, another agent's,
   * several blocks) or a file that kept changing, left as it is (`detail`
   * says what to do); `skipped`: no served line in hand; `failed`.
   */
  readonly outcome: 'placed' | 'updated' | 'present' | 'left' | 'failed' | 'skipped'
  readonly path: string
  readonly detail?: string
}

/**
 * What to do about an identity block the strict rule leaves alone — for the
 * log, status and doctor. `remedy` swaps `doctor --fix` for the re-enable
 * route on a disabled account.
 */
export function anchorRemedy(outcome: string, claimed: string | null, handle: string, remedy: (forEnabled: string) => string = (text) => text): string {
  const bare = handle.trim().replace(/^@/, '')
  const fix = remedy(`run \`${openclawCommand('doctor --fix')}\``)
  switch (outcome) {
    case 'hand_edited':
      return `the agent reads those words. To have the served line again: delete that block (from ${ANCHOR_START} to ${ANCHOR_END}), then ${fix}`
    case 'other_agent':
      return (
        `if this agent is @${bare}, delete that block (from ${ANCHOR_START} to ${ANCHOR_END}), then ${fix}; ` +
        `if it is @${claimed ?? '?'}, the key configured for this account is another agent's — \`${openclawCommand('channels capabilities --channel agentchat')}\` says which agent the key authenticates as`
      )
    case 'several_blocks':
      return `keep one AgentChat block (delete the others), then ${fix}`
    case 'edited_meanwhile':
      return `the file was being edited; ${fix} again`
    default:
      return fix
  }
}

/**
 * Redo the file side of placement for an enabled account: the served
 * identity line for `handle` in the bound agent's `AGENTS.md` (the
 * workspace resolved the way OpenClaw resolves it). The mirror of
 * `removeIntegrationFiles` on re-enable, and `doctor --fix`'s repair. Under
 * the kit's strict rule: a missing block is placed, this agent's is brought
 * to the served line (a block already holding it is not rewritten — the
 * file stays byte-identical), and anything not plainly this agent's — a
 * block edited by hand, another agent's — is left, with what to do.
 * `identityLine` null (texts unreachable, nothing cached) → `skipped`,
 * nothing written. Never throws.
 */
export async function restoreIdentityLine(
  cfg: object | undefined,
  accountId: string,
  handle: string,
  identityLine: string | null,
  template: string | null = null,
): Promise<IdentityLineRestore> {
  const agentId = resolvePlacementAgentId(cfg, accountId)
  const bare = handle.trim().replace(/^@/, '')
  let filePath = ''
  try {
    filePath = agentsAnchorPath(cfg as never, agentId)
    if (!isValidHandleShape(bare)) return { outcome: 'failed', path: filePath, detail: `agentHandle "${bare}" is not a valid AgentChat handle` }
    if (identityLine === null) {
      return { outcome: 'skipped', path: filePath, detail: `the served identity line is not available (AgentChat unreachable and nothing cached) — run ${openclawCommand('doctor --fix')} once it is` }
    }
    const placed = await placeAgentsAnchor({ cfg: cfg as never, agentId, handle: bare, identityLine, template })
    switch (placed.outcome) {
      case 'placed':
        return { outcome: 'placed', path: placed.path }
      case 'updated':
      case 'replaced_other':
        return { outcome: 'updated', path: placed.path, detail: placed.detail }
      case 'unchanged':
        return { outcome: 'present', path: placed.path }
      case 'failed':
        return { outcome: 'failed', path: placed.path, detail: placed.detail }
      default:
        return { outcome: 'left', path: placed.path, detail: `${placed.detail} — ${anchorRemedy(placed.outcome, placed.claimed, bare)}` }
    }
  } catch (err) {
    return { outcome: 'failed', path: filePath, detail: describe(err) }
  }
}

/**
 * The running gateway's duty when a fresh server copy of the text arrives:
 * this agent's block brought to the served line (the kit's `follow`:
 * atomic, never creating a block — placement is a setup decision — and
 * never writing one that is not plainly this agent's). `template`: the
 * served `identity_line_template`, spelled for OpenClaw, by which an
 * unmarked block is recognised. Never throws.
 */
export function followIdentityLine(
  cfg: object | undefined,
  accountId: string,
  handle: string,
  identityLine: string,
  template: string | null,
): Promise<FollowResult> {
  return followAgentsAnchor({ cfg: cfg as never, agentId: resolvePlacementAgentId(cfg, accountId), handle, identityLine, template })
}

/** A placement's anchor result as a step. A block left alone is a warning: the agent works, but not with the served line. */
export function anchorStep(placed: AnchorResult, handle: string): PlacementStep {
  const bare = handle.trim().replace(/^@/, '')
  switch (placed.outcome) {
    case 'unchanged':
      return { name: 'anchor', status: 'ok', detail: `identity line for @${bare} in ${placed.path}` }
    case 'placed':
    case 'updated':
      return { name: 'anchor', status: 'changed', detail: `identity line for @${bare} in ${placed.path}` }
    case 'replaced_other':
      return { name: 'anchor', status: 'changed', detail: `${placed.detail} (the block named another agent)` }
    case 'failed':
      return { name: 'anchor', status: 'failed', detail: placed.detail }
    default:
      return { name: 'anchor', status: 'warned', detail: `${placed.detail} — ${anchorRemedy(placed.outcome, placed.claimed, bare)}` }
  }
}

// ─── placement, as one report ──────────────────────────────────────────

export interface PlaceParams<TCfg extends object> {
  readonly cfg: TCfg | undefined
  readonly handle: string
  readonly apiKey: string
  readonly apiBase: string
  /** The served identity line (spelled for OpenClaw); `null` when AgentChat was unreachable and nothing is cached. */
  readonly identityLine: string | null
  /** The served `identity_line_template` (spelled for OpenClaw), when in hand: an unmarked block is recognised by it. */
  readonly identityTemplate?: string | null
  /** The channel account; selects the bound agent whose workspace holds the identity line. */
  readonly accountId?: string
  /** Explicit agent whose workspace holds the identity line; defaults to the bound agent, else OpenClaw's default. */
  readonly agentId?: string | undefined
  /** Test seam: where the state-dir `.env` lives. */
  readonly stateDir?: string
  /** Test seam: skip the `.env` write (e.g. a read-only CI). */
  readonly placeKey?: boolean
  /** The manual's sync (`placeManual`, run by the caller first); omitted → the managed copy is checked as it is. */
  readonly manual?: ManualOutcome | null
}

export interface PlaceResult<TCfg extends object> {
  readonly cfg: TCfg
  readonly steps: readonly PlacementStep[]
  readonly mcp: McpEntryOutcome
}

/**
 * Key, identity line, manual, tools — in that order. Never throws: each
 * step reports `failed` with the reason instead. The identity line follows
 * the kit's strict rule (`placeAgentsAnchor`). Returns the config with
 * the tools entry applied for the caller to persist. The manual is synced by
 * the caller (`placeManual` is async) and its outcome handed in.
 */
export async function placeIntegration<TCfg extends object>(params: PlaceParams<TCfg>): Promise<PlaceResult<TCfg>> {
  const steps: PlacementStep[] = []

  if (params.placeKey !== false) {
    try {
      const key = placeApiKeyInDotEnv(params.apiKey, params.stateDir)
      steps.push({
        name: 'key',
        status: key.changed ? 'changed' : 'ok',
        detail: `${API_KEY_ENV} in ${key.path}${key.changed ? ` (a gateway started before this needs a restart to resolve \${${API_KEY_ENV}})` : ''}`,
      })
    } catch (err) {
      steps.push({ name: 'key', status: 'failed', detail: `could not write ${API_KEY_ENV} to the OpenClaw .env: ${describe(err)}` })
    }
  }

  const agentId = params.agentId ?? resolvePlacementAgentId(params.cfg, params.accountId ?? AGENTCHAT_DEFAULT_ACCOUNT_ID)
  const handle = params.handle.replace(/^@/, '')
  if (params.identityLine === null) {
    steps.push({
      name: 'anchor',
      status: 'skipped',
      detail: `identity line for @${handle} not placed — AgentChat's texts were unreachable and nothing is cached; run ${openclawCommand('doctor --fix')} once it is reachable`,
    })
  } else {
    // Setup: the operator just named this agent, so a block another agent's line holds is replaced (and said so);
    // a block edited by hand, or several blocks, are left as they are.
    const placed = await placeAgentsAnchor({ cfg: params.cfg as never, agentId, handle, identityLine: params.identityLine, template: params.identityTemplate ?? null, replaceOtherAgent: true })
    steps.push(anchorStep(placed, handle))
  }

  steps.push(params.manual ? manualStep(params.manual) : manualStepAsIs(params.cfg, params.accountId ?? AGENTCHAT_DEFAULT_ACCOUNT_ID, params.stateDir))

  const mcp = withHostedMcpEntry(params.cfg, params.apiBase, params.apiKey)
  steps.push(describeMcpOutcome(mcp.outcome, params.apiBase))

  return { cfg: mcp.cfg, steps, mcp: mcp.outcome }
}

export function describeMcpOutcome(outcome: McpEntryOutcome, apiBase: string): PlacementStep {
  switch (outcome) {
    case 'added':
      return { name: 'mcp', status: 'changed', detail: `hosted tools registered as mcp.servers.agentchat → ${hostedMcpUrl(apiBase)} (bearer template on ${API_KEY_ENV})` }
    case 'updated':
      return { name: 'mcp', status: 'changed', detail: `mcp.servers.agentchat now names this client to the hosted tools (${clientIdentityText()})` }
    case 'present':
      return { name: 'mcp', status: 'ok', detail: 'hosted tools already registered as mcp.servers.agentchat' }
    case 'disabled':
      return { name: 'mcp', status: 'skipped', detail: 'mcp.servers.agentchat exists but is disabled in openclaw.json — left alone' }
    case 'user_managed':
      return { name: 'mcp', status: 'skipped', detail: 'mcp.servers.agentchat is managed by hand in openclaw.json — left alone' }
  }
}

/**
 * The manual's sync as a placement step. A manual not at the announced
 * version, or someone else's file left alone, is a warning, never a failed
 * setup: the agent works with the file it has (the old one, or the copy
 * bundled with the plugin), and status / doctor keep saying so until a
 * later sync succeeds. Only no manual at all fails.
 */
export function manualStep(outcome: ManualOutcome): PlacementStep {
  const detail = describeManualOutcome(outcome)
  const floor = bundledManual() !== null
  switch (outcome.kind) {
    case 'not-ours':
      return { name: 'manual', status: 'warned', detail }
    case 'failed':
      return { name: 'manual', status: floor ? 'warned' : 'failed', detail }
    case 'floor':
      return { name: 'manual', status: outcome.error !== null ? 'warned' : 'changed', detail }
    case 'synced': {
      const r = outcome.result
      if (r.state === 'failed') return { name: 'manual', status: floor ? 'warned' : 'failed', detail: floor ? `${detail}; the agent reads the copy bundled with the plugin` : detail }
      return { name: 'manual', status: r.upToDate === false ? 'warned' : r.written ? 'changed' : 'ok', detail }
    }
  }
}

/** The manual step when no sync ran: the managed copy as it is (local reads). */
function manualStepAsIs(cfg: object | undefined, accountId: string, stateDir?: string): PlacementStep {
  const { primary } = checkManual({ cfg, served: cachedServedTexts(accountId, stateDir)?.manual ?? null, agentIds: [] })
  return { name: 'manual', status: primary.ok ? (primary.notice ? 'warned' : 'ok') : 'failed', detail: primary.detail }
}

/** One line per step, for the wizard's note and the status pane. */
export function formatPlacement(steps: readonly PlacementStep[]): string[] {
  return steps.map((step) => `${step.status === 'failed' ? '✗' : step.status === 'skipped' || step.status === 'warned' ? '–' : '✓'} ${step.name}: ${step.detail}`)
}

// ─── checks (doctor / status) ──────────────────────────────────────────

export interface PlacementCheck {
  readonly name: 'key' | 'anchor' | 'manual' | 'mcp'
  readonly ok: boolean
  readonly detail: string
  /** Works, but should be fixed: doctor warns and status shows it, without failing the check. */
  readonly notice?: boolean
  /** `openclaw doctor --fix` repairs it. */
  readonly repair?: boolean
  /**
   * About where the key sits on disk (plain text in openclaw.json, a key
   * file others can read, key files no longer used). Status shows it with
   * the rest; doctor reports it as a security warning (`keyAtRestWarnings`),
   * which its read-only runs show too.
   */
  readonly atRest?: boolean
}

export function checkPlacement<TCfg extends object>(params: {
  cfg: TCfg | undefined
  handle: string | undefined
  apiKey: string | undefined
  apiBase: string
  /** The served identity line as last seen (cached); without it any of our blocks naming the handle passes. */
  identityLine?: string | null | undefined
  agentId?: string | undefined
  /** The channel account; a disabled one gets the re-enable remedy, never `channels add`. Defaults to `default`. */
  accountId?: string
  /** Where the key came from (`resolveAgentchatApiKey`): adds the notices about a key in plain text, a loose key file, superseded key files. */
  keySource?: ConfiguredKey
  stateDir?: string
  /** This process's environment (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv
  /** The manual's announcement in hand; defaults to the cached texts. `servedSource`: `server` when this process fetched it. */
  served?: ServedManual | null
  servedSource?: string
  /** Test seam: OpenClaw's config dir (where the managed manual lives). */
  configDir?: string
  /** Test seam: the home whose `~/.agents/skills` is checked. */
  home?: string
  /** The served `identity_line_template` (spelled for OpenClaw); defaults to the cached texts'. */
  identityTemplate?: string | null
}): PlacementCheck[] {
  const checks: PlacementCheck[] = []
  const env = params.env ?? process.env
  const accountId = params.accountId ?? AGENTCHAT_DEFAULT_ACCOUNT_ID
  // While the account is disabled OpenClaw does not load this plugin, and
  // `channels add` would fetch the npm build over it: every remedy for a
  // disabled account is the re-enable route instead.
  const reenable = isAgentchatAccountEnabled(params.cfg as never, accountId) ? undefined : agentchatReenableHint(params.cfg as never, accountId)
  const remedy = (forEnabled: string): string => reenable ?? forEnabled

  checks.push(...checkKey({ ...params, env, accountId, remedy }))
  if (params.handle) {
    checks.push(
      checkAnchor({
        cfg: params.cfg,
        handle: params.handle,
        identityLine: params.identityLine ?? null,
        template: params.identityTemplate !== undefined ? params.identityTemplate : cachedIdentityTemplate(accountId, params.stateDir),
        agentId: params.agentId,
        remedy,
      }),
    )
  } else {
    checks.push({ name: 'anchor', ok: false, detail: `agentHandle not in config — the identity line cannot be checked; ${remedy(`run ${openclawCommand('doctor --fix')} (it learns the handle from the key)`)}` })
  }

  checks.push(...checkManualPlacement({ ...params, accountId, remedy }))

  checks.push(checkMcpEntry(params.cfg, params.apiBase, params.apiKey, remedy))
  return checks
}

/**
 * The identity block, strictly (the kit's `decide` / `owner` on a local
 * read): in place; this agent's but an older text (the gateway brings it to
 * the served one); missing; edited by hand (left, the agent reads those
 * words); another agent's (left — a key mix-up shows here); several blocks.
 */
function checkAnchor(params: {
  cfg: object | undefined
  handle: string
  identityLine: string | null
  template: string | null
  agentId?: string | undefined
  remedy: (forEnabled: string) => string
}): PlacementCheck {
  const bare = params.handle.trim().replace(/^@/, '')
  const seen = inspectAgentsAnchor({ cfg: params.cfg as never, agentId: params.agentId, handle: bare, identityLine: params.identityLine, template: params.template })
  const left = (ok: boolean) => ({ name: 'anchor' as const, ok, ...(ok ? { notice: true } : {}), detail: `${seen.detail} — ${anchorRemedy(seen.outcome, seen.claimed, bare, params.remedy)}` })
  switch (seen.outcome) {
    case 'unchanged':
      return { name: 'anchor', ok: true, detail: `identity line for @${bare} in ${seen.path}` }
    case 'unverified':
      return { name: 'anchor', ok: true, detail: seen.detail }
    case 'updated':
      return {
        name: 'anchor',
        ok: true,
        notice: true,
        repair: true,
        detail: `the identity line for @${bare} in ${seen.path} is this agent's but not the served text — the gateway brings it to the served one when it starts or the texts change; ${params.remedy(`\`${openclawCommand('doctor --fix')}\` does now`)}`,
      }
    case 'absent':
      return {
        name: 'anchor',
        ok: false,
        repair: true,
        detail: `identity line for @${bare} missing from ${seen.path} — ${params.remedy(`run ${openclawCommand('doctor --fix')} (or ${openclawCommand('channels add --channel agentchat')})`)}`,
      }
    case 'hand_edited':
      return left(true)
    case 'other_agent':
    case 'several_blocks':
      return left(false)
    default:
      return { name: 'anchor', ok: false, detail: seen.detail }
  }
}

/**
 * The manual: the managed copy against the announcement (cached texts, or
 * the live copy the caller passes), its size against OpenClaw's skill-file
 * limit, and any `agentchat` skill OpenClaw loads ahead of it. Local reads.
 */
function checkManualPlacement(params: {
  cfg: object | undefined
  accountId: string
  agentId?: string | undefined
  stateDir?: string | undefined
  served?: ServedManual | null | undefined
  servedSource?: string | undefined
  configDir?: string | undefined
  home?: string | undefined
  remedy: (forEnabled: string) => string
}): PlacementCheck[] {
  const served = params.served !== undefined ? params.served : (cachedServedTexts(params.accountId, params.stateDir)?.manual ?? null)
  const { primary, shadows, watch } = checkManual({
    cfg: params.cfg,
    served,
    ...(params.servedSource !== undefined ? { servedSource: params.servedSource } : {}),
    agentIds: [params.agentId ?? resolvePlacementAgentId(params.cfg, params.accountId)],
    latest: latestManualOutcome(),
    remedy: params.remedy,
    ...(params.configDir !== undefined ? { configDir: params.configDir } : {}),
    ...(params.home !== undefined ? { home: params.home } : {}),
  })
  return [
    { name: 'manual', ok: primary.ok, detail: primary.detail, ...(primary.notice ? { notice: true } : {}), ...(primary.repair ? { repair: true } : {}) },
    ...shadows.map((shadow): PlacementCheck => ({ name: 'manual', ok: true, notice: true, detail: shadowLine(shadow) })),
    ...(watch !== null ? [{ name: 'manual', ok: true, notice: true, detail: watch } satisfies PlacementCheck] : []),
  ]
}

/**
 * The key, as this process can see it: the account's key (from its key
 * file), the `AGENTCHAT_API_KEY` this process has (OpenClaw loads the
 * state-dir `.env` into every process, the CLI included, unless the shell
 * already exports the variable) and the `.env` line itself. It cannot see
 * the running gateway's environment, so the wording never claims to; the
 * gateway checks its own at start (`gatewayKeyMismatch`).
 */
function checkKey(params: {
  cfg: object | undefined
  apiBase: string
  apiKey: string | undefined
  keySource?: ConfiguredKey | undefined
  accountId: string
  stateDir?: string | undefined
  env: NodeJS.ProcessEnv
  remedy: (forEnabled: string) => string
}): PlacementCheck[] {
  const { apiKey, keySource, remedy } = params
  const dotenv = dotEnvPath(params.stateDir)
  if (!apiKey) {
    const reason = keySource && !keySource.ok ? keySource.reason : 'no API key is configured'
    return [{ name: 'key', ok: false, detail: `${reason} — ${remedy(`run ${openclawCommand('channels add --channel agentchat')}`)}` }]
  }
  const checks: PlacementCheck[] = []
  const inProcess = readApiKeyVariable(params.env)
  const inDotEnv = readApiKeyFromDotEnv(params.stateDir)
  if (inProcess !== undefined && inProcess !== inDotEnv && toolsUseOtherKey(params.cfg, params.apiBase, apiKey, inProcess)) {
    checks.push({
      name: 'key',
      ok: false,
      detail:
        `${API_KEY_ENV} is exported in this shell and is not the key channels.agentchat is configured with — a gateway started from ` +
        'this shell would run the hosted AgentChat tools in its turns as another agent, and the gateway refuses to start the integration ' +
        `that way: unset ${API_KEY_ENV} (\`unset ${API_KEY_ENV}\`) before starting the gateway`,
    })
  } else if (inDotEnv === undefined) {
    checks.push({ name: 'key', ok: false, repair: true, detail: `${API_KEY_ENV} is not in ${dotenv}, so the hosted tools cannot authenticate — ${remedy(`run ${openclawCommand('doctor --fix')} (it places the account's key there), then restart the gateway (${openclawCommand('gateway restart')})`)}` })
  } else if (inDotEnv !== apiKey) {
    checks.push({
      name: 'key',
      ok: false,
      repair: true,
      detail: `${dotenv} holds another ${API_KEY_ENV} than the account's key, so the hosted tools would act as another agent — ${remedy(`run ${openclawCommand('doctor --fix')} (it places the account's key there), then restart the gateway (${openclawCommand('gateway restart')})`)}`,
    })
  } else {
    checks.push({
      name: 'key',
      ok: true,
      detail:
        `${keySource?.ok && keySource.source === 'file' && keySource.file ? `the key is in ${keySource.file} (owner-only); ` : ''}` +
        `${API_KEY_ENV} in ${dotenv} for the hosted tools; a gateway started before it was placed needs a restart to resolve \${${API_KEY_ENV}}`,
    })
  }
  if (keySource?.ok) {
    if (keySource.source === 'config' && keySource.fileProblem) {
      checks.push({
        name: 'key',
        ok: true,
        notice: true,
        repair: true,
        detail: `channels.agentchat.apiKeyFile (${keySource.file ?? '?'}) cannot be used (${keySource.fileProblem}), so the plain-text channels.agentchat.apiKey in openclaw.json stood in — ${openclawCommand('doctor --fix')} stores the key in a key file again and removes apiKey`,
      })
    }
    checks.push(...keyAtRestChecks(keySource, params.accountId, params.stateDir))
  }
  return checks
}

/** The checks about where an account's key sits on disk (`atRest`), for status and for doctor's security warnings. */
function keyAtRestChecks(keySource: Extract<ConfiguredKey, { ok: true }>, accountId: string, stateDir?: string): PlacementCheck[] {
  const checks: PlacementCheck[] = []
  const atRest = { name: 'key', ok: true, notice: true, atRest: true } as const
  if (keySource.source === 'config' && !keySource.fileProblem) {
    checks.push({
      ...atRest,
      repair: true,
      detail: `the API key is in plain text in openclaw.json (channels.agentchat.apiKey), a file the agent's own file tools can read — ${openclawCommand('doctor --fix')} moves it to an owner-only key file and leaves only its path (channels.agentchat.apiKeyFile)`,
    })
  }
  if (keySource.source === 'file' && keySource.plainTextCopy) {
    checks.push({
      ...atRest,
      repair: true,
      detail: `the key file is in use, and the same key is still in plain text in openclaw.json (channels.agentchat.apiKey) — ${openclawCommand('doctor --fix')} removes it`,
    })
  }
  if (keySource.source === 'file' && keySource.loosePermissions && keySource.file) {
    checks.push({ ...atRest, repair: true, detail: `the key file ${keySource.file} can be read by other users of this machine — ${openclawCommand('doctor --fix')} makes it owner-only (0600)` })
  }
  const superseded = listAccountKeyFiles(accountId, stateDir).filter((file) => file !== keySource.file)
  if (superseded.length > 0) {
    checks.push({
      ...atRest,
      detail:
        `${superseded.length === 1 ? 'a key file' : `${superseded.length} key files`} from an earlier setup ${superseded.length === 1 ? 'is' : 'are'} no longer used by the config: ${superseded.join(', ')} — ` +
        'a key a setup stored that was then replaced (or a setup that was cancelled after the key was issued); delete what you do not need',
    })
  }
  return checks
}

/**
 * Where the account's key sits on disk, as security warnings: the channel's
 * `security.collectWarnings`, which OpenClaw runs in `openclaw doctor`
 * (its Security section), in the read-only doctor (`openclaw doctor
 * --lint`; on 2026.11 also a bare `--json` and answering No to its pause prompt: the
 * `core/doctor/security` check, on by default) and in `openclaw security
 * audit`. Plain text in openclaw.json, the same key left there, a key file
 * others can read, key files no longer used — and, once the key is in a key
 * file, OpenClaw's own config copies that still hold it. Those are named
 * only when nothing in this process is about to rotate them (see
 * `noteKeyMovedOutOfConfig`). Local file reads only; never the key itself.
 */
export function keyAtRestWarnings(cfg: object | undefined, accountId: string, options: { stateDir?: string; configPath?: string } = {}): string[] {
  try {
    if (!isAgentchatAccountEnabled(cfg as never, accountId)) return []
    const keySource = resolveAgentchatApiKey(cfg as never, accountId)
    if (!keySource.ok) return []
    const lines = keyAtRestChecks(keySource, accountId, options.stateDir).map((check) => check.detail)
    if (keySource.source === 'file' && !keyMovedInThisProcess) {
      const copies = describeKeyCopies(openClawCopiesHoldingKey(keySource.apiKey, options.configPath))
      if (copies) lines.push(copies)
    }
    return lines.map((line) => `[${AGENTCHAT_CHANNEL_ID}:${accountId}] key: ${line}`)
  } catch {
    return []
  }
}

/**
 * The tools entry: present and enabled, and naming this client. An entry
 * of ours from an earlier release works but names no client; the gateway
 * adds the header at its next start and `doctor --fix` does now. A hand-written entry that names no client works too, but
 * AgentChat then treats the agent as an unknown client and lists the
 * wake-webhook tools; only the operator can change it, so the line says how.
 */
function checkMcpEntry(cfg: unknown, apiBase: string, apiKey: string | undefined, remedy: (forEnabled: string) => string): PlacementCheck {
  const unknownClient = 'AgentChat treats the agent as an unknown client and lists the webhook-setup tools it does not need'
  switch (describeMcpEntry(cfg, apiBase, apiKey)) {
    case 'ours': {
      const identity = describeMcpIdentity(cfg)
      if (identity === 'current') return { name: 'mcp', ok: true, detail: 'hosted tools registered as mcp.servers.agentchat' }
      return {
        name: 'mcp',
        ok: true,
        notice: true,
        repair: true,
        detail:
          `hosted tools registered as mcp.servers.agentchat, without ${CLIENT_HEADER} — ${unknownClient}; ` +
          `the gateway adds ${clientIdentityText()} to the entry when it starts (its log says if it could not), and ${openclawCommand('doctor --fix')} does now`,
      }
    }
    case 'user_managed': {
      if (describeMcpIdentity(cfg) === 'current') return { name: 'mcp', ok: true, detail: 'mcp.servers.agentchat is managed by hand' }
      const identity = clientIdentityHeaders()
      return {
        name: 'mcp',
        ok: true,
        notice: true,
        detail:
          `mcp.servers.agentchat is managed by hand and does not name this client, so ${unknownClient} — ` +
          `add "${CLIENT_HEADER}": "${identity[CLIENT_HEADER]}" to its headers`,
      }
    }
    case 'disabled':
      return { name: 'mcp', ok: false, detail: 'mcp.servers.agentchat is disabled — the agent has no AgentChat tools' }
    case 'missing':
      return { name: 'mcp', ok: false, repair: true, detail: `mcp.servers.agentchat missing — ${remedy(`run ${openclawCommand('doctor --fix')} (or ${openclawCommand('channels add --channel agentchat')})`)}` }
  }
}

export { agentsAnchorPath }

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
