/**
 * AGENTS.md anchor management — where the identity line goes.
 *
 * Why this file exists
 * ─────────────────────
 * AgentChat asks every runtime to carry one short identity text in the file
 * it loads **every** turn. On OpenClaw that file is the workspace
 * `AGENTS.md`: workspace bootstrap files (AGENTS.md, SOUL.md, USER.md,
 * TOOLS.md, IDENTITY.md, HEARTBEAT.md, MEMORY.md) are loaded into the system
 * prompt on every turn of every session, regardless of which channel
 * triggered the run (docs.openclaw.ai/concepts/system-prompt).
 *
 * The text is served by AgentChat (`GET /v1/texts` → `identity_line`,
 * fetched by `../integration/texts.ts`). It is not ours, and neither is the
 * block's shape: the SDK kit's `anchor` functions render it (the fences, a
 * handle line, the served line), find it (current, legacy and unmarked
 * shapes) and replace or remove it, so re-runs upsert and `channels remove`
 * strips it cleanly. This module only reads and writes the file. No
 * official "plugin → AGENTS.md" API exists.
 *
 * Lifecycle
 * ─────────
 * write   — `setupWizard.finalize` (after validateApiKey ok),
 *           `setup.afterAccountConfigWritten` (non-interactive path),
 *           `lifecycle.onAccountConfigChanged` (disabled → enabled),
 *           `openclaw doctor --fix` when the line for the configured handle
 *           is missing (the re-enable path through `openclaw config set`,
 *           which reaches no plugin hook), and the running gateway when a
 *           fresh server copy of the text differs from the placed one.
 * remove  — `lifecycle.onAccountConfigChanged` (enabled → disabled,
 *           `channels remove agentchat`) and `lifecycle.onAccountRemoved`
 *           (`--delete`).
 * orphan  — `openclaw plugins uninstall` fires no plugin hook today; an
 *           uninstall without `channels remove` leaves the block behind
 *           (documented in RUNBOOK.md).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { integration } from 'agentchatme'

import type { OpenClawConfig } from './openclaw-types.js'
// Path resolution is delegated to the shared OpenClaw layout module (which
// reads the environment through the credential helper). This module
// performs only local filesystem operations against the workspace AGENTS.md
// file and never touches the host environment directly (SECURITY.md).
import { resolveOpenClawWorkspaceDir } from '../openclaw-layout.js'

// Marker fences (the kit's; shared with the universal skill's own placement recipe).
export const ANCHOR_START = integration.anchor.START_MARKER
export const ANCHOR_END = integration.anchor.END_MARKER

/**
 * The workspace OpenClaw loads for the agent this channel wakes — per-agent
 * `agents.entries.<id>.workspace`, then `agents.defaults.workspace`, then
 * `$OPENCLAW_WORKSPACE_DIR`, then `<state dir>/workspace` (state dir =
 * `$OPENCLAW_STATE_DIR`, the profile dir, or `~/.openclaw`). One resolver
 * for every placement (`../openclaw-layout.ts`).
 */
export function resolveWorkspaceDir(cfg: OpenClawConfig | undefined, agentId?: string): string {
  return resolveOpenClawWorkspaceDir(cfg, agentId)
}

export function agentsAnchorPath(cfg: OpenClawConfig | undefined, agentId?: string): string {
  return path.join(resolveWorkspaceDir(cfg, agentId), 'AGENTS.md')
}

function bareHandle(handle: string | undefined): string {
  return integration.anchor.normalizeHandle(handle ?? '')
}

/**
 * Idempotent write of `text` (the served identity line) for `handle`.
 * Re-running upserts the existing block (handle change, text update, an
 * older unmarked or legacy-fenced block) without leaving stale duplicates or
 * blank-line drift. Throws — writing nothing — when the text does not name
 * the handle (a peer would be handed an address that reaches someone else),
 * and when the workspace is not writable; the caller decides whether to
 * surface it.
 */
export function writeAgentsAnchor(params: { cfg: OpenClawConfig | undefined; handle: string; text: string; agentId?: string | undefined }): { path: string } {
  const bare = bareHandle(params.handle)
  if (!bare) throw new Error('writeAgentsAnchor: handle is empty')
  const text = params.text.trim()
  if (!text) throw new Error('writeAgentsAnchor: identity line is empty')

  const workspaceDir = resolveWorkspaceDir(params.cfg, params.agentId)
  const filePath = path.join(workspaceDir, 'AGENTS.md')
  fs.mkdirSync(workspaceDir, { recursive: true })

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
  // The kit renders the block for the handle (it refuses a text that does
  // not name it) and replaces the first block of any known shape.
  const block = integration.anchor.render({ identity_line: text, identity_line_template: '' }, bare)
  const next = integration.anchor.replace(existing, block)
  fs.writeFileSync(filePath, next, 'utf-8')

  const verify = fs.readFileSync(filePath, 'utf-8')
  if (!verify.includes(`@${bare}`)) {
    throw new Error(`writeAgentsAnchor: handle @${bare} did not land in AGENTS.md — remove the agentchat anchor manually and re-run.`)
  }
  return { path: filePath }
}

/** Idempotent remove. Strips our block (and any legacy block); leaves the rest untouched. */
export function removeAgentsAnchor(params: { cfg: OpenClawConfig | undefined; agentId?: string | undefined }): { removed: boolean; path: string } {
  const filePath = agentsAnchorPath(params.cfg, params.agentId)
  if (!fs.existsSync(filePath)) return { removed: false, path: filePath }
  const existing = fs.readFileSync(filePath, 'utf-8')
  const next = integration.anchor.remove(existing)
  if (next === existing) return { removed: false, path: filePath }
  fs.writeFileSync(filePath, next, 'utf-8')
  return { removed: true, path: filePath }
}

/** What the file holds in our block (current or legacy fences), without the handle line, if anything. */
export function readAgentsAnchor(params: { cfg: OpenClawConfig | undefined; agentId?: string | undefined }): { present: boolean; text: string | null; path: string } {
  const filePath = agentsAnchorPath(params.cfg, params.agentId)
  if (!fs.existsSync(filePath)) return { present: false, text: null, path: filePath }
  const found = integration.anchor.find(fs.readFileSync(filePath, 'utf-8'))
  if (!found) return { present: false, text: null, path: filePath }
  return { present: true, text: found.body, path: filePath }
}

/**
 * Doctor check: is an identity line for this handle present? With `text`
 * (the served line) the block must hold exactly that text; without it (the
 * server unreachable and nothing cached) any of our blocks naming the handle
 * counts.
 */
export function hasAgentsAnchorFor(params: { cfg: OpenClawConfig | undefined; handle: string; text?: string | null | undefined; agentId?: string | undefined }): {
  present: boolean
  path: string
} {
  const found = readAgentsAnchor({ cfg: params.cfg, agentId: params.agentId })
  if (!found.present || found.text === null) return { present: false, path: found.path }
  if (typeof params.text === 'string' && params.text.trim().length > 0) {
    return { present: found.text === params.text.trim(), path: found.path }
  }
  return { present: found.text.includes(`@${bareHandle(params.handle)}`), path: found.path }
}
