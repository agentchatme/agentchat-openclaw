/**
 * The manual, as a copy that keeps itself current.
 *
 * AgentChat's manual (`https://agentchat.me/skill.md`) is a server-owned
 * text: the served texts announce it (`GET /v1/texts` → `manual: {url,
 * version, sha256}`). The plugin keeps a copy as the `agentchat` skill in
 * OpenClaw's managed skills directory, `<OpenClaw config dir>/skills/
 * agentchat/SKILL.md`, and brings it to the announced manual whenever the
 * announcement changes. The download, its checks and the write are the SDK
 * kit's (`integration.ManualSync` / `integration.syncManual`): HTTPS with a
 * host pin, each redirect hop checked, a 10 s deadline, a size cap, the
 * front matter naming the skill at the announced version, the announced
 * sha256 of the exact bytes, never worse than before, an atomic write.
 *
 * Why that directory:
 *   - OpenClaw merges skills by name, a later source winning: extraDirs <
 *     plugin skills < bundled < (2026.11: workshop) < managed <
 *     `~/.agents/skills` < `<workspace>/.agents/skills` < `<workspace>/skills`.
 *     The managed copy beats the plugin's own copy with no config edit.
 *   - It is watched (`skills.load.watch`, on by default), copied into Docker
 *     sandboxes with the plugin and bundled skills, and survives a plugin
 *     update (the plugin's install dir is replaced on update).
 *   - A plugin's skills dir must stay inside the plugin root (OpenClaw checks
 *     its realpath), so the plugin's own copy cannot be the one kept current.
 *   - The manual is the same for every account: one copy per OpenClaw state
 *     dir is right.
 *
 * The plugin's own copy (`skills/agentchat/SKILL.md`, declared in
 * `openclaw.plugin.json`) stays declared: the floor that needs no write. Its
 * bytes are the sync's fallback (a first install offline), and a managed
 * copy older than it is replaced by it — when the announcement in hand is a
 * cached one it supersedes, or when the announced manual could not be had —
 * the managed copy shadows the plugin's, so it must never be the older of
 * the two (only the announced manual itself, from the server, may be).
 *
 * Ownership. The file is written only when there is none, when its sha256
 * is the one this plugin recorded for its last write
 * (`<config dir>/agentchat/manual.json`, `ManualRecord`), or when it is an
 * agentchat skill (front matter `name: agentchat`) that is neither a
 * symlink nor managed by ClawHub (`.clawhub/` beside it, or listed in
 * `<config dir>/.clawhub/lock.json`). Anything else is left alone and
 * reported. Cleanup (the last AgentChat account disabled or deleted) removes
 * only a file whose bytes are the recorded ones, or the bundled ones.
 *
 * Paths come from OpenClaw's own `CONFIG_DIR` (`openclaw/plugin-sdk/
 * setup-tools`): `$OPENCLAW_STATE_DIR`, else the directory of
 * `$OPENCLAW_CONFIG_PATH`, else the profile's state dir — exactly where
 * OpenClaw reads managed skills from. It is read at each call (a live
 * binding the gateway re-pins at start), never cached here.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { integration, type Texts } from 'agentchatme'
import { CONFIG_DIR } from 'openclaw/plugin-sdk/setup-tools'

import { openclawCommand } from '../cli-command.js'
import { readOpenClawProfileFromEnv, readOpenClawStateDirFromEnv } from '../credentials/read-env.js'
import { expandUserPath, resolveOpenClawWorkspaceDir } from '../openclaw-layout.js'
import { getPluginRuntime } from './runtime-holder.js'
import { PLUGIN_STATE_DIRNAME } from './state.js'

export const MANUAL_SKILL = integration.MANUAL_SKILL_NAME
export const MANUAL_FILE = 'SKILL.md'
export const MANUAL_RECORD_FILE = 'manual.json'
/** OpenClaw's default `skills.limits.maxSkillFileBytes`: a larger SKILL.md is skipped (2026.6.10 and 2026.11.6 alike). */
export const OPENCLAW_DEFAULT_MAX_SKILL_FILE_BYTES = 256_000

const RECORD_VERSION = 1
/** Front matter lives in the first lines; a shadow scan reads no more of a file than this. */
const FRONT_MATTER_READ_BYTES = 8 * 1024
/** A shadow scan looks at no more child directories of one skills root than this. */
const SHADOW_SCAN_MAX_DIRS = 512
/**
 * How often the running gateway looks at the managed file itself: a local
 * read and hash, no network. The kit's `ManualSync` syncs on a texts change
 * and retries a failed sync, but sees nothing a person or another tool does
 * to the file (a ClawHub copy put there, one removed again, an old copy
 * written over it). A periodic local re-check is planned in the SDK kit;
 * when it lands there, this timer goes.
 */
export const MANUAL_CHECK_MS = 10 * 60_000
/** A managed file larger than this is not read whole (only its front matter): it is not a manual this plugin wrote. */
const INSPECT_MAX_BYTES = 4 * integration.MANUAL_MAX_BYTES

// ─── where things are ───────────────────────────────────────────────────────

/** OpenClaw's config dir, as OpenClaw resolves it (read live). */
export function openclawConfigDir(): string {
  return CONFIG_DIR
}

/** `<config dir>/skills/agentchat`. */
export function managedManualDir(configDir: string = openclawConfigDir()): string {
  return path.join(configDir, 'skills', MANUAL_SKILL)
}

/** `<config dir>/skills/agentchat/SKILL.md` — the copy this plugin keeps current. */
export function managedManualPath(configDir: string = openclawConfigDir()): string {
  return path.join(managedManualDir(configDir), MANUAL_FILE)
}

/** `<config dir>/agentchat/manual.json` — what this plugin last wrote there. Account-free, next to the account dirs. */
export function manualRecordPath(configDir: string = openclawConfigDir()): string {
  // OpenClaw account ids are [a-z0-9_-]: no account dir can be named `manual.json`.
  return path.join(configDir, PLUGIN_STATE_DIRNAME, MANUAL_RECORD_FILE)
}

// ─── the plugin's own copy ──────────────────────────────────────────────────

export interface BundledManual {
  readonly path: string
  readonly bytes: Uint8Array
  readonly version: string | null
  readonly sha256: string
}

let bundledCache: BundledManual | null | undefined

/**
 * The copy bundled with the plugin (`<package>/skills/agentchat/SKILL.md`),
 * found from this module's own location (`dist/` in a build, `src/
 * integration/` in a checkout). Null when it cannot be read.
 */
