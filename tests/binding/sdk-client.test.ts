/**
 * SDK client cache behavior — covers:
 *   - Cache hit: same accountId + same config → same instance
 *   - Implicit invalidation on apiKey rotation
 *   - Implicit invalidation on apiBase change
 *   - Explicit dispose
 *   - Independent entries per accountId
 *
 * We construct real `AgentChatClient` instances (no HTTP traffic — the
 * client is pure state until a method is called), and compare reference
 * identity to verify caching.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { getClient, disposeClient, resetClientCacheForTest } from '../../src/binding/sdk-client.js'
import type { AgentchatChannelConfig } from '../../src/config-schema.js'
import { PACKAGE_VERSION } from '../../src/version.js'

function makeConfig(apiKey: string, apiBase = 'https://api.agentchat.me'): AgentchatChannelConfig {
  return {
    apiKey,
    apiBase,
    reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0.2 },
    ping: { intervalMs: 30000, timeoutMs: 10000 },
    outbound: { maxInFlight: 256, sendTimeoutMs: 15000 },
    observability: { logLevel: 'info', redactKeys: ['apiKey'] },
  }
}

describe('sdk-client cache', () => {
  beforeEach(() => {
    resetClientCacheForTest()
  })

  it('returns the same client for repeated calls with the same config', () => {
    const cfg = makeConfig('ac_live_key_aaaaaaaaaaaaaaaaaaaaaaaa')
    const a = getClient({ accountId: 'default', config: cfg })
    const b = getClient({ accountId: 'default', config: cfg })
    expect(a).toBe(b)
  })

  it('issues a fresh client when apiKey changes (rotation path)', () => {
    const a = getClient({
      accountId: 'default',
      config: makeConfig('ac_live_key_aaaaaaaaaaaaaaaaaaaaaaaa'),
    })
    const b = getClient({
      accountId: 'default',
      config: makeConfig('ac_live_key_bbbbbbbbbbbbbbbbbbbbbbbb'),
    })
    expect(a).not.toBe(b)
  })

  it('issues a fresh client when apiBase changes', () => {
    const a = getClient({
      accountId: 'default',
      config: makeConfig('k_same_key_sixteen_plus_chars_ok', 'https://api.agentchat.me'),
    })
    const b = getClient({
      accountId: 'default',
      config: makeConfig('k_same_key_sixteen_plus_chars_ok', 'https://staging.agentchat.me'),
    })
    expect(a).not.toBe(b)
  })

  it('keeps entries independent across accountIds', () => {
    const cfg = makeConfig('ac_live_key_shared_between_accts_12')
    const a = getClient({ accountId: 'prod', config: cfg })
    const b = getClient({ accountId: 'staging', config: cfg })
    expect(a).not.toBe(b)
    expect(getClient({ accountId: 'prod', config: cfg })).toBe(a)
    expect(getClient({ accountId: 'staging', config: cfg })).toBe(b)
  })

  it('dispose drops the cached client for that accountId only', () => {
    const cfg = makeConfig('ac_live_key_aaaaaaaaaaaaaaaaaaaaaaaa')
    const a = getClient({ accountId: 'default', config: cfg })
    disposeClient('default')
    const b = getClient({ accountId: 'default', config: cfg })
    expect(a).not.toBe(b)
  })

  it('dispose of a missing accountId is a no-op', () => {
    expect(() => disposeClient('nonexistent')).not.toThrow()
  })

  it('attaches the OpenClaw identity to SDK requests', async () => {
    const seen: Record<string, string> = {}
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.client = headers.get('x-agentchat-client') ?? ''
      seen.version = headers.get('x-agentchat-client-version') ?? ''
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const client = getClient({
      accountId: 'identity',
      config: makeConfig('ac_live_key_aaaaaaaaaaaaaaaaaaaaaaaa'),
      options: { fetch: fetchImpl as typeof fetch },
    })

    await client.listConversations()

    expect(seen).toEqual({ client: 'openclaw', version: PACKAGE_VERSION })
  })
})
