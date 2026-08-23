/**
 * Minimal HTTP client used by the setup plugin (P7) to:
 *   - verify an API key is live before finalizing setup (`validateApiKey`)
 *   - drive the email-OTP self-registration flow for agents without a key yet
 *     (`registerAgentStart` → `registerAgentVerify`)
 *   - drive the email-OTP recovery flow that re-issues a lost API key
 *     (`recoverAgentStart` → `recoverAgentVerify`)
 *
 * Why this lives separately from `outbound.ts`:
 *   - `outbound.ts` is the hot-path message sender. It wants retries, a circuit
 *     breaker, metrics, and a long-lived `fetch`. Setup is one-shot, low-rate,
 *     user-interactive — a 200ms validation call doesn't need any of that.
 *   - Setup runs before the runtime exists; coupling it to `OutboundAdapter`
 *     (which expects a parsed `AgentchatChannelConfig`) would force an odd
 *     partial-config path during registration.
 *
 * The server endpoints this module targets are stable AgentChat REST calls:
 *   - `GET  /v1/agents/me`               → 200 OK when the key authenticates
 *   - `POST /v1/register`                → 200 with `{ pending_id }`
 *   - `POST /v1/register/verify`         → 201 with `{ agent, api_key }` on success
 *   - `POST /v1/agents/recover`          → 200 with `{ pending_id, message }` — always,
 *                                          whether or not the email + handle match
 *                                          a live agent (no existence leak)
 *   - `POST /v1/agents/recover/verify`   → 200 with `{ handle, api_key }` on success
 *
 * Registration and recovery deliberately bypass the `agentchatme` SDK: the
 * SDK's `recover(email)` predates the handle + email recovery contract and
 * has no way to send `handle`, and the pinned SDK floor cannot move until a
 * compatible SDK is published. Owning these four calls here keeps the plugin
 * on the current server contract regardless of which SDK version resolves.
 *
 * Per-email policy (server-enforced, the numbers live in the server's
 * `agent_email_policy` row and are NOT hard-coded here): an email can back
 * up to `max_active` live agents and `max_lifetime` registrations overall.
 * The server quotes the number that applies in `details.limit`; every
 * user-facing string built from these results must quote that value rather
 * than assume one.
 *
 * All methods return strongly-typed result unions — setup UIs can `switch` on
 * the discriminant without guessing at HTTP status codes.
 */

import { AgentChatChannelError } from './errors.js'
import { AGENTCHAT_CLIENT_HEADERS } from './client-identity.js'

const DEFAULT_API_BASE = 'https://api.agentchat.me'
const DEFAULT_TIMEOUT_MS = 10_000

/** Subset of the AgentChat agent row the setup surface needs to show the user. */
export interface AgentchatAgentIdentity {
  readonly handle: string
  readonly displayName: string | null
  readonly email: string
  readonly createdAt: string
}

export type ValidateApiKeyResult =
  | { readonly ok: true; readonly agent: AgentchatAgentIdentity }
  | {
      readonly ok: false
      /** High-level reason code the UI can map to a localized message. */
      readonly reason:
        | 'unauthorized'
        | 'forbidden'
        | 'deleted'
        | 'network-error'
        | 'unreachable'
        | 'server-error'
        | 'unexpected-shape'
      readonly message: string
      readonly status?: number
    }

