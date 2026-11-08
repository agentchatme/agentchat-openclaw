/**
 * The plugin's own state on disk: `<OpenClaw state dir>/agentchat/<accountId>/`.
 *
 * One small JSON file lives there: the served texts (`texts.json`), a cache
 * of what the server serves, so a gateway can start while the server is
 * unreachable. Nothing secret, nothing authoritative — deleting the
 * directory costs one texts fetch.
 *
 * The SDK kit's cache writes it atomically (temp file + fsync + rename).
 */

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