export function bundledManual(): BundledManual | null {
  if (bundledCache !== undefined) return bundledCache
  bundledCache = null
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let up = 0; up < 5; up++) {
    const candidate = path.join(dir, 'skills', MANUAL_SKILL, MANUAL_FILE)
    if (fs.existsSync(path.join(dir, 'openclaw.plugin.json')) && fs.existsSync(candidate)) {
      try {
        const bytes = new Uint8Array(fs.readFileSync(candidate))
        bundledCache = { path: candidate, bytes, version: integration.manualVersion(decode(bytes)), sha256: sha256(bytes) }
      } catch {
        bundledCache = null
      }
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return bundledCache
}

/** Test seam: forget the bundled copy (or pin one). */
export function setBundledManualForTest(manual: BundledManual | null | undefined): void {
  bundledCache = manual
}

// ─── the size OpenClaw loads ────────────────────────────────────────────────

/** OpenClaw's skill-file size limit for this config: `skills.limits.maxSkillFileBytes`, else 256 000 bytes. */
export function skillFileCap(cfg: unknown): number {
  const limits = (cfg as { skills?: { limits?: { maxSkillFileBytes?: unknown } } } | undefined)?.skills?.limits
  const value = limits?.maxSkillFileBytes
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : OPENCLAW_DEFAULT_MAX_SKILL_FILE_BYTES
}

/** The download cap: what OpenClaw would load, and never past the kit's own cap. */
export function manualMaxBytes(cfg: unknown): number {
  return Math.min(integration.MANUAL_MAX_BYTES, skillFileCap(cfg))
}

// ─── the record ─────────────────────────────────────────────────────────────

export type ManualLastState = integration.ManualSyncState | 'not-ours'

export interface ManualRecord {
  readonly version: typeof RECORD_VERSION
  /** The skill file the record is about. */
  readonly file: string
  /** What this plugin last wrote there: the sha256 of the exact bytes on disk after the write, and their version. */
  readonly written: { readonly sha256: string; readonly manual: string | null; readonly at: string } | null
  /** The latest sync, for `doctor` in another process: its state, the versions, why the announced one is not on disk. */
  readonly last: {
    readonly at: string
    readonly state: ManualLastState
    readonly manual: string | null
    readonly served: string | null
    readonly error: string | null
  } | null
  /** The gateway process keeping the copy: when it started (OpenClaw's skill view with `skills.load.watch: false` is from then). */
  readonly gateway?: { readonly started_at: string; readonly pid: number } | null
}

export function readManualRecord(configDir: string = openclawConfigDir()): ManualRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(manualRecordPath(configDir), 'utf8')) as Record<string, unknown>
    if (raw.version !== RECORD_VERSION || typeof raw.file !== 'string') return null
    const written = raw.written as Record<string, unknown> | null | undefined
    const last = raw.last as Record<string, unknown> | null | undefined
    const gateway = raw.gateway as Record<string, unknown> | null | undefined
    return {
      version: RECORD_VERSION,
      file: raw.file,
      written:
        written && typeof written.sha256 === 'string' && typeof written.at === 'string'
          ? { sha256: written.sha256, manual: typeof written.manual === 'string' ? written.manual : null, at: written.at }
          : null,
      last:
        last && typeof last.state === 'string' && typeof last.at === 'string'
          ? {
              at: last.at,
              state: last.state as ManualLastState,
              manual: typeof last.manual === 'string' ? last.manual : null,
              served: typeof last.served === 'string' ? last.served : null,
              error: typeof last.error === 'string' ? last.error : null,
            }
          : null,
      gateway: gateway && typeof gateway.started_at === 'string' && typeof gateway.pid === 'number' ? { started_at: gateway.started_at, pid: gateway.pid } : null,
    }
  } catch {
    return null
  }
}

function writeManualRecord(record: ManualRecord, configDir: string): void {
  // The gateway's start is kept across every writer (a CLI `doctor --fix` writes the record too).
  const gateway = record.gateway !== undefined ? record.gateway : (readManualRecord(configDir)?.gateway ?? null)
  writeFileAtomicSync(manualRecordPath(configDir), `${JSON.stringify({ ...record, gateway }, null, 2)}\n`, 0o600)
}

/** The gateway that runs the keeper says when it started. Never throws. */
function noteGatewayStart(configDir: string, file: string): void {
  const previous = readManualRecord(configDir)
  const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString()
  try {
    writeManualRecord(
      { version: RECORD_VERSION, file, written: previous?.file === file ? previous.written : null, last: previous?.file === file ? previous.last : null, gateway: { started_at: startedAt, pid: process.pid } },
      configDir,
    )
  } catch {
    // a diagnostic only
  }
}

function removeManualRecord(configDir: string): boolean {
  try {
    fs.unlinkSync(manualRecordPath(configDir))
    return true
  } catch {
    return false
  }
}

// ─── who the file belongs to ────────────────────────────────────────────────

export type ManualOwner =
  /** No file: free to place. */
  | { readonly kind: 'absent' }
  /** Its bytes are the ones this plugin recorded for its last write. */
  | { readonly kind: 'ours' }
  /** An agentchat skill this plugin did not write (an earlier copy, a hand-placed one), not ClawHub's, not a symlink: kept current too. */
  | { readonly kind: 'agentchat' }
  /** Someone else's: left alone. `wins`: OpenClaw loads it as the agentchat skill (ahead of the plugin's copy). */
  | { readonly kind: 'not-ours'; readonly reason: string; readonly wins: boolean }

export interface ManagedManual {
  readonly path: string
  readonly owner: ManualOwner
  /** The file's size in bytes; 0 when there is none. */
  readonly size: number
  /** The file's bytes, when it is a regular file that could be read (and is not larger than any manual). */
  readonly bytes: Uint8Array | null
  readonly version: string | null
  readonly sha256: string | null
}

/** Whether the file may be written (placed, updated). */
export function isWritable(owner: ManualOwner): boolean {
  return owner.kind !== 'not-ours'
}

