/**
 * Tests for the setup HTTP client (P7).
 *
 * All network calls are stubbed via a fetch mock. We cover:
 *   - validateApiKey: success, 401/403/410/5xx, network/timeout, bad shape
 *   - registerAgentStart: success, 409 HANDLE_TAKEN, the per-email policy
 *     rejections (EMAIL_LIMIT_REACHED / EMAIL_EXHAUSTED quoting
 *     `details.limit`, legacy EMAIL_TAKEN folded into email-limit-reached),
 *     429 rate-limit with Retry-After, OTP_FAILED 500
 *   - registerAgentVerify: success, 400 EXPIRED / INVALID_CODE, 429,
 *     shape validation (missing api_key), 409 HANDLE_TAKEN, verify-time
 *     per-email policy rejections (the DB trigger path)
 *   - recoverAgentStart: always sends handle + email, the constant
 *     `{ pending_id, message }` 200, legacy no-pending_id 200, 400/429,
 *     network/timeout
 *   - recoverAgentVerify: success `{ handle, api_key }`, 400 EXPIRED /
 *     INVALID_CODE, 409 HANDLE_REQUIRED with `details.handles`, 429,
 *     shape validation
 *   - assertApiKeyValid throws AgentChatChannelError with the right class
 */

import { describe, it, expect } from 'vitest'
import { AgentChatChannelError } from '../src/errors.js'
import { PACKAGE_VERSION } from '../src/version.js'
import {
  validateApiKey,
  assertApiKeyValid,
  registerAgentStart,
  registerAgentVerify,
  recoverAgentStart,
  recoverAgentVerify,
} from '../src/setup-client.js'

interface StubResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

function makeFetch(responses: StubResponse[] | ((url: string, init?: RequestInit) => StubResponse | Error)) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url)
    calls.push({ url: urlStr, init })
    const r =
      typeof responses === 'function'
        ? responses(urlStr, init)
        : i < responses.length
          ? responses[i++]!
          : new Error('stub exhausted')
    if (r instanceof Error) throw r
    const headers = new Headers(r.headers ?? {})
    return new Response(
      typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      { status: r.status, headers },
    )
  }
  return Object.assign(fn, { calls })
}

const VALID_KEY = 'ac_' + 'x'.repeat(40)

describe('validateApiKey', () => {
  it('returns ok:true with agent identity on 200', async () => {
    const fetchStub = makeFetch([
      {
        status: 200,
        body: {
          handle: 'alice',
          display_name: 'Alice Agent',
          email: 'alice@example.com',
          created_at: '2026-04-19T00:00:00Z',
        },
      },
    ])
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.agent.handle).toBe('alice')
      expect(res.agent.displayName).toBe('Alice Agent')
    }
    expect(fetchStub.calls[0]?.url).toContain('/v1/agents/me')
    const headers = fetchStub.calls[0]?.init?.headers as Record<string, string>
    expect(headers?.Authorization).toBe(`Bearer ${VALID_KEY}`)
    expect(headers?.['X-AgentChat-Client']).toBe('openclaw')
    expect(headers?.['X-AgentChat-Client-Version']).toBe(PACKAGE_VERSION)
  })

  it('honors apiBase override and strips trailing slash', async () => {
    const fetchStub = makeFetch([
      {
        status: 200,
        body: { handle: 'a', email: 'a@b.co', created_at: '2026-04-19T00:00:00Z' },
      },
    ])
    await validateApiKey(VALID_KEY, { fetch: fetchStub, apiBase: 'https://stage.agentchat.me/' })
    expect(fetchStub.calls[0]?.url).toBe('https://stage.agentchat.me/v1/agents/me')
  })

  it('classifies 401 as unauthorized', async () => {
    const fetchStub = makeFetch([{ status: 401, body: { code: 'UNAUTHORIZED' } }])
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unauthorized')
  })

  it('classifies 403 as forbidden', async () => {
    const fetchStub = makeFetch([{ status: 403, body: {} }])
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('forbidden')
  })

  it('classifies 410 as deleted', async () => {
    const fetchStub = makeFetch([{ status: 410, body: {} }])
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('deleted')
  })

  it('classifies 500 as server-error', async () => {
    const fetchStub = makeFetch([{ status: 502, body: 'bad gateway' }])
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('server-error')
      expect(res.status).toBe(502)
    }
  })

  it('flags unexpected success shape (missing handle)', async () => {
    const fetchStub = makeFetch([{ status: 200, body: { email: 'x@y.co', created_at: 'now' } }])
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unexpected-shape')
  })

  it('classifies ECONNREFUSED as unreachable', async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:443')
    const fetchStub = makeFetch(() => err)
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unreachable')
  })

  it('classifies AbortError (timeout) as unreachable', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const fetchStub = makeFetch(() => err)
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unreachable')
  })

  it('rejects empty api key without hitting network', async () => {
    const fetchStub = makeFetch([])
    const res = await validateApiKey('', { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unauthorized')
    expect(fetchStub.calls).toHaveLength(0)
  })
})

