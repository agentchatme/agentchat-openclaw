/**
 * The managed manual as setup leaves it: the kit's texts cache file for the
 * account (what status and doctor read the announcement from) and the
 * served manual placed in OpenClaw's managed skills dir. The announcement
 * is the bundled copy's, so nothing is downloaded.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { managedManualPath, placeManual } from '../../src/integration/manual.js'
import { textsCachePath } from '../../src/integration/texts.js'
import { BUNDLED_MANUAL_VERSION, SERVED_TEXTS } from './texts.js'

/** The kit's texts cache file, as a gateway or a setup leaves it (status and doctor read the announcement there). */
export function writeTextsCache(accountId = 'default', stateDir?: string, texts = SERVED_TEXTS): void {
  const file = textsCachePath(accountId, stateDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: 1, runtime: 'openclaw', fetched_at: new Date().toISOString(), texts }))
}

/** The line a placement prints for the bundled copy placed as the served version. */
export function placedFromBundleLine(): string {
  return `✓ manual: ${BUNDLED_MANUAL_VERSION} placed from the bundled copy (the served version) → ${managedManualPath()}`
}

export async function placeServedManual(accountId = 'default', stateDir?: string): Promise<void> {
  writeTextsCache(accountId, stateDir)
  const outcome = await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: 'https://api.agentchat.me' })
  if (outcome.kind !== 'synced' || outcome.result.upToDate !== true) throw new Error(`placeServedManual: ${JSON.stringify(outcome)}`)
}
