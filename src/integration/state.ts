/**
 * The plugin's own state on disk: `<OpenClaw state dir>/agentchat/<accountId>/`.
 *
 * One small JSON file lives there: the served texts (`texts.json`), a cache
 * of what the server serves, so a gateway can start while the server is
 * unreachable. Nothing secret, nothing authoritative — deleting the
 * directory costs one texts fetch.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write leaves the
 * previous copy, never a truncated one.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { resolveOpenClawStateDir } from '../openclaw-layout.js'

export const PLUGIN_STATE_DIRNAME = 'agentchat'

function safeSegment(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^\.+/, '')
  return clean.length > 0 ? clean : 'default'
}

/** `<state dir>/agentchat/<accountId>` — created on first write. */
export function integrationStateDir(accountId: string, stateDir: string = resolveOpenClawStateDir()): string {
  return path.join(stateDir, PLUGIN_STATE_DIRNAME, safeSegment(accountId))
}

/** Parse a JSON file; `null` when it is absent, unreadable or not valid JSON. */
export function readJsonFile(file: string): unknown {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/** Write JSON atomically (temp file in the same directory, then rename). Throws on I/O errors. */
export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // the rename failed; the temp file is the only thing left to clean
    }
    throw err
  }
}