/** What is at the managed path, and whose it is. Local reads only; never throws. */
export function inspectManagedManual(configDir: string = openclawConfigDir()): ManagedManual {
  const dir = managedManualDir(configDir)
  const file = managedManualPath(configDir)
  const none = (owner: ManualOwner): ManagedManual => ({ path: file, owner, size: 0, bytes: null, version: null, sha256: null })
  let dirStat: fs.Stats
  try {
    dirStat = fs.lstatSync(dir)
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return none({ kind: 'absent' })
    return none({ kind: 'not-ours', reason: `${dir} cannot be read (${describe(err)})`, wins: false })
  }
  if (dirStat.isSymbolicLink()) return none({ kind: 'not-ours', reason: `${dir} is a symlink (a copy kept by hand)`, wins: true })
  if (!dirStat.isDirectory()) return none({ kind: 'not-ours', reason: `${dir} is not a directory`, wins: false })
  const clawhubFolder = clawhubFolderMarker(configDir)
  let fileStat: fs.Stats
  try {
    fileStat = fs.lstatSync(file)
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') return none({ kind: 'not-ours', reason: `${file} cannot be read (${describe(err)})`, wins: false })
    // A folder with no SKILL.md that ClawHub claims: an install in progress, or one being updated.
    const claimed = clawhubFolder ?? clawhubLockEntry(configDir)
    return none(claimed ? { kind: 'not-ours', reason: claimed, wins: false } : { kind: 'absent' })
  }
  if (fileStat.isSymbolicLink()) return none({ kind: 'not-ours', reason: `${file} is a symlink (a copy kept by hand)`, wins: true })
  if (!fileStat.isFile()) return none({ kind: 'not-ours', reason: `${file} is not a regular file`, wins: false })
  let bytes: Uint8Array | null = null
  let text: string
  if (fileStat.size > INSPECT_MAX_BYTES) {
    // Far past any manual: only its front matter says whose it is (an agentchat one is replaced by the sync).
    const head = readHead(file)
    if (head === null) return none({ kind: 'not-ours', reason: `${file} cannot be read`, wins: false })
    text = head
  } else {
    try {
      bytes = new Uint8Array(fs.readFileSync(file))
    } catch (err) {
      return none({ kind: 'not-ours', reason: `${file} cannot be read (${describe(err)})`, wins: false })
    }
    text = decode(bytes)
  }
  const version = integration.manualVersion(text)
  const digest = bytes === null ? null : sha256(bytes)
  const found = (owner: ManualOwner): ManagedManual => ({ path: file, owner, size: fileStat.size, bytes, version, sha256: digest })
  const fields = integration.manualFrontMatter(text)
  const named = fields?.get('name') === MANUAL_SKILL
  // ClawHub's own metadata in the folder: its install, whatever the bytes.
  if (clawhubFolder) return found({ kind: 'not-ours', reason: clawhubFolder, wins: named })
  // The bytes this plugin recorded, or the bytes it ships (a write whose record was lost: an aborted sync's
  // fallback, a record another process overwrote) — ours, even if a stale ClawHub lock entry names the skill.
  const record = readManualRecord(configDir)
  if (digest !== null && ((record?.written && record.file === file && record.written.sha256 === digest) || digest === bundledManual()?.sha256)) {
    return found({ kind: 'ours' })
  }
  const clawhubLock = clawhubLockEntry(configDir)
  if (clawhubLock) return found({ kind: 'not-ours', reason: clawhubLock, wins: named })
  if (named) return found({ kind: 'agentchat' })
  return found({
    kind: 'not-ours',
    reason: fields === null ? `${file} has no front matter — not the ${MANUAL_SKILL} skill` : `${file} is the skill "${fields.get('name') ?? ''}", not ${MANUAL_SKILL}`,
    wins: false,
  })
}

/** ClawHub's metadata folder inside the managed `agentchat` skill (`openclaw skills install --global`), as a reason, or null. */
function clawhubFolderMarker(configDir: string): string | null {
  const dir = managedManualDir(configDir)
  for (const meta of ['.clawhub', '.clawdhub']) {
    if (fs.existsSync(path.join(dir, meta))) return `${dir} was installed from ClawHub (${meta}/ beside it), so \`${openclawCommand('skills update')}\` manages it`
  }
  return null
}

/** The managed dir's ClawHub lock file listing `agentchat`, as a reason, or null. */
function clawhubLockEntry(configDir: string): string | null {
  const dir = managedManualDir(configDir)
  for (const meta of ['.clawhub', '.clawdhub']) {
    const lock = path.join(configDir, meta, 'lock.json')
    try {
      const parsed = JSON.parse(fs.readFileSync(lock, 'utf8')) as { skills?: unknown }
      const skills = parsed.skills
      if (skills && typeof skills === 'object' && Object.hasOwn(skills, MANUAL_SKILL)) {
        return `${dir} is listed in ${lock} (installed from ClawHub), so \`${openclawCommand('skills update')}\` manages it`
      }
    } catch {
      // no lock file, or not one we can read: nothing says ClawHub manages it
    }
  }
  return null
}

// ─── versions ───────────────────────────────────────────────────────────────

/** Compare dotted numeric versions (`2.4.2`); null when either is not one. */
export function compareManualVersions(a: string | null, b: string | null): number | null {
  if (a === null || b === null) return null
  const pa = /^\d+(?:\.\d+)*$/.test(a) ? a.split('.').map(Number) : null
  const pb = /^\d+(?:\.\d+)*$/.test(b) ? b.split('.').map(Number) : null
  if (pa === null || pb === null) return null
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * An announcement the bundled copy supersedes: newer bundled bytes, and the
 * announcement is not the server's word in this process (a cached copy from
 * before an upgrade). Acting on it would put an older manual over the
 * bundled one.
 */
export function supersededByBundle(served: integration.ServedManual | null, source: string, bundled: BundledManual | null = bundledManual()): boolean {
  if (served === null || bundled === null || source === 'server') return false
  return (compareManualVersions(bundled.version, served.version) ?? 0) > 0
}

// ─── one sync (setup paths: the wizard, `channels add`, re-enable, `doctor --fix`) ─

export type ManualOutcome =
  /** The kit's sync ran. */
  | { readonly kind: 'synced'; readonly result: integration.ManualSyncResult }
  /**
   * The bundled copy replaced an older copy: no usable announcement in hand
   * (`error` null; `served` the cached announcement it supersedes), or the
   * announced manual could not be had (`error` why; `served` its version).
   */
  | {
      readonly kind: 'floor'
      readonly path: string
      readonly version: string | null
      readonly previous: string | null
      readonly served: string | null
      readonly error: string | null
    }
  /** Someone else's file: left alone. */
  | { readonly kind: 'not-ours'; readonly path: string; readonly reason: string; readonly wins: boolean }
  /** The floor could not be written. */
  | { readonly kind: 'failed'; readonly path: string; readonly error: string }

export interface PlaceManualParams {
  /** The texts in hand (server-verbatim), or null. */
  readonly texts: Texts | null
  /** Where they came from: `server` (this process), `cache` (the file), `none`. */
  readonly source: string
  /** The API base the texts were fetched from: where a download may go. */
  readonly apiBase: string | null
  /** OpenClaw's config, for `skills.limits.maxSkillFileBytes`. */
  readonly cfg?: unknown
  readonly configDir?: string
  readonly fetch?: integration.ManualFetch
  readonly timeoutMs?: number
}

let defaultFetch: integration.ManualFetch | undefined

/** Test seam: the fetch every sync uses when none is passed (no test may reach agentchat.me). */
export function setManualFetchForTest(fetch: integration.ManualFetch | undefined): void {
  defaultFetch = fetch
}

/**
 * Bring the managed copy to the announced manual once, and record it. Never
 * throws. Someone else's file is left alone (`not-ours`).
 */
export async function placeManual(params: PlaceManualParams): Promise<ManualOutcome> {
  const configDir = params.configDir ?? openclawConfigDir()
  const file = managedManualPath(configDir)
  const bundled = bundledManual()
  const current = inspectManagedManual(configDir)
  if (!isWritable(current.owner)) {
    const owner = current.owner as Extract<ManualOwner, { kind: 'not-ours' }>
    noteLast(configDir, file, { state: 'not-ours', manual: current.version, served: params.texts?.manual.version ?? null, error: owner.reason })
    return { kind: 'not-ours', path: file, reason: owner.reason, wins: owner.wins }
  }
  const served = params.texts?.manual ?? null
  const usable = supersededByBundle(served, params.source, bundled) ? null : served
  const floor = placeFloor(current, usable, usable === null ? served : null, bundled, configDir)
  if (floor !== null) return floor
  ensureSkillDir(configDir)
  const result = await integration.syncManual({
    path: file,
    served: usable,
    apiBase: params.apiBase,
    fallback: bundled?.bytes ?? null,
    maxBytes: manualMaxBytes(params.cfg),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.fetch ?? defaultFetch ? { fetch: (params.fetch ?? defaultFetch)! } : {}),
  })
  recordResult(result, configDir, usable)
  return floorAfterStale(result, bundled, configDir) ?? { kind: 'synced', result }
}

