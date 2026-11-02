/**
 * Where OpenClaw keeps things — resolved the way OpenClaw resolves them.
 *
 * Pure: environment + config + `os.homedir()` in, paths and ids out. No
 * filesystem reads, no network. Every env read goes through
 * `credentials/read-env.ts`. One resolver, shared by the identity-line
 * placement (`binding/agents-anchor.ts`), the key placement
 * (`doorbell/placement.ts`), the gateway and the doctor, so the four never
 * disagree about which workspace or state dir an agent uses.
 *
 * Mirrors OpenClaw 2026.10.9 (`src/agents/workspace-default-path.ts`,
 * `src/agents/agent-roster.ts`, `src/config/paths.ts` in its dist):
 *
 *   state dir     = $OPENCLAW_STATE_DIR
 *                 | ~/.openclaw-<profile>   when OPENCLAW_PROFILE is not "default"
 *                 | ~/.openclaw
 *   workspace     = agents.entries.<id>.workspace (or agents.list[].workspace)
 *                 | agents.defaults.workspace
 *                 | $OPENCLAW_WORKSPACE_DIR
 *                 | <state dir>/workspace
 *   default agent = the one entry marked `default: true` (unless agents.ownership
 *                   is "explicit") | the sole entry | "main" when no roster exists
 */

import * as os from 'node:os'
import * as path from 'node:path'

import {
  readOpenClawProfileFromEnv,
  readOpenClawStateDirFromEnv,
  readOpenClawWorkspaceDirFromEnv,
} from './credentials/read-env.js'

/** OpenClaw's implicit agent id when no roster is configured. */
export const DEFAULT_AGENT_ID = 'main'

/** The loosest config shape these readers need; the real `OpenClawConfig` satisfies it. */
export type OpenClawConfigLike = object | undefined

export interface OpenClawAgentEntry {
  readonly id: string
  readonly default?: boolean
  readonly workspace?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `~` and `~/…` → the home directory; anything else resolved as given. */
export function expandUserPath(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return path.join(os.homedir(), trimmed.slice(2))
  return path.resolve(trimmed)
}

/** OpenClaw's state dir: `$OPENCLAW_STATE_DIR`, else the profile dir, else `~/.openclaw`. */
export function resolveOpenClawStateDir(): string {
  const override = readOpenClawStateDirFromEnv()
  if (override) return expandUserPath(override)
  const profile = readOpenClawProfileFromEnv()
  return path.join(os.homedir(), profile ? `.openclaw-${profile}` : '.openclaw')
}

/** OpenClaw's default agent workspace: `$OPENCLAW_WORKSPACE_DIR`, else `<state dir>/workspace`. */
export function resolveOpenClawDefaultWorkspaceDir(): string {
  const override = readOpenClawWorkspaceDirFromEnv()
  if (override) return path.resolve(override)
  return path.join(resolveOpenClawStateDir(), 'workspace')
}

/** The agent roster from either representation OpenClaw accepts: `agents.entries` (record) or `agents.list` (array). */
export function listOpenClawAgentEntries(cfg: OpenClawConfigLike): OpenClawAgentEntry[] {
  const agents = isRecord(cfg) && isRecord(cfg.agents) ? cfg.agents : undefined
  if (!agents) return []
  if (Object.hasOwn(agents, 'entries') && agents.entries !== undefined) {
    if (!isRecord(agents.entries)) return []
    return Object.entries(agents.entries)
      .filter(([, entry]) => isRecord(entry))
      .map(([id, entry]) => toEntry(id, entry as Record<string, unknown>))
  }
  if (Object.hasOwn(agents, 'list') && agents.list !== undefined) {
    if (!Array.isArray(agents.list)) return []
    return agents.list
      .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.id === 'string')
      .map((entry) => toEntry(entry.id as string, entry))
  }
  return []
}

