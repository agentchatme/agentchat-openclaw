/**
 * The AgentChat API key on disk — one owner-only file per key, read only by
 * this plugin's own code.
 *
 * The key is the agent's password on AgentChat. It used to sit in plain text
 * in `openclaw.json` (`channels.agentchat.apiKey`), a file the agent reads
 * for other reasons; one peer-woken turn read it and the whole key went into
 * the transcript and to the model provider. Now the config holds a path
 * (`channels.agentchat.apiKeyFile`, OpenClaw's own `tokenFile` convention for
 * channel credentials) and the key lives here:
 *
 *   <state dir>/agentchat/<accountId>/keys/key-<16 hex of sha256(key)>
 *
 * directory `0700`, file `0600`, written atomically. The name follows from
 * the key, so writing a new key never changes the file an unchanged config
 * points at: a setup that is cancelled after the key was written leaves the
 * config and the key it names exactly as they were, and the new key stays
 * on disk instead of being lost (register and recover issue a key once).
 * Key files are never deleted behind the operator's back — not even by
 * `openclaw channels remove agentchat --delete`, which names them instead
 * (OpenClaw may still refuse that config write); `openclaw doctor` names
 * the ones the config no longer uses.
 *
 * Honest limit: an agent with a shell can still find this file if it
 * deliberately looks. Keeping the key out of the config and out of argv
 * removes the accidental spread; it is not process isolation.
 *
 * Local filesystem I/O only: no SDK, no network, no environment reads (the
 * state dir comes from the layout module, which reads the environment
 * through `./read-env.ts`).
 */

import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { expandUserPath } from '../openclaw-layout.js'
import { integrationStateDir } from '../integration/state.js'

/** The account's key directory under the plugin's state dir. */
export const KEY_DIR_NAME = 'keys'
const KEY_FILE_PREFIX = 'key-'
/** A key is a few dozen characters; anything larger is not a key file. */
export const MAX_KEY_FILE_BYTES = 4096

/** `<state dir>/agentchat/<accountId>/keys`. */
export function accountKeysDir(accountId: string, stateDir?: string): string {
  return path.join(integrationStateDir(accountId, stateDir), KEY_DIR_NAME)
}

/** The file a key is stored in: named from the key's sha256, never the key. */
export function apiKeyFilePathFor(accountId: string, apiKey: string, stateDir?: string): string {
  const digest = createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 16)
  return path.join(accountKeysDir(accountId, stateDir), `${KEY_FILE_PREFIX}${digest}`)
}

export type KeyFileRead =
  | { readonly ok: true; readonly apiKey: string; readonly path: string; readonly loosePermissions: boolean }
  | { readonly ok: false; readonly path: string; readonly reason: string }

/** A key is one token: no whitespace inside, no line break. */
function keyShapeProblem(value: string): string | null {
  if (value.length === 0) return 'it is empty'
  if (/\s/.test(value)) return 'it holds more than the key (whitespace or a second line)'
  return null
}

/**
 * Read the key a config's `apiKeyFile` names. Refused, with the reason: a
 * missing file, a symbolic link or anything but a regular file (OpenClaw
 * refuses symlinked token files the same way), more than 4 KiB, or content
 * that is not one key. Group- or world-readable files are read, and
 * reported (`loosePermissions`) so doctor can say so and `--fix` tightens
 * them. Never throws; never returns the key in a reason.
 */
export function readApiKeyFile(file: string): KeyFileRead {
  const resolved = expandUserPath(file)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(resolved)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return { ok: false, path: resolved, reason: code === 'ENOENT' ? 'the file does not exist' : `it cannot be read (${code ?? 'error'})` }
  }
  if (stat.isSymbolicLink()) return { ok: false, path: resolved, reason: 'it is a symbolic link (refused, as OpenClaw refuses symlinked token files)' }
  if (!stat.isFile()) return { ok: false, path: resolved, reason: 'it is not a regular file' }
  if (stat.size > MAX_KEY_FILE_BYTES) return { ok: false, path: resolved, reason: `it is larger than ${MAX_KEY_FILE_BYTES} bytes, so it is not a key file` }
  let content: string
  try {
    content = fs.readFileSync(resolved, 'utf8').trim()
  } catch (err) {
    return { ok: false, path: resolved, reason: `it cannot be read (${(err as NodeJS.ErrnoException)?.code ?? 'error'})` }
  }
  const problem = keyShapeProblem(content)
  if (problem) return { ok: false, path: resolved, reason: problem }
  return { ok: true, apiKey: content, path: resolved, loosePermissions: process.platform !== 'win32' && (stat.mode & 0o077) !== 0 }
}