/**
 * The bundled copy over an older copy of ours when no fresh announcement says
 * otherwise; null when nothing was done (the kit's sync decides). A missing
 * file is the kit's to fill (its fallback).
 */
function placeFloor(
  current: ManagedManual,
  usable: integration.ServedManual | null,
  superseded: integration.ServedManual | null,
  bundled: BundledManual | null,
  configDir: string,
): ManualOutcome | null {
  // An announcement in hand (the server's, or a cached one the bundle does not supersede): the kit brings the file to it.
  if (usable !== null) return null
  return writeFloor(current, bundled, configDir, { served: superseded?.version ?? null, error: null })
}

/**
 * After a sync that left the file short of the announced manual (offline,
 * a failed check, a host the download may not use): never older than the
 * bundled copy. The next sync that can have the announced manual replaces
 * it, so there is no back and forth.
 */
function floorAfterStale(result: integration.ManualSyncResult, bundled: BundledManual | null, configDir: string): ManualOutcome | null {
  if (result.upToDate !== false) return null
  return writeFloor(inspectManagedManual(configDir), bundled, configDir, { served: result.served, error: result.error })
}

/** The bundled copy over `current` when it is writable, present and older (an unversioned agentchat file counts as older; a version that is not dotted numbers does not). */
function writeFloor(
  current: ManagedManual,
  bundled: BundledManual | null,
  configDir: string,
  why: { readonly served: string | null; readonly error: string | null },
): ManualOutcome | null {
  if (bundled === null || !isWritable(current.owner) || current.owner.kind === 'absent' || current.bytes === null) return null
  if (current.version !== null && (compareManualVersions(bundled.version, current.version) ?? 0) <= 0) return null
  if (current.sha256 === bundled.sha256) return null
  try {
    ensureSkillDir(configDir)
    writeFileAtomicSync(current.path, bundled.bytes, 0o644)
  } catch (err) {
    return { kind: 'failed', path: current.path, error: `could not write ${current.path}: ${describe(err)}` }
  }
  recordWritten(current.path, configDir, { state: why.error === null ? 'updated' : 'fallback', manual: bundled.version, served: why.served, error: why.error })
  return { kind: 'floor', path: current.path, version: bundled.version, previous: current.version, served: why.served, error: why.error }
}

/**
 * The skill dir, readable by others (0755 before the umask). The kit would
 * create a missing one 0700, and OpenClaw keeps a directory's mode when it
 * copies skills into a Docker sandbox, where the agent may run as another
 * user.
 */
function ensureSkillDir(configDir: string): void {
  try {
    fs.mkdirSync(managedManualDir(configDir), { recursive: true, mode: 0o755 })
  } catch {
    // the write reports it
  }
}

// ─── recording ──────────────────────────────────────────────────────────────

/**
 * Record a kit result: the bytes on disk when it wrote, and the latest
 * state. `announced` is the announcement the sync ran against. Never throws.
 */
export function recordResult(result: integration.ManualSyncResult, configDir: string = openclawConfigDir(), announced: integration.ServedManual | null = null): void {
  const last = { state: result.state, manual: result.version, served: result.served, error: result.upToDate === true ? null : result.error }
  if (result.written) {
    recordWritten(result.path, configDir, last)
    return
  }
  // Ours, but not under the recorded sha: the bundled bytes, or the announced
  // bytes (by their sha256) at a path this plugin wrote before — a write
  // whose record was lost, or a copy another process (the gateway,
  // `doctor --fix`) wrote at the same time. Recorded again.
  if (result.state === 'current') {
    const record = readManualRecord(configDir)
    const bytes = readFileOrNull(result.path)
    if (bytes !== null) {
      const digest = sha256(bytes)
      const recorded = record?.file === result.path ? record.written?.sha256 : undefined
      const announcedBytes = announced !== null && recorded !== undefined && announcedSha(announced) === digest
      if (digest !== recorded && (digest === bundledManual()?.sha256 || announcedBytes)) {
        recordWritten(result.path, configDir, last)
        return
      }
    }
  }
  noteLast(configDir, result.path, last)
}

function recordWritten(file: string, configDir: string, last: Omit<NonNullable<ManualRecord['last']>, 'at'>): void {
  const bytes = readFileOrNull(file)
  const at = new Date().toISOString()
  const record: ManualRecord = {
    version: RECORD_VERSION,
    file,
    written: bytes === null ? null : { sha256: sha256(bytes), manual: integration.manualVersion(decode(bytes)), at },
    last: { at, ...last },
  }
  try {
    writeManualRecord(record, configDir)
  } catch {
    // Without the record the file still counts as an agentchat skill (kept current), but cleanup will leave it.
  }
}

function noteLast(configDir: string, file: string, last: Omit<NonNullable<ManualRecord['last']>, 'at'>): void {
  const previous = readManualRecord(configDir)
  const record: ManualRecord = {
    version: RECORD_VERSION,
    file,
    written: previous?.file === file ? previous.written : null,
    last: { at: new Date().toISOString(), ...last },
  }
  try {
    writeManualRecord(record, configDir)
  } catch {
    // best effort: the record is a diagnostic
  }
}

// ─── the gateway: one ManualSync for the process ────────────────────────────

export interface ManualLog {
  info(line: string): void
  warn(line: string): void
  debug?(line: string): void
}

export interface ManualKeeperOptions {
  /** The account's texts cache: where the announcement comes from, and its API base pins the download. */
  readonly cache: integration.TextsCache
  readonly cfg?: unknown
  readonly log?: ManualLog
  readonly configDir?: string
  readonly fetch?: integration.ManualFetch
}

/**
 * The kit's `ManualSync` on the managed copy, behind the ownership guard:
 * the texts it reads are withheld while the file is someone else's, and an
 * announcement the bundled copy supersedes is not acted on. Results are
 * recorded and logged (failures once per condition).
 */
export class ManualKeeper {
  private readonly options: ManualKeeperOptions
  private readonly configDir: string
  private readonly file: string
  private sync: integration.ManualSync | null = null
  private notOurs: { readonly reason: string; readonly wins: boolean } | null = null
  private floor: ManualOutcome | null = null
  private stopped = false
  private checkTimer: ReturnType<typeof setInterval> | null = null
  private checking: Promise<void> | null = null
  /** The managed file as the last look saw it (`fingerprint`). */
  private lastSeen: string | null = null

  constructor(options: ManualKeeperOptions) {
    this.options = options
    this.configDir = options.configDir ?? openclawConfigDir()
    this.file = managedManualPath(this.configDir)
  }

  /** The latest outcome, for status. */
  get latest(): ManualOutcome | null {
    if (this.notOurs !== null) return { kind: 'not-ours', path: this.file, reason: this.notOurs.reason, wins: this.notOurs.wins }
    const result = this.sync?.result ?? null
    if (result !== null) return { kind: 'synced', result }
    return this.floor
  }