describe('assertApiKeyValid', () => {
  it('returns agent on success', async () => {
    const fetchStub = makeFetch([
      {
        status: 200,
        body: { handle: 'a', email: 'a@b.co', created_at: '2026-04-19T00:00:00Z' },
      },
    ])
    const agent = await assertApiKeyValid(VALID_KEY, { fetch: fetchStub })
    expect(agent.handle).toBe('a')
  })

  it('throws terminal-auth on 401', async () => {
    const fetchStub = makeFetch([{ status: 401, body: {} }])
    await expect(assertApiKeyValid(VALID_KEY, { fetch: fetchStub })).rejects.toMatchObject({
      class_: 'terminal-auth',
    })
  })

  it('throws retry-transient on 500', async () => {
    const fetchStub = makeFetch([{ status: 500, body: {} }])
    await expect(assertApiKeyValid(VALID_KEY, { fetch: fetchStub })).rejects.toBeInstanceOf(
      AgentChatChannelError,
    )
  })
})

describe('registerAgentStart', () => {
  it('returns pendingId on 200', async () => {
    const fetchStub = makeFetch([{ status: 200, body: { pending_id: 'pnd_abc123' } }])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.pendingId).toBe('pnd_abc123')
    const headers = new Headers(fetchStub.calls[0]?.init?.headers)
    expect(headers.get('x-agentchat-client')).toBe('openclaw')
    expect(headers.get('x-agentchat-client-version')).toBe(PACKAGE_VERSION)
  })

  it('classifies HANDLE_TAKEN', async () => {
    const fetchStub = makeFetch([
      { status: 409, body: { code: 'HANDLE_TAKEN', message: 'Handle @alice is already taken' } },
    ])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('handle-taken')
  })

  it('classifies EMAIL_LIMIT_REACHED and carries the server-quoted limit', async () => {
    const fetchStub = makeFetch([
      {
        status: 409,
        body: {
          code: 'EMAIL_LIMIT_REACHED',
          message: 'This email already backs 10 active agents. Delete one, or register with a different email.',
          details: { limit: 10 },
        },
      },
    ])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('email-limit-reached')
      expect(res.status).toBe(409)
      expect(res.limit).toBe(10)
      expect(res.message).toContain('10 active agents')
    }
  })

  it('classifies EMAIL_EXHAUSTED and carries the server-quoted lifetime limit', async () => {
    const fetchStub = makeFetch([
      {
        status: 409,
        body: {
          code: 'EMAIL_EXHAUSTED',
          message: 'This email has reached the maximum of 30 account registrations.',
          details: { limit: 30 },
        },
      },
    ])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('email-exhausted')
      expect(res.limit).toBe(30)
    }
  })

  it('folds legacy EMAIL_TAKEN (pre-policy server) into email-limit-reached with no limit', async () => {
    const fetchStub = makeFetch([
      {
        status: 409,
        body: {
          code: 'EMAIL_TAKEN',
          message: 'An account is already registered with this email. Delete it first to create a new one.',
        },
      },
    ])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('email-limit-reached')
      expect(res.limit).toBeUndefined()
      // The server message is the fallback copy — it must survive intact.
      expect(res.message).toBe(
        'An account is already registered with this email. Delete it first to create a new one.',
      )
    }
  })

  it('never surfaces a malformed details.limit (string / zero / fraction / missing)', async () => {
    for (const details of [
      { limit: '10' },
      { limit: 0 },
      { limit: 2.5 },
      { limit: -1 },
      {},
      null,
      'garbage',
    ]) {
      const fetchStub = makeFetch([
        { status: 409, body: { code: 'EMAIL_LIMIT_REACHED', message: 'limit', details } },
      ])
      const res = await registerAgentStart(
        { email: 'alice@example.com', handle: 'alice' },
        { fetch: fetchStub },
      )
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.reason).toBe('email-limit-reached')
        expect(res.limit).toBeUndefined()
      }
    }
  })

  it('does not treat EMAIL_LIMIT_REACHED on a non-409 status as a policy rejection', async () => {
    // Defensive: the policy reasons are 409-only on the server. A 500 that
    // happens to echo the code must not be presented as "at limit".
    const fetchStub = makeFetch([
      { status: 500, body: { code: 'EMAIL_LIMIT_REACHED', message: 'boom', details: { limit: 10 } } },
    ])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).not.toBe('email-limit-reached')
  })

  it('honors Retry-After on 429', async () => {
    const fetchStub = makeFetch([
      {
        status: 429,
        body: { code: 'OTP_COOLDOWN', message: 'wait a minute' },
        headers: { 'retry-after': '60' },
      },
    ])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('rate-limited')
      expect(res.retryAfterSeconds).toBe(60)
    }
  })

  it('classifies OTP_FAILED as otp-failed', async () => {
    const fetchStub = makeFetch([{ status: 500, body: { code: 'OTP_FAILED' } }])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('otp-failed')
  })

  it('returns network-error on fetch throw', async () => {
    const fetchStub = makeFetch(() => new Error('ECONNRESET'))
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('network-error')
  })
})

