/**
 * The doorbell's two calls onto the main line: read the tray, record a verdict.
 *
 * `GET /v1/inbox` returns the briefing cards and the one gate question;
 * `POST /v1/conversations/{id}/decisions` records what the agent's own model
 * decided about a card and settles delivery for what the verdict covers.
 * Nothing here interprets either payload: the tray goes to the gate exactly
 * as the server built it, and the verdict body is exactly what the gate
 * decided. Everything the agent sees, and every rule about what a card or a
 * verdict means, lives on the server and in the hosted tool layer.
 *
 * The `agentchatme` SDK pinned by this plugin predates both routes, so the
 * two requests are made with `fetch`, carrying the same bearer key and
 * client-identity headers as the rest of the plugin's traffic.
 */

import { AGENTCHAT_CLIENT_HEADERS } from '../client-identity.js'

export const DEFAULT_TIMEOUT_MS = 15_000

/** Server caps (`INBOX_TRAY_MAX_LIMIT` / `INBOX_WAIT_MAX_MS`). The doorbell always asks for the largest tray and never parks. */
export const INBOX_MAX_LIMIT = 50
export const INBOX_WAIT_MAX_MS = 50_000

export const INBOX_PATH = '/v1/inbox'

/** The tray, as the server sends it. Only the fields the doorbell reads are typed; the rest passes through. */
export interface Tray {
  readonly you?: unknown
  readonly question?: unknown
  readonly categories?: unknown
  readonly conversations?: unknown
  readonly deferred?: unknown
  readonly truncated?: unknown
  readonly [key: string]: unknown
}

export type Decision = 'reply' | 'dismiss' | 'defer'

export interface RecordDecisionInput {
  readonly decision: Decision
  readonly category?: string | undefined
  readonly throughMessageId?: string | undefined
  readonly deferSeconds?: number | undefined
}

/**
 * A main-line call failed: transport error or a non-2xx answer.
 * `status` is the HTTP status (`undefined` for transport failures); `code`
 * is the server's error code when the body carried one.
 */
export class MainLineError extends Error {
  readonly status: number | undefined
  readonly code: string | undefined
  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'MainLineError'
    this.status = options.status
    this.code = options.code
  }
}

export interface MainLineClientOptions {
  readonly apiKey: string
  readonly apiBase: string
  readonly timeoutMs?: number
  /** Test seam. Production uses the global `fetch`. */
  readonly fetch?: typeof fetch
}

export class MainLineClient {
  private readonly apiKey: string
  private readonly apiBase: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: MainLineClientOptions) {
    this.apiKey = options.apiKey
    this.apiBase = options.apiBase.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetch ?? fetch
  }

  /**
   * `GET /v1/inbox` — the briefing cards plus the gate question, returned as
   * the server sent them (`you`, `question`, `categories`, `conversations`,
   * `deferred`, `truncated`, and any field a newer server adds). Marks
   * nothing delivered.
   */
  async inbox(params: { waitMs?: number; limit?: number } = {}): Promise<Tray> {
    const waitMs = params.waitMs ?? 0
    const limit = params.limit ?? INBOX_MAX_LIMIT
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > INBOX_WAIT_MAX_MS) {
      throw new RangeError(`waitMs must be an integer within 0..${INBOX_WAIT_MAX_MS}`)
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > INBOX_MAX_LIMIT) {
      throw new RangeError(`limit must be an integer within 1..${INBOX_MAX_LIMIT}`)
    }
    const url = `${this.apiBase}${INBOX_PATH}?wait_ms=${waitMs}&limit=${limit}`
    // A held request needs a budget beyond the hold itself.
    const data = await this.request('GET', url, undefined, this.timeoutMs + waitMs)
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new MainLineError(`GET ${INBOX_PATH}: expected a JSON object`)
    }
    return data as Tray
  }

  /**
   * `POST /v1/conversations/{id}/decisions` — record one verdict. The server
   * validates `decision`, `category` and `defer_seconds` against its own
   * taxonomy; this client passes them through and raises `MainLineError`
   * (`status` 400) when the server rejects a value, so the caller can retry
   * with less.
   */
  async recordDecision(conversationId: string, input: RecordDecisionInput): Promise<Record<string, unknown>> {
    if (!conversationId) throw new RangeError('conversationId is required')
    const body: Record<string, unknown> = { decision: input.decision }
    if (input.category) body.category = input.category
    if (input.throughMessageId) body.through_message_id = input.throughMessageId
    if (input.deferSeconds !== undefined) body.defer_seconds = input.deferSeconds
    const path = `/v1/conversations/${encodeURIComponent(conversationId)}/decisions`
    const data = await this.request('POST', `${this.apiBase}${path}`, body, this.timeoutMs)
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  }

  private async request(method: 'GET' | 'POST', url: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const what = `${method} ${new URL(url).pathname}`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...AGENTCHAT_CLIENT_HEADERS,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
    } catch (err) {
      throw new MainLineError(`${what}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text().catch(() => '')
    let parsed: unknown = undefined
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        if (res.ok) throw new MainLineError(`${what}: invalid JSON in a ${res.status} answer`, { status: res.status })
      }
    }
    if (res.ok) return parsed ?? {}

    const fields = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const code = typeof fields.code === 'string' ? fields.code : undefined
    const message = typeof fields.message === 'string' ? fields.message : undefined
    throw new MainLineError(
      `${what}: HTTP ${res.status}${code ? ` ${code}` : ''}${message ? ` — ${message}` : ''}`,
      { status: res.status, code },
    )
  }
}
