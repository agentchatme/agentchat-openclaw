/**
 * The `agentchatme` SDK client for this plugin.
 *
 * `getClient` caches one `AgentChatClient` per account for everything the
 * binding and the integration call over REST (status, the tray, verdicts,
 * texts, the realtime client's reconnect drain) so no call spins up a new
 * HTTP client and a key rotation swaps the cached one uniformly: the cache
 * is keyed by `accountId` and invalidated when the apiKey or apiBase
 * changes. `createSdkClient` is the uncached form for the setup-time paths
 * (wizard, `channels add`, `doctor --fix`) that have a key but no parsed
 * channel config.
 *
 * Every client carries the plugin's identity (`openclaw/<version>`) on
 * every request, through the SDK's own `clientIdentity` option.
 */

import { AgentChatClient, type AgentChatClientOptions } from 'agentchatme'

import type { AgentchatChannelConfig } from '../config-schema.js'
import { AGENTCHAT_CLIENT_IDENTITY } from '../client-identity.js'

interface CacheEntry {
  readonly client: AgentChatClient
  readonly apiKey: string
  readonly apiBase: string
}

const cache = new Map<string, CacheEntry>()

export interface GetClientParams {
  readonly accountId: string
  readonly config: Pick<AgentchatChannelConfig, 'apiKey' | 'apiBase'>
  readonly options?: Partial<AgentChatClientOptions>
}

/** One client, uncached. */
export function createSdkClient(params: { apiKey: string; apiBase?: string | undefined; options?: Partial<AgentChatClientOptions> }): AgentChatClient {
  return new AgentChatClient({
    apiKey: params.apiKey,
    ...(params.apiBase ? { baseUrl: params.apiBase } : {}),
    clientIdentity: AGENTCHAT_CLIENT_IDENTITY,
    ...params.options,
  })
}

/**
 * Return a shared `AgentChatClient` for `accountId`, reusing the cached
 * instance unless the apiKey or apiBase changed (implicit invalidation on
 * silent config drift — better than a stale key surviving a rotation).
 */
export function getClient({ accountId, config, options }: GetClientParams): AgentChatClient {
  const existing = cache.get(accountId)
  if (existing && existing.apiKey === config.apiKey && existing.apiBase === config.apiBase) {
    return existing.client
  }

  const client = createSdkClient({ apiKey: config.apiKey, apiBase: config.apiBase, options })

  cache.set(accountId, {
    client,
    apiKey: config.apiKey,
    apiBase: config.apiBase,
  })
  return client
}

/** Drop the cached client for `accountId` — e.g. after a key rotation. */
export function disposeClient(accountId: string): void {
  cache.delete(accountId)
}

/** Clear the entire cache. Test hook only. */
export function resetClientCacheForTest(): void {
  cache.clear()
}