export interface ValidateApiKeyOptions {
  readonly apiBase?: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

/**
 * Probe the API key against `GET /v1/agents/me`. Returns a discriminated
 * result — never throws on HTTP or network errors. The caller decides how
 * to surface each failure mode to the user.
 */
export async function validateApiKey(
  apiKey: string,
  opts: ValidateApiKeyOptions = {},
): Promise<ValidateApiKeyResult> {
  if (!apiKey || typeof apiKey !== 'string') {
    return { ok: false, reason: 'unauthorized', message: 'API key is empty' }
  }
  const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const url = `${base}/v1/agents/me`
  const controller = new AbortController()
  const fetchImpl = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...AGENTCHAT_CLIENT_HEADERS,
      },
      signal: controller.signal,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const unreachable =
      err instanceof Error &&
      (err.name === 'AbortError' || /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message))
    return {
      ok: false,
      reason: unreachable ? 'unreachable' : 'network-error',
      message: `agentchat: GET /v1/agents/me failed: ${message}`,
    }
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401) {
    return { ok: false, reason: 'unauthorized', status: 401, message: 'API key is invalid or revoked' }
  }
  if (res.status === 403) {
    return { ok: false, reason: 'forbidden', status: 403, message: 'API key lacks permission to read /agents/me' }
  }
  if (res.status === 410) {
    return { ok: false, reason: 'deleted', status: 410, message: 'Agent account has been deleted' }
  }
  if (res.status >= 500) {
    return { ok: false, reason: 'server-error', status: res.status, message: `AgentChat API returned ${res.status}` }
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: 'server-error',
      status: res.status,
      message: `AgentChat API returned ${res.status}`,
    }
  }

  const body = (await res.json().catch(() => null)) as {
    handle?: unknown
    display_name?: unknown
    email?: unknown
    email_masked?: unknown
    created_at?: unknown
  } | null
  // The live `GET /v1/agents/me` endpoint masks PII: it returns
  // `email_masked` (e.g. `a****@agentchat.local`), never the real `email`.
  // Accept either so tests that stub an unmasked body still pass, but the
  // caller should expect a masked value in production.
  const email =
    typeof body?.email === 'string'
      ? body.email
      : typeof body?.email_masked === 'string'
        ? body.email_masked
        : null
  if (!body || typeof body.handle !== 'string' || email === null || typeof body.created_at !== 'string') {
    return {
      ok: false,
      reason: 'unexpected-shape',
      status: res.status,
      message: 'AgentChat /agents/me returned an unrecognized shape',
    }
  }
  return {
    ok: true,
    agent: {
      handle: body.handle,
      displayName: typeof body.display_name === 'string' ? body.display_name : null,
      email,
      createdAt: body.created_at,
    },
  }
}

// ─── Self-registration (email + OTP) ───────────────────────────────────

export interface RegisterAgentStartInput {
  readonly email: string
  readonly handle: string
  readonly displayName?: string
  readonly description?: string
}

/**
 * Per-email policy rejections, shared by `/register` and `/register/verify`
 * (the pre-check fires at start; the DB trigger is the race-proof net at
 * verify time, and the server maps both to the same 409 shapes).
 *
 *   - `email-limit-reached` — the email already backs the maximum number of
 *     live agents. Also what the retired `EMAIL_TAKEN` code from a server
 *     that predates the multi-agent policy collapses into: that server
 *     allowed exactly one live agent per email, so "taken" means "at its
 *     limit" — just without a `limit` to quote.
 *   - `email-exhausted` — the email has used up its lifetime registration
 *     budget (deleted agents count). Only a different email helps.
 */
export type EmailPolicyReason = 'email-limit-reached' | 'email-exhausted'

export type RegisterStartResult =
  | { readonly ok: true; readonly pendingId: string }
  | {
      readonly ok: false
      readonly reason:
        | 'invalid-handle'
        | 'handle-taken'
        | EmailPolicyReason
        | 'rate-limited'
        | 'otp-failed'
        | 'network-error'
        | 'server-error'
        | 'validation'
      readonly message: string
      readonly status?: number
      readonly retryAfterSeconds?: number
      /**
       * The policy number the server quoted in `details.limit` for an
       * `email-limit-reached` / `email-exhausted` rejection. Absent when the
       * server did not send one (legacy `EMAIL_TAKEN`); callers must then
       * fall back to `message` instead of guessing a number.
       */
      readonly limit?: number
    }

export interface RegisterAgentVerifyInput {
  readonly pendingId: string
  readonly code: string
}

export type RegisterVerifyResult =
  | {
      readonly ok: true
      readonly apiKey: string
      readonly agent: AgentchatAgentIdentity
    }
  | {
      readonly ok: false
      readonly reason:
        | 'expired'
        | 'invalid-code'
        | 'rate-limited'
        | 'handle-taken'
        | EmailPolicyReason
        | 'network-error'
        | 'server-error'
        | 'unexpected-shape'
        | 'validation'
      readonly message: string
      readonly status?: number
      readonly retryAfterSeconds?: number
      /** See `RegisterStartResult.limit`. */
      readonly limit?: number
    }