describe('registerAgentVerify', () => {
  it('returns apiKey + agent on 201', async () => {
    const fetchStub = makeFetch([
      {
        status: 201,
        body: {
          api_key: 'ac_new_' + 'y'.repeat(40),
          agent: {
            handle: 'alice',
            display_name: 'Alice',
            email: 'alice@example.com',
            created_at: '2026-04-19T00:00:00Z',
          },
        },
      },
    ])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.apiKey.startsWith('ac_new_')).toBe(true)
      expect(res.agent.handle).toBe('alice')
    }
  })

  it('classifies EXPIRED', async () => {
    const fetchStub = makeFetch([{ status: 400, body: { code: 'EXPIRED', message: 'expired' } }])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('expired')
  })

  it('classifies INVALID_CODE', async () => {
    const fetchStub = makeFetch([{ status: 400, body: { code: 'INVALID_CODE' } }])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: 'bad' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid-code')
  })

  it('flags unexpected success shape (missing api_key)', async () => {
    const fetchStub = makeFetch([
      {
        status: 201,
        body: {
          agent: {
            handle: 'a',
            email: 'a@b.co',
            created_at: '2026-04-19T00:00:00Z',
          },
        },
      },
    ])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unexpected-shape')
  })

  it('classifies race-window HANDLE_TAKEN from 409', async () => {
    const fetchStub = makeFetch([{ status: 409, body: { code: 'HANDLE_TAKEN' } }])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('handle-taken')
  })

  it('classifies verify-time EMAIL_LIMIT_REACHED (DB trigger) with the quoted limit', async () => {
    const fetchStub = makeFetch([
      {
        status: 409,
        body: { code: 'EMAIL_LIMIT_REACHED', message: 'at limit', details: { limit: 10 } },
      },
    ])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('email-limit-reached')
      expect(res.limit).toBe(10)
    }
  })

  it('classifies verify-time EMAIL_EXHAUSTED (DB trigger)', async () => {
    const fetchStub = makeFetch([
      {
        status: 409,
        body: { code: 'EMAIL_EXHAUSTED', message: 'exhausted', details: { limit: 30 } },
      },
    ])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('email-exhausted')
      expect(res.limit).toBe(30)
    }
  })

  it('folds verify-time legacy EMAIL_TAKEN into email-limit-reached', async () => {
    const fetchStub = makeFetch([
      { status: 409, body: { code: 'EMAIL_TAKEN', message: 'An account was already registered with this email' } },
    ])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('email-limit-reached')
      expect(res.limit).toBeUndefined()
    }
  })
})