function toEntry(id: string, raw: Record<string, unknown>): OpenClawAgentEntry {
  return {
    id: id.trim().toLowerCase(),
    ...(raw.default === true ? { default: true } : {}),
    ...(typeof raw.workspace === 'string' && raw.workspace.trim() ? { workspace: raw.workspace } : {}),
  }
}

function hasAgentRoster(cfg: OpenClawConfigLike): boolean {
  const agents = isRecord(cfg) && isRecord(cfg.agents) ? cfg.agents : undefined
  if (!agents) return false
  return (Object.hasOwn(agents, 'entries') && agents.entries !== undefined) || (Object.hasOwn(agents, 'list') && agents.list !== undefined)
}

/**
 * The agent OpenClaw treats as the ambient default — the one `llm.complete`
 * uses when a plugin passes no `agentId`. Mirrors OpenClaw's
 * `tryResolveDefaultAgentId`: one entry marked `default: true` (unless the
 * roster declares `ownership: "explicit"`), else the sole entry, else `main`
 * when no roster exists. `undefined` when several agents exist and none is
 * marked — OpenClaw then has no single default either.
 */
export function resolveOpenClawDefaultAgentId(cfg: OpenClawConfigLike): string | undefined {
  const agents = isRecord(cfg) && isRecord(cfg.agents) ? cfg.agents : undefined
  const entries = listOpenClawAgentEntries(cfg)
  if (agents?.ownership !== 'explicit') {
    const marked = entries.filter((entry) => entry.default === true)
    if (marked.length === 1) return marked[0]!.id
  }
  if (entries.length === 0) return hasAgentRoster(cfg) ? undefined : DEFAULT_AGENT_ID
  return entries.length === 1 ? entries[0]!.id : undefined
}

/**
 * The agent an explicit `bindings[]` entry routes this channel account to,
 * if any. OpenClaw's `AgentBindingMatch`: `accountId` omitted/empty matches
 * only the channel default account, `"*"` matches every account, any other
 * string that account id.
 */
export function resolveBoundAgentId(cfg: OpenClawConfigLike, channel: string, accountId: string, defaultAccountId = 'default'): string | undefined {
  const bindings = isRecord(cfg) ? cfg.bindings : undefined
  if (!Array.isArray(bindings)) return undefined
  let wildcard: string | undefined
  for (const binding of bindings) {
    if (!isRecord(binding) || typeof binding.agentId !== 'string' || !isRecord(binding.match)) continue
    const match = binding.match
    if (match.channel !== channel) continue
    if (match.peer !== undefined && match.peer !== null) continue // peer-specific bindings route single conversations, not the account
    const matchAccount = typeof match.accountId === 'string' ? match.accountId.trim() : ''
    if (matchAccount === accountId) return binding.agentId.trim().toLowerCase()
    if (matchAccount === '' && accountId === defaultAccountId) return binding.agentId.trim().toLowerCase()
    if (matchAccount === '*' && wildcard === undefined) wildcard = binding.agentId.trim().toLowerCase()
  }
  return wildcard
}

/**
 * The workspace OpenClaw loads for `agentId` — the file `AGENTS.md` is read
 * from on every turn. Per-agent `workspace` first, then
 * `agents.defaults.workspace`, then the environment default.
 */
export function resolveOpenClawWorkspaceDir(cfg: OpenClawConfigLike, agentId?: string): string {
  const id = (agentId ?? resolveOpenClawDefaultAgentId(cfg) ?? DEFAULT_AGENT_ID).trim().toLowerCase()
  const entry = listOpenClawAgentEntries(cfg).find((candidate) => candidate.id === id)
  if (entry?.workspace) return expandUserPath(entry.workspace)
  const defaults = isRecord(cfg) && isRecord(cfg.agents) && isRecord(cfg.agents.defaults) ? cfg.agents.defaults : undefined
  const configured = defaults?.workspace
  if (typeof configured === 'string' && configured.trim().length > 0) return expandUserPath(configured)
  return resolveOpenClawDefaultWorkspaceDir()
}
