/**
 * The plugin's own state on disk: `<OpenClaw state dir>/agentchat/<accountId>/`.
 *
 * Two small JSON files live there: the served texts (`texts.json`), a cache
 * of what the server serves, so a gateway can start while the server is
 * unreachable; and the turns in flight (`turns.json`, `./turn-store.ts`), so
 * the next start after a gateway restart holds their conversations. Files
 * earlier releases kept here are removed on start (`removeOldStateFiles`).
 * Nothing secret, nothing authoritative — deleting the directory costs one
 * texts fetch (and, while the gateway is stopped, the restart defense for
 * that one restart).
 *
 * Both are written atomically (temp file + rename; the kit's cache also
 * fsyncs).
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

/** Files earlier releases kept here that nothing reads any more. */
export const OLD_INVITE_LEDGER_FILE = 'invites.json'

/**
 * Upgrade cleanup, once per start: the invite ledger of earlier releases
 * (invites now come from the tray) and a texts cache in the earlier shape
 * (the kit's cache keeps `{ version: 1, runtime, fetched_at, texts }`; an
 * older file is ignored by it and would only linger). Never throws; returns
 * what was removed.
 */
export function removeOldStateFiles(accountId: string, stateDir?: string): string[] {
  const dir = integrationStateDir(accountId, stateDir)
  const removed: string[] = []
  const ledger = path.join(dir, OLD_INVITE_LEDGER_FILE)
  if (tryUnlink(ledger)) removed.push(ledger)
  const texts = path.join(dir, 'texts.json')
  try {
    const entry = JSON.parse(fs.readFileSync(texts, 'utf8')) as { version?: unknown; runtime?: unknown }
    if (entry.version !== 1 || typeof entry.runtime !== 'string') {
      if (tryUnlink(texts)) removed.push(texts)
    }
  } catch (err) {
    // Absent: nothing to do. Unreadable or not JSON: an old or damaged copy.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT' && tryUnlink(texts)) removed.push(texts)
  }
  return removed
}

function tryUnlink(file: string): boolean {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

