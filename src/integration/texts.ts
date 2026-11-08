/**
 * The served texts: fetched from AgentChat, never bundled.
 *
 * Every text an agent sees is written once, in AgentChat's experience layer,
 * and served as data (`GET /v1/texts?runtime=openclaw`): the wake
 * instruction a turn starts with, the invite prompt, the identity line that
 * goes into the workspace `AGENTS.md`, and where the manual is. This module
 * fetches them at channel start and every 24 hours, keeps the last copy in
 * the plugin's state dir, and hands them out spelled for OpenClaw (the hosted
 * tools as `agentchat__<tool>`, see `./turn.ts`).
 *
 * When the server is unreachable at start the last cached copy is used; with
 * nothing cached the channel still starts (the socket connects, the gate can
 * run) and logs once — turns wait for the first successful fetch, which is
 * retried every few minutes until it lands.
 */

import * as path from 'node:path'

import type { AgentChatClient, Texts } from 'agentchatme'

import type { Logger } from '../log.js'
import { integrationStateDir, readJsonFile, writeJsonFile } from './state.js'
import { spellToolsForOpenClaw } from './turn.js'

export const TEXTS_RUNTIME = 'openclaw' as const
/** The server suggests a daily refresh. */
export const TEXTS_REFRESH_MS = 24 * 60 * 60_000
/** Until the first copy exists, try again this often. */
export const TEXTS_RETRY_MS = 5 * 60_000
/** One fetch must never hold the channel start for long. */
export const TEXTS_FETCH_TIMEOUT_MS = 10_000
export const TEXTS_CACHE_FILE = 'texts.json'

export type TextsClient = Pick<AgentChatClient, 'texts'>

export interface CachedTexts {
  readonly fetched_at: string
  /** Server-verbatim; spelled for OpenClaw on the way out. */
  readonly texts: Texts
}

export type TextsSourceKind = 'server' | 'cache'

export interface LoadedTexts {
  /** Spelled for OpenClaw. */
  readonly texts: Texts
  readonly source: TextsSourceKind
  readonly fetchedAt: string
}

/** The shape every consumer relies on. Extra fields a newer server adds pass through. */
export function isTexts(value: unknown): value is Texts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const t = value as Record<string, unknown>
  const manual = t.manual as Record<string, unknown> | undefined
  return (
    typeof t.version === 'string' &&
    typeof t.wake_instruction === 'string' &&
    t.wake_instruction.length > 0 &&
    typeof t.invite_prompt === 'string' &&
    t.invite_prompt.length > 0 &&
    typeof t.identity_line === 'string' &&
    t.identity_line.length > 0 &&
    typeof t.identity_line_template === 'string' &&
    !!manual &&
    typeof manual === 'object' &&
    typeof manual.url === 'string' &&
    typeof manual.version === 'string'
  )
}

export function textsCachePath(accountId: string, stateDir?: string): string {
  return path.join(integrationStateDir(accountId, stateDir), TEXTS_CACHE_FILE)
}

export function readCachedTexts(accountId: string, stateDir?: string): CachedTexts | null {
  const raw = readJsonFile(textsCachePath(accountId, stateDir))
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  if (typeof entry.fetched_at !== 'string' || !isTexts(entry.texts)) return null
  return { fetched_at: entry.fetched_at, texts: entry.texts }
}

/** Persist a server copy. Returns the file written. Throws on I/O errors. */
export function writeCachedTexts(accountId: string, texts: Texts, fetchedAt: Date, stateDir?: string): string {
  const file = textsCachePath(accountId, stateDir)
  const entry: CachedTexts = { fetched_at: fetchedAt.toISOString(), texts }
  writeJsonFile(file, entry)
  return file
}

/** The served texts with every hosted tool name spelled the way OpenClaw exposes it. */
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

/** One fetch, server-verbatim. Throws on transport errors, non-2xx answers and an unusable shape. */
export async function fetchTexts(client: TextsClient, timeoutMs: number = TEXTS_FETCH_TIMEOUT_MS): Promise<Texts> {
  const texts: unknown = await client.texts.get({ runtime: TEXTS_RUNTIME, timeoutMs })
  if (!isTexts(texts)) throw new Error('GET /v1/texts: answer is not a texts set (missing wake_instruction, invite_prompt or identity_line)')
  return texts
}

export interface LoadTextsParams {
  readonly client: TextsClient
  readonly accountId: string
  readonly stateDir?: string | undefined
  readonly now?: () => number
  readonly log?: Logger | undefined
  readonly timeoutMs?: number
}

/**
 * Server first; the cache when the server cannot be reached. A server
 * success refreshes the cache (a cache write failure is logged, never
 * fatal). `null` when neither is available. Never throws.
 */
export async function loadTexts(params: LoadTextsParams): Promise<LoadedTexts | null> {
  const now = params.now ?? Date.now
  try {
    const texts = await fetchTexts(params.client, params.timeoutMs)
    const fetchedAt = new Date(now())
    try {
      writeCachedTexts(params.accountId, texts, fetchedAt, params.stateDir)
    } catch (err) {
      params.log?.warn({ err: describe(err) }, 'texts fetched but the cache could not be written')
    }
    return { texts: spellTextsForOpenClaw(texts), source: 'server', fetchedAt: fetchedAt.toISOString() }
  } catch (err) {
    const cached = readCachedTexts(params.accountId, params.stateDir)
    if (cached) {
      params.log?.info({ err: describe(err), fetchedAt: cached.fetched_at }, 'texts: server unreachable — using the cached copy')
      return { texts: spellTextsForOpenClaw(cached.texts), source: 'cache', fetchedAt: cached.fetched_at }
    }
    params.log?.debug({ err: describe(err) }, 'texts: server unreachable and nothing cached')
    return null
  }
}