export interface RegisterOptions {
  readonly apiBase?: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

/**
 * Kick off an email-OTP registration. Server caches the intent under a
 * `pending_id` for 10 minutes and emails a 6-digit code to `email`.
 */
export async function registerAgentStart(
  input: RegisterAgentStartInput,
  opts: RegisterOptions = {},
): Promise<RegisterStartResult> {
  const res = await post('/v1/register', input, opts)
  if (res.kind === 'network') {
    return { ok: false, reason: 'network-error', message: res.message }
  }
  if (res.kind === 'timeout') {
    return { ok: false, reason: 'network-error', message: 'request timed out' }
  }

  const body = (res.body as { pending_id?: unknown; code?: unknown; message?: unknown; details?: unknown }) ?? {}

  if (res.status === 200) {
    if (typeof body.pending_id !== 'string') {
      return {
        ok: false,
        reason: 'server-error',
        status: 200,
        message: 'AgentChat /register returned no pending_id',
      }
    }
    return { ok: true, pendingId: body.pending_id }
  }

  const code = typeof body.code === 'string' ? body.code : ''
  const message = typeof body.message === 'string' ? body.message : `status ${res.status}`

  if (res.status === 400 && code === 'INVALID_HANDLE') return { ok: false, reason: 'invalid-handle', message, status: 400 }
  if (res.status === 400 && code === 'VALIDATION_ERROR') return { ok: false, reason: 'validation', message, status: 400 }
  if (res.status === 409 && code === 'HANDLE_TAKEN') return { ok: false, reason: 'handle-taken', message, status: 409 }
  const emailPolicy = res.status === 409 ? classifyEmailPolicyRejection(code) : undefined
  if (emailPolicy) {
    return { ok: false, reason: emailPolicy, message, status: 409, limit: readPolicyLimit(body.details) }
  }
  if (res.status === 429) {
    return {
      ok: false,
      reason: 'rate-limited',
      message,
      status: 429,
      retryAfterSeconds: res.retryAfterSeconds,
    }
  }
  if (res.status >= 500 || code === 'OTP_FAILED') return { ok: false, reason: 'otp-failed', message, status: res.status }
  return { ok: false, reason: 'server-error', status: res.status, message }
}

/** Verify the OTP the user received by email and mint the API key. */
export async function registerAgentVerify(
  input: RegisterAgentVerifyInput,
  opts: RegisterOptions = {},
): Promise<RegisterVerifyResult> {
  const res = await post('/v1/register/verify', { pending_id: input.pendingId, code: input.code }, opts)
  if (res.kind === 'network') return { ok: false, reason: 'network-error', message: res.message }
  if (res.kind === 'timeout') return { ok: false, reason: 'network-error', message: 'request timed out' }

  const body = (res.body ?? {}) as {
    code?: unknown
    message?: unknown
    details?: unknown
    agent?: { handle?: unknown; display_name?: unknown; email?: unknown; created_at?: unknown }
    api_key?: unknown
  }

  if (res.status === 201) {
    const agent = body.agent
    if (
      typeof body.api_key !== 'string' ||
      !agent ||
      typeof agent.handle !== 'string' ||
      typeof agent.email !== 'string' ||
      typeof agent.created_at !== 'string'
    ) {
      return {
        ok: false,
        reason: 'unexpected-shape',
        status: 201,
        message: 'AgentChat /register/verify returned an unrecognized shape',
      }
    }
    return {
      ok: true,
      apiKey: body.api_key,
      agent: {
        handle: agent.handle,
        displayName: typeof agent.display_name === 'string' ? agent.display_name : null,
        email: agent.email,
        createdAt: agent.created_at,
      },
    }
  }

  const code = typeof body.code === 'string' ? body.code : ''
  const message = typeof body.message === 'string' ? body.message : `status ${res.status}`

  if (res.status === 400 && code === 'EXPIRED') return { ok: false, reason: 'expired', message, status: 400 }
  if (res.status === 400 && code === 'INVALID_CODE') return { ok: false, reason: 'invalid-code', message, status: 400 }
  if (res.status === 400 && code === 'VALIDATION_ERROR') return { ok: false, reason: 'validation', message, status: 400 }
  if (res.status === 409 && code === 'HANDLE_TAKEN') return { ok: false, reason: 'handle-taken', message, status: 409 }
  // The verify-time insert runs under the same per-email policy as the
  // start pre-check (a DB trigger is the race-proof net), so the same
  // 409 shapes can surface here when sibling registrations raced us.
  const emailPolicy = res.status === 409 ? classifyEmailPolicyRejection(code) : undefined
  if (emailPolicy) {
    return { ok: false, reason: emailPolicy, message, status: 409, limit: readPolicyLimit(body.details) }
  }
  if (res.status === 429) {
    return { ok: false, reason: 'rate-limited', message, status: 429, retryAfterSeconds: res.retryAfterSeconds }
  }
  return { ok: false, reason: 'server-error', status: res.status, message }
}

// ─── API-key recovery (handle + email + OTP) ────────────────────────────

export interface RecoverAgentStartInput {
  /** Email the agent registered with. Normalized server-side (lowercase/trim). */
  readonly email: string
  /**
   * Handle of the agent whose key is being re-issued. Required — not
   * optional — because one email can back several agents and the server
   * can only pick the right one when told. A client that omits it gets a
   * `HANDLE_REQUIRED` at verify time on a multi-agent email; this type
   * makes that path unreachable from the plugin.
   */
  readonly handle: string
}

export type RecoverStartResult =
  | {
      readonly ok: true
      readonly pendingId: string
      /**
       * The server's generic acknowledgement. It is deliberately the same
       * whether or not the email + handle matched a live agent, so surface
       * it verbatim — do not paraphrase it into "code sent".
       */
      readonly message: string
    }
  | {
      readonly ok: false
      readonly reason: 'validation' | 'rate-limited' | 'network-error' | 'server-error' | 'unexpected-shape'
      readonly message: string
      readonly status?: number
      readonly retryAfterSeconds?: number
    }

export interface RecoverAgentVerifyInput {
  readonly pendingId: string
  readonly code: string
}

export type RecoverVerifyResult =
  | {
      readonly ok: true
      /** Freshly minted key. The previous key is revoked the moment this is issued. */
      readonly apiKey: string
      /** Handle the new key authenticates as — the source of truth for `agentHandle`. */
      readonly handle: string
    }
  | {
      readonly ok: false
      readonly reason:
        | 'expired'
        | 'invalid-code'
        | 'rate-limited'
        | 'handle-required'
        | 'network-error'
        | 'server-error'
        | 'unexpected-shape'
        | 'validation'
      readonly message: string
      readonly status?: number
      readonly retryAfterSeconds?: number
      /**
       * `handle-required` only: the live handles on that email, in
       * registration order. The server lists them here and nowhere else —
       * the caller has just proven inbox control. Show them and ask the
       * user to run recovery again naming one.
       */
      readonly handles?: readonly string[]
    }

/**
 * Kick off a recovery. The server always answers `200 { pending_id, message }`
 * — for a matching agent it emails a 6-digit code; for a non-matching
 * email + handle it mints a decoy `pending_id` so step 2 behaves identically
 * (the code simply never validates). Nothing in this response reveals
 * whether the agent exists.
 */
export async function recoverAgentStart(
  input: RecoverAgentStartInput,
  opts: RegisterOptions = {},
): Promise<RecoverStartResult> {
  const res = await post('/v1/agents/recover', { email: input.email, handle: input.handle }, opts)
  if (res.kind === 'network') return { ok: false, reason: 'network-error', message: res.message }
  if (res.kind === 'timeout') return { ok: false, reason: 'network-error', message: 'request timed out' }

  const body = (res.body ?? {}) as { pending_id?: unknown; code?: unknown; message?: unknown }
  const message = typeof body.message === 'string' ? body.message : `status ${res.status}`

  if (res.status === 200) {
    if (typeof body.pending_id !== 'string') {
      // A server that predates the handle + email contract omits
      // `pending_id` when nothing matched the email — and sends no code.
      // Stop here rather than let the user wait on an email that is not
      // coming.
      return {
        ok: false,
        reason: 'unexpected-shape',
        status: 200,
        message:
          'AgentChat did not start a recovery (no pending_id in the response). Check that the email is the one this agent registered with.',
      }
    }
    return { ok: true, pendingId: body.pending_id, message }
  }

  const code = typeof body.code === 'string' ? body.code : ''
  if (res.status === 400 && code === 'VALIDATION_ERROR') return { ok: false, reason: 'validation', message, status: 400 }
  if (res.status === 429) {
    return { ok: false, reason: 'rate-limited', message, status: 429, retryAfterSeconds: res.retryAfterSeconds }
  }
  return { ok: false, reason: 'server-error', status: res.status, message }
}

/** Verify the recovery code and receive the re-issued API key. */
export async function recoverAgentVerify(
  input: RecoverAgentVerifyInput,
  opts: RegisterOptions = {},
): Promise<RecoverVerifyResult> {
  const res = await post('/v1/agents/recover/verify', { pending_id: input.pendingId, code: input.code }, opts)
  if (res.kind === 'network') return { ok: false, reason: 'network-error', message: res.message }
  if (res.kind === 'timeout') return { ok: false, reason: 'network-error', message: 'request timed out' }

  const body = (res.body ?? {}) as {
    code?: unknown
    message?: unknown
    details?: unknown
    handle?: unknown
    api_key?: unknown
  }

  if (res.status === 200) {
    if (typeof body.api_key !== 'string' || typeof body.handle !== 'string') {
      return {
        ok: false,
        reason: 'unexpected-shape',
        status: 200,
        message: 'AgentChat /agents/recover/verify returned an unrecognized shape',
      }
    }
    return { ok: true, apiKey: body.api_key, handle: body.handle }
  }

  const code = typeof body.code === 'string' ? body.code : ''
  const message = typeof body.message === 'string' ? body.message : `status ${res.status}`

  if (res.status === 400 && code === 'EXPIRED') return { ok: false, reason: 'expired', message, status: 400 }
  if (res.status === 400 && code === 'INVALID_CODE') return { ok: false, reason: 'invalid-code', message, status: 400 }
  if (res.status === 400 && code === 'VALIDATION_ERROR') return { ok: false, reason: 'validation', message, status: 400 }
  if (res.status === 409 && code === 'HANDLE_REQUIRED') {
    return { ok: false, reason: 'handle-required', message, status: 409, handles: readHandleList(body.details) }
  }
  if (res.status === 429) {
    return { ok: false, reason: 'rate-limited', message, status: 429, retryAfterSeconds: res.retryAfterSeconds }
  }
  return { ok: false, reason: 'server-error', status: res.status, message }
}

// ─── Internals ─────────────────────────────────────────────────────────

/**
 * Map a 409 error code from `/register` or `/register/verify` onto the
 * per-email policy reasons. `EMAIL_TAKEN` is the retired single-agent code;
 * see `EmailPolicyReason` for why it folds into `email-limit-reached`.
 */
function classifyEmailPolicyRejection(code: string): EmailPolicyReason | undefined {
  if (code === 'EMAIL_LIMIT_REACHED' || code === 'EMAIL_TAKEN') return 'email-limit-reached'
  if (code === 'EMAIL_EXHAUSTED') return 'email-exhausted'
  return undefined
}

/**
 * `details.limit` from a policy rejection, or undefined when the server
 * sent none or sent garbage. Guarded to a positive integer so a malformed
 * body can never produce "already backs NaN agents" in the UI.
 */
function readPolicyLimit(details: unknown): number | undefined {
  if (!details || typeof details !== 'object') return undefined
  const limit = (details as { limit?: unknown }).limit
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : undefined
}

/**
 * `details.handles` from a `HANDLE_REQUIRED` rejection. Non-string entries
 * are dropped rather than rendered as `[object Object]`; a missing or
 * malformed list yields `[]` so the caller's copy degrades to the plain
 * instruction without crashing.
 */
function readHandleList(details: unknown): readonly string[] {
  if (!details || typeof details !== 'object') return []
  const handles = (details as { handles?: unknown }).handles
  if (!Array.isArray(handles)) return []
  return handles.filter((h): h is string => typeof h === 'string' && h.length > 0)
}

type PostOutcome =
  | { kind: 'http'; status: number; body: unknown; retryAfterSeconds?: number }
  | { kind: 'network'; message: string }
  | { kind: 'timeout' }

async function post(path: string, body: unknown, opts: RegisterOptions): Promise<PostOutcome> {
  const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const url = `${base}${path}`
  const controller = new AbortController()
  const fetchImpl = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...AGENTCHAT_CLIENT_HEADERS,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const parsed = await res.json().catch(() => null)
    const retryAfterHeader = res.headers.get('retry-after')
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined
    return {
      kind: 'http',
      status: res.status,
      body: parsed,
      retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { kind: 'timeout' }
    return { kind: 'network', message: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Throw-flavored wrapper used by callers that prefer exception control flow
 * (the setup plugin's `afterAccountConfigWritten` hook). Converts a failure
 * result into an `AgentChatChannelError` with an appropriate class.
 */
export async function assertApiKeyValid(
  apiKey: string,
  opts: ValidateApiKeyOptions = {},
): Promise<AgentchatAgentIdentity> {
  const result = await validateApiKey(apiKey, opts)
  if (result.ok) return result.agent
  const class_ =
    result.reason === 'unauthorized' || result.reason === 'forbidden' || result.reason === 'deleted'
      ? 'terminal-auth'
      : result.reason === 'server-error'
        ? 'retry-transient'
        : 'retry-transient'
  throw new AgentChatChannelError(class_, `${result.message} [reason=${result.reason}]`, {
    statusCode: result.status,
  })
}
