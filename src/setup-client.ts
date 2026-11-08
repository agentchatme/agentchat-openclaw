/**
 * Setup calls, through the `agentchatme` SDK:
 *   - verify an API key is live before finalizing setup (`validateApiKey`,
 *     `client.getMe()` → `GET /v1/agents/me`)
 *   - the email-OTP self-registration for agents without a key yet
 *     (`registerAgentStart` → `registerAgentVerify`; `AgentChatClient.register`
 *     / `.verify` → `POST /v1/register`, `/v1/register/verify`)
 *   - the email-OTP recovery that re-issues a lost API key
 *     (`recoverAgentStart` → `recoverAgentVerify`; `AgentChatClient.recover`
 *     with `handle` / `.recoverVerify` → `POST /v1/agents/recover`,
 *     `/v1/agents/recover/verify`). The server answers recovery with the same
 *     `{ pending_id, message }` whether or not the email + handle match a
 *     live agent (no existence leak).
 *
 * This module holds no HTTP of its own: it turns the SDK's typed results
 * and errors into result unions a setup UI can `switch` on without
 * guessing at status codes. Every call is made once (`retry: never` in the
 * SDK for these routes; one attempt for the key check) — setup is
 * interactive, and a retry would only send a second email.
 *
 * Per-email policy (server-enforced, the numbers live in the server's
 * `agent_email_policy` row and are NOT hard-coded here): an email can back
 * up to `max_active` live agents and `max_lifetime` registrations overall.
 * The server quotes the number that applies in `details.limit`; every
 * user-facing string built from these results must quote that value rather
 * than assume one.
 */

import { AgentChatClient, AgentChatError, RateLimitedError } from 'agentchatme'

