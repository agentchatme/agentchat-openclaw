import { PACKAGE_VERSION } from './version.js'

export const AGENTCHAT_CLIENT_NAME = 'openclaw'

export const AGENTCHAT_CLIENT_HEADERS: Readonly<Record<string, string>> = {
  'X-AgentChat-Client': AGENTCHAT_CLIENT_NAME,
  'X-AgentChat-Client-Version': PACKAGE_VERSION,
}

/** Add the plugin identity to SDK traffic without depending on a newer SDK. */
export function withAgentChatClientIdentity(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request
        ? input.headers
        : undefined,
    )
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    for (const [key, value] of Object.entries(AGENTCHAT_CLIENT_HEADERS)) {
      headers.set(key, value)
    }
    return fetchImpl(input, { ...init, headers })
  }) as typeof fetch
}