  /** The floor when no announcement is in hand, then the kit's sync. Resolves with the first outcome. */
  async start(): Promise<ManualOutcome | null> {
    if (this.stopped || this.sync !== null) return this.latest
    const cache = this.options.cache
    noteGatewayStart(this.configDir, this.file)
    const bundled = bundledManual()
    if (this.writable()) await this.placeFloorIfDue()
    if (this.stopped) return this.latest
    // The texts the kit reads: withheld while the file is someone else's, or
    // while the announcement is a cached one the bundled copy supersedes. The
    // check runs at each sync the kit starts (a texts change, a retry).
    const gated = keeperTextsView(cache, (texts, source) => {
      if (supersededByBundle(texts.manual, source) || !this.writable()) return false
      ensureSkillDir(this.configDir)
      return true
    })
    this.sync = new integration.ManualSync({
      texts: gated,
      targetPath: this.file,
      fallback: bundled?.bytes ?? null,
      maxBytes: manualMaxBytes(this.options.cfg),
      ...(this.options.fetch ?? defaultFetch ? { fetch: (this.options.fetch ?? defaultFetch)! } : {}),
      // Called inside the kit's serialised chain: a floor written here cannot interleave with its next sync.
      onResult: (result) => {
        recordResult(result, this.configDir, cache.current()?.manual ?? null)
        const floor = floorAfterStale(result, bundledManual(), this.configDir)
        if (floor !== null) this.floor = floor
        this.report(floor ?? { kind: 'synced', result })
      },
    })
    const first = await this.sync.start()
    this.startChecks()
    return first !== null ? { kind: 'synced', result: first } : this.latest
  }

  /**
   * The bundled copy when no usable announcement is in hand: where there is
   * no file (the kit's fallback), or over an older copy of ours.
   */
  private async placeFloorIfDue(): Promise<void> {
    const cache = this.options.cache
    const bundled = bundledManual()
    const served = cache.current()?.manual ?? null
    const usable = supersededByBundle(served, cache.source, bundled) ? null : served
    const current = inspectManagedManual(this.configDir)
    if (usable === null && current.owner.kind === 'absent' && bundled !== null && !this.stopped) {
      // Nothing announced in hand (offline, nothing cached, or a cached announcement older than the bundle): the bundled copy, through the kit (its fallback).
      ensureSkillDir(this.configDir)
      const result = await integration.syncManual({ path: this.file, served: null, apiBase: cache.apiBase, fallback: bundled.bytes })
      recordResult(result, this.configDir)
      this.floor = { kind: 'synced', result }
      this.report(this.floor)
      return
    }
    const floor = placeFloor(current, usable, usable === null ? served : null, bundled, this.configDir)
    if (floor !== null) {
      this.floor = floor
      this.report(floor)
    }
  }

  /** The managed file in one string: whose it is and its bytes' sha256 (`absent`). A local read and hash. */
  private fingerprint(): string {
    const found = inspectManagedManual(this.configDir)
    return found.owner.kind === 'not-ours' ? `not-ours:${found.owner.reason}:${found.sha256 ?? ''}` : `${found.owner.kind}:${found.sha256 ?? ''}`
  }

  private startChecks(): void {
    if (this.checkTimer !== null || this.stopped) return
    this.lastSeen = this.fingerprint()
    this.checkTimer = setInterval(() => void this.check(), MANUAL_CHECK_MS)
    ;(this.checkTimer as { unref?: () => void }).unref?.()
  }

  /**
   * The timer's look at the file (also callable at once). When the file
   * changed since the last look — someone else's now (said once), free
   * again, replaced, removed — the kit syncs it against the texts in hand
   * (or the bundled copy goes where there is none and nothing is
   * announced). Unchanged, nothing happens: a stale file that stays as it
   * was is the kit's retry's, on its own backoff, so this never adds a
   * download. One at a time: a call while one runs joins it.
   */
  check(): Promise<void> {
    if (this.checking !== null) return this.checking
    // Cleared once settled, and only if it is still this look (a look that
    // finishes without awaiting must not clear itself before it is stored).
    const look: Promise<void> = this.look().finally(() => {
      if (this.checking === look) this.checking = null
    })
    this.checking = look
    return look
  }

  private async look(): Promise<void> {
    try {
      if (this.stopped || this.sync === null) return
      const now = this.fingerprint()
      if (now === this.lastSeen) return
      this.lastSeen = now
      if (!this.writable()) return
      const result = await this.sync.sync()
      if (result === null && !this.stopped) await this.placeFloorIfDue()
      this.lastSeen = this.fingerprint()
    } catch {
      // a look that fails is tried again at the next tick
    }
  }

  stop(): void {
    this.stopped = true
    if (this.checkTimer !== null) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
    this.sync?.stop()
  }

  /** The ownership guard, with one log line per new reason. */
  private writable(): boolean {
    const owner = inspectManagedManual(this.configDir).owner
    if (owner.kind !== 'not-ours') {
      if (this.notOurs !== null) this.options.log?.info(`[agentchat] manual: ${this.file} is free again — keeping it current`)
      this.notOurs = null
      return true
    }
    if (owner.reason !== this.notOurs?.reason) {
      this.notOurs = { reason: owner.reason, wins: owner.wins }
      noteLast(this.configDir, this.file, { state: 'not-ours', manual: null, served: this.options.cache.current()?.manual.version ?? null, error: owner.reason })
      this.options.log?.warn(`[agentchat] manual: ${notOursLine(owner.reason, owner.wins)}`)
    }
    return false
  }

  private report(outcome: ManualOutcome): void {
    const log = this.options.log
    if (!log) return
    const line = `[agentchat] manual: ${describeManualOutcome(outcome)}`
    if (outcome.kind === 'synced') {
      const r = outcome.result
      if (r.state === 'current') log.debug?.(line)
      else if (r.upToDate === false || r.state === 'failed') log.warn(line)
      else log.info(line)
    } else if (outcome.kind === 'failed' || outcome.kind === 'not-ours' || (outcome.kind === 'floor' && outcome.error !== null)) {
      log.warn(line)
    } else {
      log.info(line)
    }
  }
}

/** What the keeper hands the kit's `ManualSync` as its texts source. */
export type ManualTextsView = Pick<integration.TextsCache, 'current' | 'onChange' | 'apiBase' | 'refresh' | 'lastError'>

/**
 * The texts cache as the kit's `ManualSync` sees it through the keeper:
 * `current()` and the change events are withheld while `usable` says no
 * (someone else's file; a cached announcement the bundled copy supersedes),
 * and nothing else is changed. `refresh()` and `lastError` are the cache's
 * own, passed through: the kit refreshes the texts before each retry, and at
 * once after a download that is another manual, but only on a source that
 * has `refresh()`, and never while `lastError` says the cache is failing
 * (its own timer retries then). This view never fetches by itself: one
 * fetch per kit refresh, coalesced by the cache with any in flight.
 */