describe('recoverAgentStart', () => {
  it('POSTs handle + email to /v1/agents/recover and returns pendingId + the server message', async () => {
    const fetchStub = makeFetch([
      {
        status: 200,
        body: {
          pending_id: 'pnd_rec1',
          message: 'If an account is registered with this email, a verification code has been sent.',
        },
      },
    ])
    const res = await recoverAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.pendingId).toBe('pnd_rec1')
      expect(res.message).toBe(
        'If an account is registered with this email, a verification code has been sent.',
      )
    }
    const call = fetchStub.calls[0]!
    expect(call.url).toBe('https://api.agentchat.me/v1/agents/recover')
    expect(call.init?.method).toBe('POST')
    // The contract: handle is ALWAYS sent alongside email.
    expect(JSON.parse(String(call.init?.body))).toEqual({ email: 'alice@example.com', handle: 'alice' })
    const headers = new Headers(call.init?.headers)
    expect(headers.get('x-agentchat-client')).toBe('openclaw')
    expect(headers.get('x-agentchat-client-version')).toBe(PACKAGE_VERSION)
  })

  it('honors apiBase override', async () => {
    const fetchStub = makeFetch([{ status: 200, body: { pending_id: 'pnd_x', message: 'ok' } }])
    await recoverAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub, apiBase: 'https://stage.agentchat.me/' },
    )
    expect(fetchStub.calls[0]?.url).toBe('https://stage.agentchat.me/v1/agents/recover')
  })

  it('stops early on a legacy 200 without pending_id (no code is coming)', async () => {
    const fetchStub = makeFetch([
      { status: 200, body: { message: 'If an account is registered with this email, a verification code has been sent.' } },
    ])
    const res = await recoverAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('unexpected-shape')
      expect(res.status).toBe(200)
      expect(res.message).toMatch(/no pending_id/)
    }
  })

  it('classifies 400 VALIDATION_ERROR', async () => {
    const fetchStub = makeFetch([
      { status: 400, body: { code: 'VALIDATION_ERROR', message: 'Invalid request' } },
    ])
    const res = await recoverAgentStart(
      { email: 'not-an-email', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('validation')
      expect(res.status).toBe(400)
    }
  })

  it('honors Retry-After on 429', async () => {
    const fetchStub = makeFetch([
      {
        status: 429,
        body: { code: 'RATE_LIMITED', message: 'slow down' },
        headers: { 'retry-after': '3600' },
      },
    ])
    const res = await recoverAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('rate-limited')
      expect(res.retryAfterSeconds).toBe(3600)
    }
  })

  it('classifies 5xx as server-error with the server message', async () => {
    const fetchStub = makeFetch([{ status: 503, body: { message: 'maintenance' } }])
    const res = await recoverAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('server-error')
      expect(res.status).toBe(503)
      expect(res.message).toBe('maintenance')
    }
  })

  it('returns network-error on fetch throw and on timeout', async () => {
    const thrown = await recoverAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: makeFetch(() => new Error('ECONNRESET')) },
    )
    expect(thrown.ok).toBe(false)
    if (!thrown.ok) expect(thrown.reason).toBe('network-error')

    const aborted = await recoverAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: makeFetch(() => Object.assign(new Error('aborted'), { name: 'AbortError' })) },
    )
    expect(aborted.ok).toBe(false)
    if (!aborted.ok) {
      expect(aborted.reason).toBe('network-error')
      expect(aborted.message).toBe('request timed out')
    }
  })
})

