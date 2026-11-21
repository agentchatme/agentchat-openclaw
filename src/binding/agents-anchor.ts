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
 * block's shape nor the rule for whose block it is: the SDK kit's `anchor`
 * functions render it (the fences, a handle line, the served line), find it
 * (current, legacy and unmarked shapes), decide whose it is (`owner`, strict:
 * a handle line, or a whole text that is exactly a text AgentChat served),
 * and follow it (`follow`: bring this agent's block to the served line,
 * atomically, never touching a block that is not plainly this agent's — one
 * edited by hand, another agent's). This module adds what the kit leaves to
 * the integration: which file, placing a block where there is none, and
 * removing it. No official "plugin → AGENTS.md" API exists.
 *
 * Every write is atomic (the kit's `writeAtomic`: a temp file beside it,
 * flushed, renamed over), through a symlink to the file it points to, with
 * the file's permission bits, and only if the file still holds the bytes
 * the decision was made on (read again right before; an edit saved
 * meanwhile is decided on again). A file that is not UTF-8 is never read
 * or written: decoding it would destroy its bytes. The kit's `replace` and
 * `remove` keep the file's line breaks (a CRLF file stays CRLF), whether it
 * ends with one, and a byte-order mark.
 *
 * Lifecycle
 * ─────────
 * place   — `setupWizard.finalize` (after the key check passed) and
 *           `setup.afterAccountConfigWritten` (non-interactive path): the
 *           operator just named this agent, so a block another agent's
 *           identity line holds is replaced (said so); a block edited by
 *           hand is left. `lifecycle.onAccountConfigChanged` (disabled →
 *           enabled) and `openclaw doctor --fix` (the re-enable path through
 *           `openclaw config set`, which reaches no plugin hook): a missing
 *           block is placed, this agent's is brought to the served line,
 *           anything else is left and reported.
 * follow  — the running gateway on every served copy: `follow` only (never
 *           creates; leaves a hand-edited block and another agent's).
 * remove  — `lifecycle.onAccountConfigChanged` (enabled → disabled,
 *           `channels remove --channel agentchat`) and `lifecycle.onAccountRemoved`
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

/** The kit's `follow` result and outcomes (`integration.anchor` is a value namespace: its types are taken from its functions). */
export type FollowResult = Awaited<ReturnType<typeof integration.anchor.follow>>
export type FollowOutcome = FollowResult['outcome']

/** Decisions in all before a placement or a removal leaves the file for now (as the kit's `follow`). */
const ATTEMPTS = integration.anchor.FOLLOW_ATTEMPTS

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

/** What this agent's identity line is, as served and spelled for OpenClaw. */
export interface AnchorTexts {
  readonly cfg: OpenClawConfig | undefined
  readonly agentId?: string | undefined
  readonly handle: string
  /** The served identity line (spelled for OpenClaw). */
  readonly identityLine: string
  /** The served `identity_line_template` (spelled the same way), when in hand: unmarked blocks are recognised by it. */
  readonly template?: string | null | undefined
}

/**
 * - `placed` — there was no block (or no file): this agent's block is there now.
 * - `replaced_other` — setup only: the block was another agent's; it is this agent's now (the operator named this agent).
 * - the kit's `follow` outcomes: `updated`, `unchanged`, `hand_edited`, `other_agent`, `several_blocks`, `edited_meanwhile`, `failed` (`absent` never: a placement places).
 */
export type AnchorOutcome = Exclude<FollowOutcome, 'absent' | 'setup_offer'> | 'placed' | 'replaced_other'

export interface AnchorResult {
  readonly outcome: AnchorOutcome
  readonly path: string
  /** Whose the block was (`owner`): this agent's, or for `other_agent` / `replaced_other` the other one; null otherwise. */
  readonly claimed: string | null
  /** Display only: for `hand_edited`, the handle its words name, when they do. */
  readonly named: string | null
  /** What happened, naming the path. */
  readonly detail: string
}

/**
 * The running gateway's follow: this agent's block brought to the served
 * line, atomically — the kit's `follow`, which never creates a block and
 * never writes one that is not plainly this agent's. Never throws.
 */
export function followAgentsAnchor(params: AnchorTexts): Promise<FollowResult> {
  return integration.anchor.follow(agentsAnchorPath(params.cfg, params.agentId), {
    handle: params.handle,
    identityLine: params.identityLine,
    template: params.template ?? null,
  })
}

/**
 * Place this agent's identity block: where there is none (or no file), a
 * new one; this agent's own, brought to the served line (`follow`); a block
 * edited by hand, several blocks, a file that keeps changing: left, and said
 * so. Another agent's block is left too, unless `replaceOtherAgent` (setup,
 * where the operator just named this agent: the old block would claim the
 * other identity while the key acts as this one). Never throws.
 */
export async function placeAgentsAnchor(params: AnchorTexts & { readonly replaceOtherAgent?: boolean }): Promise<AnchorResult> {
  const file = agentsAnchorPath(params.cfg, params.agentId)
  const handle = integration.anchor.normalizeHandle(params.handle)
  const result = (outcome: AnchorOutcome, detail: string, claimed: string | null = null, named: string | null = null): AnchorResult => ({ outcome, path: file, claimed, named, detail })
  try {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const followed = await followAgentsAnchor(params)
      if (followed.outcome === 'other_agent' && params.replaceOtherAgent === true) {
        const read = readAnchorFile(file)
        if (!read.exists) continue
        const block = integration.anchor.render({ identity_line: params.identityLine, identity_line_template: '' }, handle)
        const wrote = await writeIfUnchanged(file, read, integration.anchor.replace(read.text, block))
        if (wrote === 'changed') continue
        verifyBlock(file, handle, params.identityLine)
        return result('replaced_other', `replaced @${followed.claimed}'s identity line in ${file} with @${handle}'s`, followed.claimed)
      }
      if (followed.outcome === 'setup_offer') return result('hand_edited', followed.detail)
      if (followed.outcome !== 'absent') return result(followed.outcome, followed.detail, followed.claimed, followed.named)
      // No block, or no file: place one, unless a block appeared meanwhile (then decide again).
      const read = readAnchorFile(file)
      if (read.exists && integration.anchor.find(withoutBom(read.text)) !== null) continue
      const block = integration.anchor.render({ identity_line: params.identityLine, identity_line_template: '' }, handle)
      const wrote = await writeIfUnchanged(file, read, integration.anchor.replace(read.exists ? read.text : '', block))
      if (wrote === 'changed') continue
      verifyBlock(file, handle, params.identityLine)
      return result('placed', `identity line for @${handle} placed in ${file}`, handle)
    }
    return result('edited_meanwhile', `${file} changed while the identity line was being placed (${ATTEMPTS} attempts); left as it is`)
  } catch (err) {
    return result('failed', `could not place the identity line in ${file}: ${describe(err)}`)
  }
}

/**
 * The served block for `handle` in place of whatever block the file holds
 * (or appended): unconditional, atomic. For tests and fixtures; placements
 * go through `placeAgentsAnchor`, the gateway through `followAgentsAnchor`.
 * Throws — writing nothing — when the text does not name the handle, when
 * the file is not UTF-8, and when the workspace is not writable.
 */
export async function writeAgentsAnchor(params: { cfg: OpenClawConfig | undefined; handle: string; text: string; agentId?: string | undefined }): Promise<{ path: string }> {
  const bare = integration.anchor.normalizeHandle(params.handle)
  if (!bare) throw new Error('writeAgentsAnchor: handle is empty')
  const text = params.text.trim()
  if (!text) throw new Error('writeAgentsAnchor: identity line is empty')
  const file = agentsAnchorPath(params.cfg, params.agentId)
  const block = integration.anchor.render({ identity_line: text, identity_line_template: '' }, bare)
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const read = readAnchorFile(file)
    if ((await writeIfUnchanged(file, read, integration.anchor.replace(read.exists ? read.text : '', block))) === 'written') {
      verifyBlock(file, bare, text)
      return { path: file }
    }
  }
  throw new Error(`writeAgentsAnchor: ${file} kept changing (${ATTEMPTS} attempts)`)
}