export function keeperTextsView(cache: integration.TextsCache, usable: (texts: Texts, source: string) => boolean): ManualTextsView {
  return {
    current: () => {
      const texts = cache.current()
      return texts !== null && usable(texts, cache.source) ? texts : null
    },
    onChange: (listener) =>
      cache.onChange((texts, source) => {
        if (usable(texts, source)) listener(texts, source)
      }),
    refresh: () => cache.refresh(),
    get apiBase() {
      return cache.apiBase
    },
    get lastError() {
      return cache.lastError
    },
  }
}

interface Claim {
  readonly token: symbol
  readonly create: () => ManualKeeper
  /** Settles with the keeper's first outcome when this claim's keeper starts; null if it never does. */
  readonly settle: (outcome: ManualOutcome | null) => void
}

export interface ManualClaim {
  /** Stop keeping the manual for this account (the next account running takes over). Idempotent. */
  release(): void
  /** This claim's keeper's first outcome; null when another account's keeper runs, or the claim was released first. */
  readonly started: Promise<ManualOutcome | null>
}

const claims = new Map<string, Claim>()
let active: { readonly accountId: string; readonly token: symbol; readonly keeper: ManualKeeper } | null = null

/**
 * One keeper per process, whatever the number of accounts: the manual is
 * account-free. The first account that asks keeps it; when it stops, the
 * next one still running takes over. `release()` is idempotent and only
 * ever stops the keeper its own claim started.
 */
export function keepManualCurrent(accountId: string, create: () => ManualKeeper): ManualClaim {
  const token = Symbol(accountId)
  let settle: (outcome: ManualOutcome | null) => void = () => undefined
  const started = new Promise<ManualOutcome | null>((resolve) => {
    settle = resolve
  })
  claims.get(accountId)?.settle(null)
  claims.set(accountId, { token, create, settle })
  if (active?.accountId === accountId) {
    // A restart of the same account: the new cache replaces the old one.
    active.keeper.stop()
    active = null
  }
  if (active === null) activate()
  else if (active.accountId !== accountId) settle(null)
  return {
    started,
    release() {
      const claim = claims.get(accountId)
      if (claim?.token !== token) return
      claims.delete(accountId)
      claim.settle(null)
      if (active?.token === token) {
        active.keeper.stop()
        active = null
        activate()
      }
    },
  }
}

function activate(): void {
  const next = claims.entries().next()
  if (next.done) return
  const [accountId, claim] = next.value
  const keeper = claim.create()
  active = { accountId, token: claim.token, keeper }
  keeper.start().then(
    (outcome) => claim.settle(outcome),
    () => claim.settle(null),
  )
}

/** The running keeper's latest outcome (this process only). */
export function latestManualOutcome(): ManualOutcome | null {
  return active?.keeper.latest ?? null
}

/** Test seam. */
export function resetManualKeeperForTest(): void {
  active?.keeper.stop()
  active = null
  for (const claim of claims.values()) claim.settle(null)
  claims.clear()
}

// ─── cleanup ────────────────────────────────────────────────────────────────

/**
 * The last AgentChat account is gone (disabled or deleted): remove the
 * managed copy when its bytes are the ones this plugin recorded, and the
 * record. A file changed since, or someone else's, stays. Returns one line
 * per thing done or left. Never throws.
 */
export function removeManagedManual(configDir: string = openclawConfigDir()): string[] {
  const lines: string[] = []
  const record = readManualRecord(configDir)
  const found = inspectManagedManual(configDir)
  if (found.owner.kind === 'ours') {
    try {
      fs.unlinkSync(found.path)
      lines.push(`removed the AgentChat manual this plugin kept current (${found.path})`)
      try {
        fs.rmdirSync(managedManualDir(configDir)) // only when empty: anything else put there stays
      } catch {
        // not empty, or already gone
      }
    } catch (err) {
      lines.push(`could not remove the AgentChat manual ${found.path}: ${describe(err)} — delete it by hand`)
      return lines
    }
  } else if (found.owner.kind !== 'absent' && record?.written) {
    lines.push(`left ${found.path} in place: it is not the copy this plugin wrote (changed since, or someone else's)`)
  }
  if (record !== null) removeManualRecord(configDir)
  return lines
}

// ─── status and doctor (local reads only) ───────────────────────────────────

export type ManualCheckState = 'current' | 'stale' | 'unchecked' | 'bundled-only' | 'not-ours' | 'over-cap' | 'missing'

export interface ManualCheck {
  readonly state: ManualCheckState
  /** current → fine; over-cap / missing → the agent has no manual (or only a frozen one); the rest → a warning. */
  readonly ok: boolean
  readonly notice: boolean
  /** `openclaw doctor --fix` (or the gateway's next sync) can fix it. */
  readonly repair: boolean
  readonly detail: string
}

export interface ManualShadow {
  /** The SKILL.md that wins over the managed copy. */
  readonly path: string
  /** Where OpenClaw loads it from. */
  readonly root: string
  readonly where: 'workspace skills' | 'workspace .agents/skills' | 'personal ~/.agents/skills'
}

export interface CheckManualParams {
  readonly cfg?: unknown
  /** The announcement in hand (cached texts), or null. */
  readonly served: integration.ServedManual | null
  /** Where it came from: `server` (this process fetched it), else the cached file. Default `cache`. */
  readonly servedSource?: string
  /** The agents whose workspaces are checked for a higher-precedence agentchat skill. */
  readonly agentIds: readonly (string | undefined)[]
  /** The running keeper's latest outcome, when this process runs one. */
  readonly latest?: ManualOutcome | null
  /** A remedy for a disabled account (the re-enable route), replacing `doctor --fix`. */
  readonly remedy?: (forEnabled: string) => string
  readonly configDir?: string
  readonly home?: string
  /** Test seam: whether OpenClaw loads `~/.agents/skills` here (default `loadsPersonalSkills()`). */
  readonly personalSkills?: boolean
}

/**
 * The managed copy against the announcement, the size OpenClaw loads, the
 * skills that would win over it, and — with `skills.load.watch: false` —
 * whether OpenClaw still has the copy the gateway started with.
 */