function chmodQuietly(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode)
  } catch {
    // A filesystem without POSIX modes keeps its own defaults.
  }
}

/**
 * Store a key: `0700` directories, a `0600` file, written to a temp file in
 * the same directory and renamed into place. The same key again is a no-op
 * (`created: false`) that only re-tightens the file's mode. Throws on a key
 * that is not one token, or when the filesystem refuses.
 */
export function writeApiKeyFile(accountId: string, apiKey: string, stateDir?: string): { path: string; created: boolean } {
  const key = apiKey.trim()
  const problem = keyShapeProblem(key)
  if (problem) throw new Error(`the API key cannot be stored: ${problem}`)
  const accountDir = integrationStateDir(accountId, stateDir)
  const dir = accountKeysDir(accountId, stateDir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodQuietly(accountDir, 0o700)
  chmodQuietly(dir, 0o700)
  const file = apiKeyFilePathFor(accountId, key, stateDir)
  const existing = readApiKeyFile(file)
  if (existing.ok && existing.apiKey === key) {
    if (existing.loosePermissions) chmodQuietly(file, 0o600)
    return { path: file, created: false }
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeSync(fd, `${key}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // best effort
    }
    throw err
  }
  chmodQuietly(file, 0o600)
  syncDirectory(dir)
  return { path: file, created: true }
}

/**
 * Make the rename durable: a config written right after this may name the
 * file, and a power loss must not leave it naming one that is gone (it can
 * be the only copy of a key just issued). Best effort; Windows cannot open
 * a directory for fsync.
 */
function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return
  let fd: number | undefined
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // best effort
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Tighten a key file to `0600` (doctor --fix). True when the mode changed. */
export function tightenApiKeyFile(file: string): boolean {
  const read = readApiKeyFile(file)
  if (!read.ok || !read.loosePermissions) return false
  chmodQuietly(read.path, 0o600)
  return true
}

/** Every key file the account has on disk (the one in use and superseded ones). */
export function listAccountKeyFiles(accountId: string, stateDir?: string): string[] {
  const dir = accountKeysDir(accountId, stateDir)
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(KEY_FILE_PREFIX))
      .map((name) => path.join(dir, name))
      .sort()
  } catch {
    return []
  }
}

/**
 * Remove every key file of the account (and the directory when it is left
 * empty). Returns what was removed. Never throws. Not called on
 * `channels remove --delete`: OpenClaw runs the removal hook before it
 * commits the config and may still refuse the write, so the plugin never
 * deletes the only copy of a key there (`removeIntegrationFiles`).
 */
export function removeAccountKeyFiles(accountId: string, stateDir?: string): string[] {
  const removed: string[] = []
  for (const file of listAccountKeyFiles(accountId, stateDir)) {
    try {
      fs.unlinkSync(file)
      removed.push(file)
    } catch {
      // best effort
    }
  }
  try {
    fs.rmdirSync(accountKeysDir(accountId, stateDir))
  } catch {
    // not empty, or absent
  }
  return removed
}

// ─── `openclaw channels add agentchat --token-file <path>` ─────────────

/** What one process already read from a token file (stdin can be read once). */
const tokenFileReads = new Map<string, TokenFileRead>()

export type TokenFileRead = { readonly ok: true; readonly apiKey: string } | { readonly ok: false; readonly reason: string }

/** Up to `MAX_KEY_FILE_BYTES + 1` bytes from an open descriptor. */
function readCapped(fd: number): Buffer {
  const chunks: Buffer[] = []
  let total = 0
  const buf = Buffer.alloc(1024)
  for (;;) {
    let n: number
    try {
      n = fs.readSync(fd, buf, 0, buf.length, null)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EAGAIN') continue
      throw err
    }
    if (n === 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
    total += n
    if (total > MAX_KEY_FILE_BYTES) break
  }
  return Buffer.concat(chunks)
}

/**
 * The key a setup reads from `--token-file <path>` (OpenClaw's own channel
 * setup option; OpenClaw hands the path to the plugin and reads nothing
 * itself). `-` reads standard input. The file holds the key and nothing else
 * (a trailing newline is fine). Read once per process and remembered, since
 * OpenClaw calls several setup hooks with the same input. Never throws;
 * never returns the key in a reason.
 */
export function readTokenFile(file: string): TokenFileRead {
  const source = file.trim()
  const cacheKey = source === '-' ? '-' : expandUserPath(source)
  const cached = tokenFileReads.get(cacheKey)
  if (cached) return cached
  const result = readTokenFileUncached(source, cacheKey)
  tokenFileReads.set(cacheKey, result)
  return result
}

function readTokenFileUncached(source: string, resolved: string): TokenFileRead {
  if (source.length === 0) return { ok: false, reason: '--token-file needs a path (or - for standard input)' }
  let fd: number
  let owned = false
  if (source === '-') {
    fd = 0
  } else {
    try {
      const stat = fs.statSync(resolved)
      if (stat.isDirectory()) return { ok: false, reason: `${resolved} is a directory` }
      fd = fs.openSync(resolved, 'r')
      owned = true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      return { ok: false, reason: `${resolved} ${code === 'ENOENT' ? 'does not exist' : `cannot be read (${code ?? 'error'})`}` }
    }
  }
  let content: string
  try {
    const bytes = readCapped(fd)
    if (bytes.length > MAX_KEY_FILE_BYTES) return { ok: false, reason: `${source === '-' ? 'standard input' : resolved} holds more than ${MAX_KEY_FILE_BYTES} bytes, so it is not a key` }
    content = bytes.toString('utf8').trim()
  } catch (err) {
    return { ok: false, reason: `${source === '-' ? 'standard input' : resolved} cannot be read (${(err as NodeJS.ErrnoException)?.code ?? 'error'})` }
  } finally {
    if (owned) fs.closeSync(fd)
  }
  const problem = keyShapeProblem(content)
  if (problem) return { ok: false, reason: `${source === '-' ? 'standard input' : resolved} is not one API key: ${problem}` }
  return { ok: true, apiKey: content }
}

/** Test seam: forget what was read from token files. */
export function resetTokenFileReadsForTest(): void {
  tokenFileReads.clear()
}

// ─── copies OpenClaw keeps ─────────────────────────────────────────────

/** How many rotating backups OpenClaw keeps next to its config (`CONFIG_BACKUP_COUNT` in its `src/config/backup-rotation.ts`). */
export const OPENCLAW_CONFIG_BACKUPS = 5

/**
 * OpenClaw's own copies of its config file: the backup ring
 * (`openclaw.json.bak`, `.bak.1` … `.bak.4`), the last config a gateway
 * started with (`.last-good`), the pre-update snapshot (`.pre-update`) and
 * the payloads of config writes it refused (`.rejected.<time>`).
 * OpenClaw writes and rotates them; this plugin never edits them.
 */
export function openClawConfigCopyPaths(configPath: string): string[] {
  const base = `${configPath}.bak`
  const ring = [base, ...Array.from({ length: OPENCLAW_CONFIG_BACKUPS - 1 }, (_, i) => `${base}.${i + 1}`)]
  let rejected: string[] = []
  try {
    const prefix = `${path.basename(configPath)}.rejected.`
    rejected = fs
      .readdirSync(path.dirname(configPath))
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => path.join(path.dirname(configPath), name))
  } catch {
    // no config directory: no copies
  }
  return [...ring, `${configPath}.last-good`, `${configPath}.pre-update`, ...rejected]
}

/**
 * Which of `files` hold `apiKey` in plain text. Reads each existing file
 * (up to 8 MiB); returns paths only — never the key, never a line of the
 * file. Never throws.
 */
export function filesHoldingKey(apiKey: string, files: readonly string[]): string[] {
  const key = apiKey.trim()
  if (key.length === 0) return []
  const found: string[] = []
  for (const file of files) {
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue
      if (fs.readFileSync(file, 'utf8').includes(key)) found.push(file)
    } catch {
      // absent or unreadable: not a copy we can name
    }
  }
  return found
}
