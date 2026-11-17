/**
 * AgentChat's account calls, as setup makes them: sign-up and recovery by
 * email code (the wizard runs `integration.account.run`) and the key check
 * (`integration.account.checkKey`, `GET /v1/agents/me`), both from the
 * `agentchatme` SDK.
 *
 * The SDK's helper follows the server's answer (contract v1, "Sign-up
 * flows"): which input to ask again, when to wait, when a new code may be
 * sent, and the sentence the person reads. This module keeps none of that;
 * it only binds this plugin's client identity and the account's API base,
 * so every setup path announces itself the same way and reaches the same
 * host. Every call is made once: a retry of a sign-up call would send a
 * second email.
 */

import { integration } from 'agentchatme'

import { AGENTCHAT_CLIENT_IDENTITY } from './client-identity.js'
import { DEFAULT_API_BASE } from './integration/mcp.js'

/** How long a key check waits for an answer before setup says AgentChat was not reached. */
const KEY_CHECK_TIMEOUT_MS = 10_000

/** The server's verdict on a key: `{ok: true, handle}` or `{ok: false, code, message}`. */
export type KeyCheck = integration.CheckKeyResult

export interface AccountCallParams {
  /** The account's `apiBase`; default `https://api.agentchat.me`. */
  readonly apiBase?: string
  /** `fetch` override (tests, a progress indicator around each call). */
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

/** What every account call carries: this plugin's identity and the account's API base. */
export function accountCallOptions(params: AccountCallParams = {}): integration.AccountCallOptions {
  return {
    clientIdentity: AGENTCHAT_CLIENT_IDENTITY,
    apiBase: (params.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ''),
    ...(params.fetch ? { fetch: params.fetch } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  }
}

/** AgentChat gave no verdict on the key: a 429, a 5xx, or another answer that is not about the key. */
export class KeyCheckUnanswered extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyCheckUnanswered'
  }
}

/**
 * Does AgentChat accept this key? `{ok: true, handle}` with the handle the
 * key belongs to (save that one, not a typed one), or `{ok: false, code,
 * message}` when AgentChat turned the key away (401 / 403: never save it).
 * Rejects when no verdict came — no answer (network, timeout), or an answer
 * that is not about the key (`KeyCheckUnanswered`: a 429, a 5xx) — and
 * then nothing is known about the key.
 */
export async function checkApiKey(apiKey: string, params: AccountCallParams = {}): Promise<KeyCheck> {
  // The helper reports every answer as `{ok: false}`; the status says
  // whether the answer was about the key.
  let status: number | undefined
  const send = params.fetch ?? ((input: Parameters<typeof fetch>[0], init?: RequestInit) => globalThis.fetch(input, init))
  const observed = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await send(input, init)
    status = response.status
    return response
  }) as typeof fetch
  const check = await integration.account.checkKey(
    apiKey,
    accountCallOptions({ timeoutMs: KEY_CHECK_TIMEOUT_MS, ...params, fetch: observed }),
  )
  if (!check.ok && status !== 401 && status !== 403) {
    throw new KeyCheckUnanswered(`AgentChat answered ${status ?? 'without a status'} (${check.code}): ${check.message}`)
  }
  return check
}