export function checkManual(params: CheckManualParams): { primary: ManualCheck; shadows: ManualShadow[]; watch: string | null } {
  const configDir = params.configDir ?? openclawConfigDir()
  const remedy = params.remedy ?? ((forEnabled: string) => forEnabled)
  // A gateway restart syncs the manual at its start: lighter than `doctor --fix`, whose maintenance stops the gateway for minutes.
  const fix = (now: string) => remedy(`\`${openclawCommand('gateway restart')}\` ${now}`)
  const found = inspectManagedManual(configDir)
  const bundled = bundledManual()
  const cap = skillFileCap(params.cfg)
  // A cached announcement older than the bundled copy (an upgrade, AgentChat not reached since) is not held against the file.
  const superseded = supersededByBundle(params.served, params.servedSource ?? 'cache', bundled) ? params.served : null
  const served = superseded === null ? params.served : null
  const record = readManualRecord(configDir)
  const lastError = latestError(params.latest ?? null, record, served)
  // Past the not-ours branch below the file is free; when the last look found it someone else's, the
  // gateway takes it back at its own re-check (the kit has no failed sync to retry).
  const freed = params.latest?.kind === 'not-ours' || record?.last?.state === 'not-ours'
  const nextTry = freed
    ? `the gateway takes it back at its next check of the file (within ${MANUAL_CHECK_MS / 60_000} minutes)`
    : 'the gateway tries again on its own (after 5 minutes, backing off to an hour)'
  const check = (state: ManualCheckState, ok: boolean, notice: boolean, repair: boolean, detail: string): ManualCheck => ({ state, ok, notice, repair, detail })
  const home = params.home ?? os.homedir()
  const shadows = findManualShadows(params.cfg, params.agentIds, home, configDir, params.personalSkills ?? loadsPersonalSkills(undefined, home))
  const watch = watchOffNote(params.cfg, found, record)
  const result = (primary: ManualCheck) => ({ primary, shadows, watch })

  if (found.owner.kind === 'not-ours') {
    return result(check('not-ours', true, true, false, notOursLine(found.owner.reason, found.owner.wins)))
  }
  if (found.owner.kind === 'absent') {
    if (bundled === null) return result(check('missing', false, false, true, `no manual: ${found.path} is missing and the plugin's own copy cannot be read — ${fix('places the served one')}`))
    const freshness =
      served === null
        ? ''
        : bundled.version === served.version && (announcedSha(served) === null || announcedSha(served) === bundled.sha256)
          ? `, the served version`
          : `; served ${served.version}`
    return result(
      check(
        'bundled-only',
        true,
        true,
        true,
        `only the copy bundled with the plugin (${bundled.version ?? 'unversioned'}${freshness}) — the copy that keeps itself current (${found.path}) is not placed${lastError ? ` (${lastError})` : ''}; ${freed ? `the gateway places it at its next check of the file (within ${MANUAL_CHECK_MS / 60_000} minutes)` : 'the gateway places it when it starts'} — ${fix('places it now')}`,
      ),
    )
  }
  const size = found.size
  if (size > cap) {
    const fallbackLoads = bundled !== null && bundled.bytes.byteLength <= cap
    return result(
      check(
        'over-cap',
        false,
        false,
        false,
        `${found.path} is ${size} bytes, over OpenClaw's skill-file limit (skills.limits.maxSkillFileBytes = ${cap}), so OpenClaw skips it` +
          (fallbackLoads ? ` and the agent reads the copy bundled with the plugin (${bundled?.version ?? 'unversioned'}) instead` : ' — the agent has no manual') +
          ` — raise skills.limits.maxSkillFileBytes (the manual is ${size} bytes)`,
      ),
    )
  }
  const have = found.version ?? 'an unversioned file'
  if (served === null) {
    const why =
      superseded !== null
        ? `the cached announcement, ${superseded.version}, is older than the copy bundled with this plugin (${bundled?.version ?? '?'}); AgentChat not reached since the update`
        : 'no served version in hand — AgentChat not reached yet'
    return result(check('unchecked', true, true, false, `unchecked (have ${have}; ${why}) — ${found.path}`))
  }
  const hash = announcedSha(served)
  if (found.version === served.version && (hash === null || hash === found.sha256)) {
    return result(check('current', true, false, false, `current (${found.version}) — ${found.path}`))
  }
  const tampered = found.version === served.version
  const why = lastError ? `; last sync: ${lastError}` : ''
  return result(
    check(
      'stale',
      true,
      true,
      true,
      `${tampered ? `stale (have ${have} but not the served text: its sha256 differs` : `stale (have ${have}, served ${served.version}`}${why}) — ${found.path}; ${nextTry} — ${fix(freed ? 'does it now' : 'tries now')}`,
    ),
  )
}

/**
 * With `skills.load.watch: false` OpenClaw keeps the skills it found when
 * the gateway started (it rescans only at a restart): a managed copy written
 * since is not what the agent reads yet. Known from the record's gateway
 * start (written by the keeper) and the file's mtime; when no gateway start
 * is recorded, said as a condition. Null with the watch on, or no copy.
 */
function watchOffNote(cfg: unknown, found: ManagedManual, record: ManualRecord | null): string | null {
  const watch = (cfg as { skills?: { load?: { watch?: unknown } } } | undefined)?.skills?.load?.watch
  if (watch !== false || found.owner.kind === 'absent') return null
  let mtime: Date
  try {
    mtime = fs.statSync(found.path).mtime
  } catch {
    return null
  }
  const started = record?.gateway?.started_at ? new Date(record.gateway.started_at) : null
  if (started !== null && !Number.isNaN(started.getTime()) && mtime.getTime() <= started.getTime()) return null
  return (
    `skills watch is off (skills.load.watch: false): OpenClaw reads the new manual after a gateway restart — ` +
    (started !== null
      ? `${found.path} was written at ${mtime.toISOString()}, after the gateway started (${started.toISOString()}); run \`${openclawCommand('gateway restart')}\``
      : `if ${found.path} (written at ${mtime.toISOString()}) changed since the gateway started, run \`${openclawCommand('gateway restart')}\``)
  )
}

/** One line for a skill that wins over the managed copy. */
export function shadowLine(shadow: ManualShadow): string {
  return (
    `${shadow.path} is an ${MANUAL_SKILL} skill in the ${shadow.where} folder, which OpenClaw loads ahead of the managed copy — the agent reads it, not the served manual; ` +
    `if it is an old copy of the AgentChat manual, remove it (rm -r ${path.dirname(shadow.path)}); this plugin never deletes it`
  )
}

function notOursLine(reason: string, wins: boolean): string {
  return (
    `${reason}; this plugin leaves it alone and does not keep it current — ` +
    (wins ? 'the agent reads it instead of the served manual' : 'the agent reads the copy bundled with the plugin, which does not update') +
    `. To use the served manual: remove it; the gateway places the served one within 10 minutes, \`${openclawCommand('gateway restart')}\` at once`
  )
}

/** Why the announced manual is not on disk, from the latest outcome or the record, when it is about the same announcement. */
function latestError(latest: ManualOutcome | null, record: ManualRecord | null, served: integration.ServedManual | null): string | null {
  if (latest?.kind === 'synced') return latest.result.upToDate === true ? null : latest.result.error
  if (latest?.kind === 'failed') return latest.error
  if (latest?.kind === 'floor' && latest.error !== null) return latest.error
  if (latest?.kind === 'not-ours') return null
  const last = record?.last
  if (!last || last.error === null) return null
  // Someone else's file was the reason; the caller only asks once the file is writable again.
  if (last.state === 'not-ours') return null
  if (served !== null && last.served !== null && last.served !== served.version) return null
  return last.error
}

/**
 * Whether OpenClaw loads the personal `~/.agents/skills` folder. From
 * 2026.8.1 only for the default state dir: `if (isDefaultStateDir())` in
 * OpenClaw `src/skills/loading/workspace-skill-sources.ts:148` (2026.11.6;
 * added in `src/skills/loading/workspace.ts` by commit 0f91859, first in
 * v2026.8.1). Before that, always (2026.6.10 `workspace.ts:1195-1203`).
 * OpenClaw's `isDefaultStateDir` is not in its plugin SDK, so its rule is
 * mirrored (`src/config/paths.ts:63-77`): without `OPENCLAW_STATE_DIR`, the
 * default profile; with it, the override resolves to `~/.openclaw`. An
 * unknown OpenClaw version (no plugin runtime in this process) gets the
 * current rule.
 */
export function loadsPersonalSkills(openclawVersion: string | undefined = hostOpenClawVersion(), home: string = os.homedir()): boolean {
  if (openclawVersion !== undefined && isOpenClawRelease(openclawVersion) && !openclawAtLeast(openclawVersion, '2026.8.1')) return true
  const override = readOpenClawStateDirFromEnv()
  if (override === undefined) return readOpenClawProfileFromEnv() === undefined
  return realpathOr(expandUserPath(override)) === realpathOr(path.join(home, '.openclaw'))
}

function hostOpenClawVersion(): string | undefined {
  try {
    const version = (getPluginRuntime() as { version?: unknown } | null)?.version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

const OPENCLAW_RELEASE = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/

function isOpenClawRelease(value: string): boolean {
  return OPENCLAW_RELEASE.test(value.trim())
}

/** `a >= b` for OpenClaw's `YYYY.M.N` (a prerelease is below its release). */
function openclawAtLeast(a: string, b: string): boolean {
  const pa = OPENCLAW_RELEASE.exec(a.trim())
  const pb = OPENCLAW_RELEASE.exec(b.trim())
  if (!pa || !pb) return false
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return d > 0
  }
  return pa[4] === undefined || pb[4] !== undefined
}

function realpathOr(dir: string): string {
  try {
    return fs.realpathSync.native(path.resolve(dir))
  } catch {
    return path.resolve(dir)
  }
}

/**
 * `agentchat` skills OpenClaw loads ahead of the managed copy: in each
 * agent's `<workspace>/skills` and `<workspace>/.agents/skills`, and in
 * `~/.agents/skills` where OpenClaw loads it (`loadsPersonalSkills`).
 * OpenClaw merges by the front-matter name (the folder name when there is
 * none), so every child folder is read, not only `agentchat/`. Bounded;
 * local reads only.
 */
export function findManualShadows(
  cfg: unknown,
  agentIds: readonly (string | undefined)[],
  home: string = os.homedir(),
  configDir: string = openclawConfigDir(),
  personal: boolean = loadsPersonalSkills(undefined, home),
): ManualShadow[] {
  const roots: Array<{ dir: string; where: ManualShadow['where'] }> = []
  // A workspace whose skills folder is the managed one (a workspace at the config dir) loads the managed copy itself.
  const seen = new Set<string>([path.resolve(configDir, 'skills')])
  const add = (dir: string, where: ManualShadow['where']) => {
    const resolved = path.resolve(dir)
    if (seen.has(resolved)) return
    seen.add(resolved)
    roots.push({ dir: resolved, where })
  }
  if (personal) add(path.join(home, '.agents', 'skills'), 'personal ~/.agents/skills')
  for (const agentId of agentIds.length > 0 ? agentIds : [undefined]) {
    let workspace: string
    try {
      workspace = resolveOpenClawWorkspaceDir(cfg as object | undefined, agentId)
    } catch {
      continue
    }
    add(path.join(workspace, '.agents', 'skills'), 'workspace .agents/skills')
    add(path.join(workspace, 'skills'), 'workspace skills')
  }
  const shadows: ManualShadow[] = []
  for (const root of roots) {
    for (const file of agentchatSkillsIn(root.dir)) shadows.push({ path: file, root: root.dir, where: root.where })
  }
  return shadows
}

function agentchatSkillsIn(root: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries.slice(0, SHADOW_SCAN_MAX_DIRS)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const file = path.join(root, entry.name, MANUAL_FILE)
    const head = readHead(file)
    if (head === null) continue
    const fields = integration.manualFrontMatter(head)
    const name = fields?.get('name')?.trim() || entry.name
    if (name === MANUAL_SKILL && (fields?.get('description')?.trim() ?? '') !== '') found.push(file)
  }
  return found
}

function readHead(file: string): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(FRONT_MATTER_READ_BYTES)
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

// ─── one line per outcome ───────────────────────────────────────────────────

export function describeManualOutcome(outcome: ManualOutcome): string {
  switch (outcome.kind) {
    case 'not-ours':
      return notOursLine(outcome.reason, outcome.wins)
    case 'failed':
      return `${outcome.error}; the agent reads the copy bundled with the plugin`
    case 'floor':
      return outcome.error !== null
        ? `bundled copy ${outcome.version ?? 'unversioned'} → ${outcome.path} (was ${outcome.previous ?? 'an unversioned file'}); served ${outcome.served ?? '?'} could not be fetched: ${outcome.error}`
        : `bundled copy ${outcome.version ?? 'unversioned'} → ${outcome.path} (was ${outcome.previous ?? 'an unversioned file'}${outcome.served !== null ? `; the cached announcement, ${outcome.served}, is older` : ''})`
    case 'synced':
      return describeSyncResult(outcome.result)
  }
}

function describeSyncResult(result: integration.ManualSyncResult): string {
  const at = result.path
  const have = result.tampered ? `${result.previous} with a sha256 that is not the served one` : (result.previous ?? 'an unversioned file')
  switch (result.state) {
    case 'current':
      return `current (${result.version}) — ${at}`
    case 'updated':
      return `${result.version} ${result.source === 'download' ? `downloaded from ${result.url}` : 'placed from the bundled copy (the served version)'} → ${at}${result.previous !== null ? ` (was ${have})` : ''}`
    case 'fallback':
      return result.served === null
        ? `bundled copy ${result.version} → ${at} (no served version in hand to check it against)`
        : `bundled copy ${result.version} → ${at}; served ${result.served} could not be fetched: ${result.error}`
    case 'kept':
      return result.served === null
        ? `unchecked (have ${have}; no served version in hand) — ${at}`
        : `stale (have ${have}, served ${result.served}) — ${at}; kept as it is: ${result.error}`
    case 'failed':
      return `could not write ${at}: ${result.error}`
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function announcedSha(served: integration.ServedManual): string | null {
  const raw = (served as { sha256?: unknown }).sha256
  return typeof raw === 'string' && /^[0-9a-f]{64}$/i.test(raw.trim()) ? raw.trim().toLowerCase() : null
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

function readFileOrNull(file: string): Uint8Array | null {
  try {
    return new Uint8Array(fs.readFileSync(file))
  } catch {
    return null
  }
}

/** Temp file in the same dir, fsync, rename: a reader sees the old file or the new one. */
function writeFileAtomicSync(file: string, data: string | Uint8Array, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  let fd: number | null = null
  try {
    fd = fs.openSync(tmp, 'w', mode)
    fs.writeFileSync(fd, typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, file)
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // already closed
      }
    }
    try {
      fs.unlinkSync(tmp)
    } catch {
      // never created, or renamed
    }
    throw err
  }
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