describe('recoverAgentVerify', () => {
  it('returns the re-issued key + handle on 200', async () => {
    const fetchStub = makeFetch([
      { status: 200, body: { handle: 'alice', api_key: 'ac_' + 'z'.repeat(40) } },
    ])
    const res = await recoverAgentVerify(
      { pendingId: 'pnd_rec1', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.handle).toBe('alice')
      expect(res.apiKey.startsWith('ac_')).toBe(true)
    }
    const call = fetchStub.calls[0]!
    expect(call.url).toBe('https://api.agentchat.me/v1/agents/recover/verify')
    expect(JSON.parse(String(call.init?.body))).toEqual({ pending_id: 'pnd_rec1', code: '123456' })
  })

  it('flags an unexpected success shape (missing api_key or handle)', async () => {
    for (const body of [{ handle: 'alice' }, { api_key: 'ac_' + 'z'.repeat(40) }, {}]) {
      const res = await recoverAgentVerify(
        { pendingId: 'pnd_rec1', code: '123456' },
        { fetch: makeFetch([{ status: 200, body }]) },
      )
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe('unexpected-shape')
    }
  })

  it('classifies EXPIRED and INVALID_CODE', async () => {
    const expired = await recoverAgentVerify(
      { pendingId: 'pnd_rec1', code: '123456' },
      { fetch: makeFetch([{ status: 400, body: { code: 'EXPIRED', message: 'expired' } }]) },
    )
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.reason).toBe('expired')

    // A decoy pending (email + handle matched nothing) also lands here —
    // the server deliberately makes it indistinguishable from a typo.
    const invalid = await recoverAgentVerify(
      { pendingId: 'pnd_decoy', code: '123456' },
      { fetch: makeFetch([{ status: 400, body: { code: 'INVALID_CODE', message: 'Invalid or expired verification code' } }]) },
    )
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.reason).toBe('invalid-code')
  })

  it('classifies 409 HANDLE_REQUIRED and carries details.handles in order', async () => {
    const fetchStub = makeFetch([
      {
        status: 409,
        body: {
          code: 'HANDLE_REQUIRED',
          message: 'This email backs more than one agent. Run recovery again with the handle you want to recover.',
          details: { handles: ['alice', 'alice-codex', 'alice-claude'] },
        },
      },
    ])
    const res = await recoverAgentVerify(
      { pendingId: 'pnd_amb', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('handle-required')
      expect(res.status).toBe(409)
      expect(res.handles).toEqual(['alice', 'alice-codex', 'alice-claude'])
      expect(res.message).toMatch(/more than one agent/)
    }
  })

  it('degrades a malformed HANDLE_REQUIRED details.handles to an empty list', async () => {
    for (const details of [undefined, null, {}, { handles: 'alice' }, { handles: [1, null, { h: 'x' }] }]) {
      const res = await recoverAgentVerify(
        { pendingId: 'pnd_amb', code: '123456' },
        { fetch: makeFetch([{ status: 409, body: { code: 'HANDLE_REQUIRED', message: 'ambiguous', details } }]) },
      )
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.reason).toBe('handle-required')
        expect(res.handles).toEqual([])
      }
    }
    // Mixed lists keep only the strings.
    const mixed = await recoverAgentVerify(
      { pendingId: 'pnd_amb', code: '123456' },
      {
        fetch: makeFetch([
          { status: 409, body: { code: 'HANDLE_REQUIRED', message: 'ambiguous', details: { handles: ['alice', 7, '', 'bob'] } } },
        ]),
      },
    )
    expect(mixed.ok).toBe(false)
    if (!mixed.ok) expect(mixed.handles).toEqual(['alice', 'bob'])
  })

  it('honors Retry-After on 429 (verify-attempt cap)', async () => {
    const fetchStub = makeFetch([
      {
        status: 429,
        body: { code: 'OTP_ATTEMPTS_EXCEEDED', message: 'too many attempts' },
        headers: { 'retry-after': '600' },
      },
    ])
    const res = await recoverAgentVerify(
      { pendingId: 'pnd_rec1', code: '000000' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('rate-limited')
      expect(res.retryAfterSeconds).toBe(600)
    }
  })

  it('maps other rejections (e.g. 404 AGENT_NOT_FOUND) to server-error with the message', async () => {
    const fetchStub = makeFetch([{ status: 404, body: { code: 'AGENT_NOT_FOUND', message: 'Account not found' } }])
    const res = await recoverAgentVerify(
      { pendingId: 'pnd_rec1', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('server-error')
      expect(res.status).toBe(404)
      expect(res.message).toBe('Account not found')
    }
  })

  it('returns network-error on fetch throw', async () => {
    const res = await recoverAgentVerify(
      { pendingId: 'pnd_rec1', code: '123456' },
      { fetch: makeFetch(() => new Error('ECONNREFUSED')) },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('network-error')
  })
})
