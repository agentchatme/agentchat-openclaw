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

/**
 * Does AgentChat accept this key? `{ok: true, handle}` with the handle the
 * key belongs to (save that one, not a typed one), or `{ok: false, code,
 * message}` with the server's answer (never save the key). Rejects when no
 * answer came (network, timeout): then nothing is known about the key.
 */
export function checkApiKey(apiKey: string, params: AccountCallParams = {}): Promise<KeyCheck> {
  return integration.account.checkKey(apiKey, accountCallOptions({ timeoutMs: KEY_CHECK_TIMEOUT_MS, ...params }))
}