/** Idempotent remove: every AgentChat block (current or legacy) goes, the rest stays byte for byte. Atomic. */
export async function removeAgentsAnchor(params: { cfg: OpenClawConfig | undefined; agentId?: string | undefined }): Promise<{ removed: boolean; path: string }> {
  const file = agentsAnchorPath(params.cfg, params.agentId)
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const read = readAnchorFile(file)
    if (!read.exists) return { removed: false, path: file }
    const next = integration.anchor.remove(read.text)
    if (next === read.text) return { removed: false, path: file }
    if ((await writeIfUnchanged(file, read, next)) === 'written') return { removed: true, path: file }
  }
  throw new Error(`removeAgentsAnchor: ${file} kept changing (${ATTEMPTS} attempts)`)
}

/** What the file holds in its first block (current or legacy fences), without the handle line — display only. */
export function readAgentsAnchor(params: { cfg: OpenClawConfig | undefined; agentId?: string | undefined }): { present: boolean; text: string | null; path: string } {
  const filePath = agentsAnchorPath(params.cfg, params.agentId)
  let read: ReadAnchorFile
  try {
    read = readAnchorFile(filePath)
  } catch {
    return { present: false, text: null, path: filePath }
  }
  const found = read.exists ? integration.anchor.find(withoutBom(read.text)) : null
  return found ? { present: true, text: found.body, path: filePath } : { present: false, text: null, path: filePath }
}

/**
 * The identity block as status and doctor see it, strictly, from a local
 * read: the kit's `decide` against the served line (`unchanged`: in place;
 * `updated`: this agent's, but an older text or shape the gateway brings to
 * the served one; `absent`; `hand_edited`; `other_agent`; `several_blocks`;
 * `failed`). Without the served line (nothing cached) only whose block it is
 * can be said: `owner`'s reading, `unverified` when it is this agent's.
 * Never throws.
 */