/**
 * The identity line for the key's own agent, spelled for OpenClaw — for the
 * placement paths that run outside the gateway (wizard, `channels add`,
 * `doctor --fix`, re-enable). Server, then cache; `null` when neither.
 */
export async function loadIdentityLine(params: LoadTextsParams): Promise<string | null> {
  const loaded = await loadTexts(params)
  return loaded ? loaded.texts.identity_line : null
}

/** The cached identity line, spelled for OpenClaw, without touching the network (status, doctor preview). */
export function cachedIdentityLine(accountId: string, stateDir?: string): string | null {
  const cached = readCachedTexts(accountId, stateDir)
  return cached ? spellToolsForOpenClaw(cached.texts.identity_line) : null
}

export interface TextsStoreOptions {
  readonly client: TextsClient
  readonly accountId: string
  readonly logger: Logger
  readonly stateDir?: string | undefined
  readonly refreshMs?: number
  readonly retryMs?: number
  readonly fetchTimeoutMs?: number
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout
  readonly clearTimeout?: (handle: NodeJS.Timeout) => void
}

/**
 * The texts for one running account: loaded at start, refreshed on a timer,
 * available synchronously to the invoker. `ensure()` is what a cycle calls
 * when it needs them: the current copy, or one load attempt right now.
 */
export class TextsStore {
  private readonly client: TextsClient
  private readonly accountId: string
  private readonly logger: Logger
  private readonly stateDir: string | undefined
  private readonly refreshMs: number
  private readonly retryMs: number
  private readonly fetchTimeoutMs: number
  private readonly now: () => number
  private readonly _setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout
  private readonly _clearTimeout: (handle: NodeJS.Timeout) => void

  private loaded: LoadedTexts | null = null
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<Texts | null> | null = null
  private stopped = false
  private missingAnnounced = false
  private readonly listeners = new Set<(texts: Texts, source: TextsSourceKind) => void>()

  loads = 0
  serverLoads = 0

  constructor(options: TextsStoreOptions) {
    this.client = options.client
    this.accountId = options.accountId
    this.logger = options.logger.child({ component: 'texts', accountId: options.accountId })
    this.stateDir = options.stateDir
    this.refreshMs = options.refreshMs ?? TEXTS_REFRESH_MS
    this.retryMs = options.retryMs ?? TEXTS_RETRY_MS
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? TEXTS_FETCH_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((h) => clearTimeout(h))
  }

  /** The texts spelled for OpenClaw, or null until the first copy exists. */
  get current(): Texts | null {
    return this.loaded?.texts ?? null
  }

  get source(): TextsSourceKind | null {
    return this.loaded?.source ?? null
  }

  get fetchedAt(): string | null {
    return this.loaded?.fetchedAt ?? null
  }

  /** Called with every copy that arrives from the server (not with a cached one). */
  onServerCopy(listener: (texts: Texts, source: TextsSourceKind) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** First load (server, then cache), then the timer. Resolves after the first attempt; never throws. */
  async start(): Promise<Texts | null> {
    const texts = await this.load()
    if (!texts && !this.missingAnnounced) {
      this.missingAnnounced = true
      this.logger.warn(
        { retryMs: this.retryMs },
        'AgentChat texts unreachable and nothing cached — starting anyway; turns wait for the first copy, retried until it arrives',
      )
    }
    this.arm()
    return texts
  }

  /** The current copy, or one load attempt now (coalesced with any in flight). */
  async ensure(): Promise<Texts | null> {
    if (this.loaded) return this.loaded.texts
    if (this.stopped) return null
    return this.load()
  }

  /** Force a refresh (tests, operators). Coalesced. */
  refresh(): Promise<Texts | null> {
    return this.load()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      this._clearTimeout(this.timer)
      this.timer = null
    }
    this.listeners.clear()
  }

  private load(): Promise<Texts | null> {
    if (this.inFlight) return this.inFlight
    this.inFlight = (async () => {
      this.loads += 1
      const next = await loadTexts({
        client: this.client,
        accountId: this.accountId,
        stateDir: this.stateDir,
        now: this.now,
        log: this.logger,
        timeoutMs: this.fetchTimeoutMs,
      })
      if (this.stopped) return next?.texts ?? null
      if (next) {
        const changed = this.loaded?.texts.version !== next.texts.version || this.loaded?.texts.wake_instruction !== next.texts.wake_instruction
        this.loaded = next
        if (next.source === 'server') {
          this.serverLoads += 1
          this.logger[changed ? 'info' : 'debug'](
            { version: next.texts.version, manual: next.texts.manual.version },
            'texts fetched from the server',
          )
          for (const listener of this.listeners) {
            try {
              listener(next.texts, next.source)
            } catch (err) {
              this.logger.warn({ err: describe(err) }, 'texts listener threw — continuing')
            }
          }
        }
      }
      return next?.texts ?? null
    })().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer !== null) this._clearTimeout(this.timer)
    // Nothing yet → retry soon. A cached copy → ask the server again soon
    // too, so a long-offline gateway does not run a day on stale text. A
    // server copy → the daily refresh.
    const delay = this.loaded === null ? this.retryMs : this.loaded.source === 'cache' ? this.retryMs : this.refreshMs
    this.timer = this._setTimeout(() => {
      this.timer = null
      void this.load().finally(() => this.arm())
    }, delay)
    ;(this.timer as { unref?: () => void }).unref?.()
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
