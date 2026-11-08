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
 * them (`agentchat__<tool>`); the copy handed out is still passed through the
 * idempotent re-speller (a no-op then), so a server that serves bare names
 * again — a rolled-back deploy — cannot hand the agent wrong tool names. The
 * stored copy is always server-verbatim.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { integration, type AgentChatClient, type Texts } from 'agentchatme'

import type { Logger } from '../log.js'
import { integrationStateDir } from './state.js'
import { spellToolsForOpenClaw } from './turn.js'

export const TEXTS_RUNTIME = 'openclaw' as const
export const TEXTS_CACHE_FILE = 'texts.json'

export type TextsClient = Pick<AgentChatClient, 'texts'> & { readonly baseUrl?: string }

/** Where the kit's cache keeps the last good copy for this account. */
export function textsCachePath(accountId: string, stateDir?: string): string {
  return path.join(integrationStateDir(accountId, stateDir), TEXTS_CACHE_FILE)
}

/** Re-spell the hosted tool names in every agent-facing text. Pure, idempotent; the stored copy stays server-verbatim. */
export function spellTextsForOpenClaw(texts: Texts): Texts {
  return {
    ...texts,
    wake_instruction: spellToolsForOpenClaw(texts.wake_instruction),
    invite_prompt: spellToolsForOpenClaw(texts.invite_prompt),
    identity_line: spellToolsForOpenClaw(texts.identity_line),
    identity_line_template: spellToolsForOpenClaw(texts.identity_line_template),
    ...(typeof texts.gate_call_preamble === 'string' ? { gate_call_preamble: spellToolsForOpenClaw(texts.gate_call_preamble) } : {}),
    ...(typeof texts.gate_call_answer_format === 'string' ? { gate_call_answer_format: spellToolsForOpenClaw(texts.gate_call_answer_format) } : {}),
  }
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

/**
 * What the receive loop reads: the cache's copy through the re-speller. The
 * spelled copy is memoised per served copy, so a cycle does not re-spell.
 */
export class OpenClawTexts implements integration.TextsSource {
  private spelledFrom: Texts | null = null
  private spelled: Texts | null = null

  constructor(private readonly cache: integration.TextsCache) {}

  current(): Texts | null {
    return this.spell(this.cache.current())
  }

  async ensure(): Promise<Texts | null> {
    return this.spell(await this.cache.ensure())
  }

  get source(): string {
    return this.cache.source
  }

  get fetchedAt(): string | null {
    return this.cache.fetchedAt
  }

  get lastError(): string | null {
    return this.cache.lastError
  }

  private spell(texts: Texts | null): Texts | null {
    if (texts === null) return null
    if (texts !== this.spelledFrom) {
      this.spelledFrom = texts
      this.spelled = spellTextsForOpenClaw(texts)
    }
    return this.spelled
  }
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
    return texts ? spellToolsForOpenClaw(texts.identity_line) : null
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
    return spellToolsForOpenClaw(entry.texts.identity_line)
  } catch {
    return null
  }
}

/** The shape every consumer relies on: the kit's own check. */
export const isTexts: (value: unknown) => value is Texts = integration.isTexts
