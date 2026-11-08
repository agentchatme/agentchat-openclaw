/**
 * The served texts: the SDK kit's `TextsCache`, kept in the plugin's state dir.
 *
 * Every text an agent sees is written once on the server and served as data
 * (`GET /v1/texts?runtime=openclaw`): the wake instruction, the invite
 * prompt, the gate-call preamble and answer format, the identity line, where
 * the manual is. The kit's cache fetches them at channel start and daily,
 * keeps the last good copy in `<state dir>/agentchat/<accountId>/texts.json`
 * (an offline start is not mute), and backs off after a failure. The server
 * spells the hosted tools for `runtime=openclaw` the way OpenClaw exposes
 * them (`agentchat__<tool>`), so the texts are used exactly as served.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { integration, type AgentChatClient, type Texts } from 'agentchatme'

import type { Logger } from '../log.js'
import { integrationStateDir } from './state.js'

export const TEXTS_RUNTIME = 'openclaw' as const
export const TEXTS_CACHE_FILE = 'texts.json'

export type TextsClient = Pick<AgentChatClient, 'texts'> & { readonly baseUrl?: string }

/** Where the kit's cache keeps the last good copy for this account. */
export function textsCachePath(accountId: string, stateDir?: string): string {
  return path.join(integrationStateDir(accountId, stateDir), TEXTS_CACHE_FILE)
}

/** The kit's cache for one account, its file in the plugin's state dir. */
export function createTextsCache(params: {
  client: TextsClient
  accountId: string
  stateDir?: string | undefined
  logger?: Logger
}): integration.TextsCache {
  return new integration.TextsCache({
    client: params.client,
    runtime: TEXTS_RUNTIME,
    filePath: textsCachePath(params.accountId, params.stateDir),
    ...(params.logger ? { onError: (err: Error) => params.logger?.warn({ err: err.message }, 'served texts') } : {}),
  })
}

export interface LoadTextsParams {
  readonly client: TextsClient
  readonly accountId: string
  readonly stateDir?: string | undefined
}

/**
 * The identity line for the key's own agent, as served — for the
 * placement paths that run outside the gateway (wizard, `channels add`,
 * `doctor --fix`, re-enable). One fetch through the kit's cache (the server,
 * else the file it keeps); `null` when neither has a copy. Never throws.
 */
export async function loadIdentityLine(params: LoadTextsParams): Promise<string | null> {
  const cache = createTextsCache(params)
  try {
    const texts = await cache.start()
    return texts ? texts.identity_line : null
  } catch {
    return null
  } finally {
    cache.stop()
  }
}

/** The cached identity line, without touching the network (status, doctor preview). Reads the kit's file. */
export function cachedIdentityLine(accountId: string, stateDir?: string): string | null {
  let raw: string
  try {
    raw = fs.readFileSync(textsCachePath(accountId, stateDir), 'utf8')
  } catch {
    return null
  }
  try {
    const entry = JSON.parse(raw) as { runtime?: unknown; texts?: unknown }
    if (entry.runtime !== TEXTS_RUNTIME || !isTexts(entry.texts)) return null
    return entry.texts.identity_line
  } catch {
    return null
  }
}

/** The shape every consumer relies on: the kit's own check. */
export const isTexts: (value: unknown) => value is Texts = integration.isTexts