import { AgentChatChannelError } from './errors.js'
import { AGENTCHAT_CLIENT_IDENTITY } from './client-identity.js'

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
  const client = new AgentChatClient({
    apiKey,
    baseUrl: apiBaseOf(opts.apiBase),
    clientIdentity: AGENTCHAT_CLIENT_IDENTITY,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retry: ONE_ATTEMPT,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })

  let me: unknown
  try {
    me = await client.getMe()
  } catch (err) {
    const failure = describeFailure(err)
    if (failure.kind === 'network') {
      const unreachable = failure.timedOut || /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(failure.message)
      return {
        ok: false,
        reason: unreachable ? 'unreachable' : 'network-error',
        message: `agentchat: GET /v1/agents/me failed: ${failure.message}`,
      }
    }
    const status = failure.status
    if (status === 401) return { ok: false, reason: 'unauthorized', status, message: 'API key is invalid or revoked' }
    if (status === 403) return { ok: false, reason: 'forbidden', status, message: 'API key lacks permission to read /agents/me' }
    if (status === 410) return { ok: false, reason: 'deleted', status, message: 'Agent account has been deleted' }
    return { ok: false, reason: 'server-error', status, message: `AgentChat API returned ${status}` }
  }

  const body = asRecord(me)
  // The live `GET /v1/agents/me` endpoint masks PII: it returns
  // `email_masked` (e.g. `a****@agentchat.local`), never the real `email`.
  // Accept either so tests that stub an unmasked body still pass, but the
  // caller should expect a masked value in production.
  const email = typeof body?.email === 'string' ? body.email : typeof body?.email_masked === 'string' ? body.email_masked : null
  if (!body || typeof body.handle !== 'string' || email === null || typeof body.created_at !== 'string') {
    return { ok: false, reason: 'unexpected-shape', status: 200, message: 'AgentChat /agents/me returned an unrecognized shape' }
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

/**
 * Options for the registration and recovery calls. The SDK makes these
 * calls with its own transport (the runtime's `fetch`, its default timeout);
 * its static `register` / `verify` / `recover` / `recoverVerify` take no
 * `fetch` or timeout of their own, so neither is offered here.
 */
export interface RegisterOptions {
  readonly apiBase?: string
}

/**
 * Kick off an email-OTP registration. Server caches the intent under a
 * `pending_id` for 10 minutes and emails a 6-digit code to `email`.
 */
export async function registerAgentStart(
  input: RegisterAgentStartInput,
  opts: RegisterOptions = {},
): Promise<RegisterStartResult> {
  let data: unknown
  try {
    data = await AgentChatClient.register({
      email: input.email,
      handle: input.handle,
      ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      baseUrl: apiBaseOf(opts.apiBase),
      clientIdentity: AGENTCHAT_CLIENT_IDENTITY,
    })
  } catch (err) {
    const failure = describeFailure(err)
    if (failure.kind === 'network') return { ok: false, reason: 'network-error', message: networkMessage(failure) }
    const { status, code, message } = failure
    if (status === 400 && code === 'INVALID_HANDLE') return { ok: false, reason: 'invalid-handle', message, status }
    if (status === 400 && code === 'VALIDATION_ERROR') return { ok: false, reason: 'validation', message, status }
    if (status === 409 && code === 'HANDLE_TAKEN') return { ok: false, reason: 'handle-taken', message, status }
    const emailPolicy = status === 409 ? classifyEmailPolicyRejection(code) : undefined
    if (emailPolicy) return { ok: false, reason: emailPolicy, message, status, limit: readPolicyLimit(failure.details) }
    if (status === 429) return { ok: false, reason: 'rate-limited', message, status, retryAfterSeconds: failure.retryAfterSeconds }
    if (status >= 500 || code === 'OTP_FAILED') return { ok: false, reason: 'otp-failed', message, status }
    return { ok: false, reason: 'server-error', status, message }
  }
  const pendingId = asRecord(data)?.pending_id
  if (typeof pendingId !== 'string') {
    return { ok: false, reason: 'server-error', status: 200, message: 'AgentChat /register returned no pending_id' }
  }
  return { ok: true, pendingId }
}

/** Verify the OTP the user received by email and mint the API key. */
export async function registerAgentVerify(
  input: RegisterAgentVerifyInput,
  opts: RegisterOptions = {},
): Promise<RegisterVerifyResult> {
  let verified: { agent: unknown; apiKey: unknown }
  try {
    verified = await AgentChatClient.verify(input.pendingId, input.code, {
      baseUrl: apiBaseOf(opts.apiBase),
      clientIdentity: AGENTCHAT_CLIENT_IDENTITY,
    })
  } catch (err) {
    const failure = describeFailure(err)
    if (failure.kind === 'network') return { ok: false, reason: 'network-error', message: networkMessage(failure) }
    const { status, code, message } = failure
    if (status === 400 && code === 'EXPIRED') return { ok: false, reason: 'expired', message, status }
    if (status === 400 && code === 'INVALID_CODE') return { ok: false, reason: 'invalid-code', message, status }
    if (status === 400 && code === 'VALIDATION_ERROR') return { ok: false, reason: 'validation', message, status }
    if (status === 409 && code === 'HANDLE_TAKEN') return { ok: false, reason: 'handle-taken', message, status }
    // The verify-time insert runs under the same per-email policy as the
    // start pre-check (a DB trigger is the race-proof net), so the same
    // 409 shapes can surface here when sibling registrations raced us.
    const emailPolicy = status === 409 ? classifyEmailPolicyRejection(code) : undefined
    if (emailPolicy) return { ok: false, reason: emailPolicy, message, status, limit: readPolicyLimit(failure.details) }
    if (status === 429) return { ok: false, reason: 'rate-limited', message, status, retryAfterSeconds: failure.retryAfterSeconds }
    return { ok: false, reason: 'server-error', status, message }
  }
  const agent = asRecord(verified.agent)
  if (
    typeof verified.apiKey !== 'string' ||
    !agent ||
    typeof agent.handle !== 'string' ||
    typeof agent.email !== 'string' ||
    typeof agent.created_at !== 'string'
  ) {
    return { ok: false, reason: 'unexpected-shape', status: 201, message: 'AgentChat /register/verify returned an unrecognized shape' }
  }
  return {
    ok: true,
    apiKey: verified.apiKey,
    agent: {
      handle: agent.handle,
      displayName: typeof agent.display_name === 'string' ? agent.display_name : null,
      email: agent.email,
      createdAt: agent.created_at,
    },
  }
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
  let data: unknown
  try {
    data = await AgentChatClient.recover(input.email, {
      handle: input.handle,
      baseUrl: apiBaseOf(opts.apiBase),
      clientIdentity: AGENTCHAT_CLIENT_IDENTITY,
    })
  } catch (err) {
    const failure = describeFailure(err)
    if (failure.kind === 'network') return { ok: false, reason: 'network-error', message: networkMessage(failure) }
    const { status, code, message } = failure
    if (status === 400 && code === 'VALIDATION_ERROR') return { ok: false, reason: 'validation', message, status }
    if (status === 429) return { ok: false, reason: 'rate-limited', message, status, retryAfterSeconds: failure.retryAfterSeconds }
    return { ok: false, reason: 'server-error', status, message }
  }
  const body = asRecord(data)
  const message = typeof body?.message === 'string' ? body.message : 'status 200'
  if (typeof body?.pending_id !== 'string') {
    // A server that predates the handle + email contract omits
    // `pending_id` when nothing matched the email — and sends no code.
    // Stop here rather than let the user wait on an email that is not
    // coming.
    return {
      ok: false,
      reason: 'unexpected-shape',
      status: 200,
      message: 'AgentChat did not start a recovery (no pending_id in the response). Check that the email is the one this agent registered with.',
    }
  }
  return { ok: true, pendingId: body.pending_id, message }
}

/** Verify the recovery code and receive the re-issued API key. */
export async function recoverAgentVerify(
  input: RecoverAgentVerifyInput,
  opts: RegisterOptions = {},
): Promise<RecoverVerifyResult> {
  let recovered: { handle: unknown; apiKey: unknown }
  try {
    recovered = await AgentChatClient.recoverVerify(input.pendingId, input.code, {
      baseUrl: apiBaseOf(opts.apiBase),
      clientIdentity: AGENTCHAT_CLIENT_IDENTITY,
    })
  } catch (err) {
    const failure = describeFailure(err)
    if (failure.kind === 'network') return { ok: false, reason: 'network-error', message: networkMessage(failure) }
    const { status, code, message } = failure
    if (status === 400 && code === 'EXPIRED') return { ok: false, reason: 'expired', message, status }
    if (status === 400 && code === 'INVALID_CODE') return { ok: false, reason: 'invalid-code', message, status }
    if (status === 400 && code === 'VALIDATION_ERROR') return { ok: false, reason: 'validation', message, status }
    if (status === 409 && code === 'HANDLE_REQUIRED') {
      return { ok: false, reason: 'handle-required', message, status, handles: readHandleList(failure.details) }
    }
    if (status === 429) return { ok: false, reason: 'rate-limited', message, status, retryAfterSeconds: failure.retryAfterSeconds }
    return { ok: false, reason: 'server-error', status, message }
  }
  if (typeof recovered.apiKey !== 'string' || typeof recovered.handle !== 'string') {
    return { ok: false, reason: 'unexpected-shape', status: 200, message: 'AgentChat /agents/recover/verify returned an unrecognized shape' }
  }
  return { ok: true, apiKey: recovered.apiKey, handle: recovered.handle }
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

/** One attempt, no back-off: setup is interactive and the caller shows the failure. */
const ONE_ATTEMPT = { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } as const

function apiBaseOf(apiBase: string | undefined): string {
  return (apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
}

/** What a failed SDK call came to: the server answered (`http`), or it could not be reached (`network`). */
type Failure =
  | {
      readonly kind: 'http'
      readonly status: number
      readonly code: string
      readonly message: string
      readonly details: unknown
      readonly retryAfterSeconds?: number
    }
  | { readonly kind: 'network'; readonly message: string; readonly timedOut: boolean }

/**
 * Read an error thrown by the SDK. An `AgentChatError` carries the server's
 * status, code, message and details; a body the SDK could not read as an
 * error (no `code` + `message`) sits under `details.body`, and its code and
 * message are taken from there. Anything else — the SDK's
 * `ConnectionError`, its own request timeout, a thrown `fetch` — is a
 * network failure.
 */
function describeFailure(err: unknown): Failure {
  if (err instanceof AgentChatError) {
    const raw = asRecord(asRecord(err.details)?.body)
    const code = typeof raw?.code === 'string' ? raw.code : String(err.code ?? '')
    const message = raw ? (typeof raw.message === 'string' ? raw.message : `status ${err.status}`) : err.message || `status ${err.status}`
    const retryAfterMs = err instanceof RateLimitedError ? err.retryAfterMs : null
    return {
      kind: 'http',
      status: err.status,
      code,
      message,
      details: raw ? raw.details : err.details,
      ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) } : {}),
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  const timedOut = (err instanceof Error && err.name === 'AbortError') || /timed out|abort/i.test(message)
  return { kind: 'network', message, timedOut }
}

function networkMessage(failure: Extract<Failure, { kind: 'network' }>): string {
  return failure.timedOut ? 'request timed out' : failure.message
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
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