export interface AnchorInspection {
  readonly outcome: Exclude<FollowOutcome, 'edited_meanwhile' | 'setup_offer'> | 'unverified'
  readonly path: string
  readonly claimed: string | null
  readonly named: string | null
  readonly detail: string
}

export function inspectAgentsAnchor(params: Omit<AnchorTexts, 'identityLine'> & { readonly identityLine?: string | null | undefined }): AnchorInspection {
  const file = agentsAnchorPath(params.cfg, params.agentId)
  const handle = integration.anchor.normalizeHandle(params.handle)
  const result = (outcome: AnchorInspection['outcome'], detail: string, claimed: string | null = null, named: string | null = null): AnchorInspection => ({ outcome, path: file, claimed, named, detail })
  let read: ReadAnchorFile
  try {
    read = readAnchorFile(file)
  } catch (err) {
    return result('failed', `could not read ${file}: ${describe(err)}`)
  }
  if (!read.exists) return result('absent', `${file} does not exist`)
  const text = withoutBom(read.text)
  const template = params.template ?? null
  if (typeof params.identityLine === 'string' && params.identityLine.trim().length > 0) {
    const decision = integration.anchor.decide(text, { handle, identityLine: params.identityLine, template })
    const outcome = decision.outcome === 'setup_offer' ? 'hand_edited' : decision.outcome
    return result(outcome, decision.detail.split('the file').join(file), decision.claimed, decision.named)
  }
  const found = integration.anchor.find(text, { template })
  if (found === null) return result('absent', `no AgentChat block in ${file}`)
  if (integration.anchor.find(text.slice(0, found.start) + text.slice(found.end)) !== null) return result('several_blocks', `${file} holds more than one AgentChat block`)
  const claimed = integration.anchor.owner(found, { handle, template })
  if (claimed === handle) return result('unverified', `an identity line for @${handle} in ${file} (not checked against the served text: none in hand)`, claimed)
  if (claimed !== null) return result('other_agent', `the AgentChat block in ${file} is @${claimed}'s, not @${handle}'s`, claimed)
  return result('hand_edited', `the AgentChat block in ${file} has no handle line and is not a text AgentChat served: edited by hand`, null, found.handle)
}

// ─── reading and writing the file ───────────────────────────────────────────

type ReadAnchorFile =
  | { readonly exists: false }
  | { readonly exists: true; readonly target: string; readonly bytes: Uint8Array; readonly text: string; readonly mode: number }

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * The file, read for a decision: through any symlink to the file it points
 * to, its bytes, its permission bits, and its text — strictly UTF-8 (a
 * byte-order mark kept in the text; the kit's `replace` keeps it). Missing:
 * `exists: false`. Throws when it is not a regular file, cannot be read, or
 * is not UTF-8 (rewriting such a file would destroy its bytes).
 */
function readAnchorFile(file: string): ReadAnchorFile {
  let target: string
  try {
    target = fs.realpathSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw err
  }
  const stat = fs.statSync(target)
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`)
  const bytes = new Uint8Array(fs.readFileSync(target))
  let text: string
  try {
    text = UTF8.decode(bytes)
  } catch {
    throw new Error(`${file} is not UTF-8 text; the AgentChat block is not read or written there`)
  }
  return { exists: true, target, bytes, text, mode: stat.mode & 0o7777 }
}

/**
 * Write `next` (the kit's `writeAtomic`) where `read` was read, but only if
 * the file still holds the bytes read (looked at again right before):
 * `changed` otherwise — also when a file appeared where there was none.
 * Keeps the permission bits; through a symlink, the file it points to is
 * the one replaced. A new file is `0644` in a workspace dir made as needed.
 */
async function writeIfUnchanged(file: string, read: ReadAnchorFile, next: string): Promise<'written' | 'changed'> {
  if (!read.exists) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (fs.existsSync(file)) return 'changed'
    await integration.writeAtomic(file, next, { mode: 0o644 })
    return 'written'
  }
  fs.accessSync(read.target, fs.constants.W_OK) // a file the user made read-only is refused, not replaced
  let now: Uint8Array
  try {
    now = new Uint8Array(fs.readFileSync(read.target))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'changed'
    throw err
  }
  if (!sameBytes(now, read.bytes)) return 'changed'
  await integration.writeAtomic(read.target, next, { mode: read.mode })
  return 'written'
}

/** After a write: the file reads back with this agent's block, in the current shape, holding the served line. */
function verifyBlock(file: string, handle: string, identityLine: string): void {
  const read = readAnchorFile(file)
  const found = read.exists ? integration.anchor.find(withoutBom(read.text)) : null
  if (found === null || !found.marked || found.legacy || found.handle !== handle || found.body !== identityLine.replace(/\r\n/g, '\n').trim()) {
    throw new Error(`${file} did not read back with the identity line for @${handle} after the write — remove the AgentChat block by hand and run it again`)
  }
}

function withoutBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
