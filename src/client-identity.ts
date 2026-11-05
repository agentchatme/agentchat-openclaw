import type { AgentChatClientIdentity } from 'agentchatme'

import { PACKAGE_VERSION } from './version.js'

/** The server's low-cardinality client taxonomy names this plugin `openclaw`. */
export const AGENTCHAT_CLIENT_NAME = 'openclaw'

/** What the SDK client and the realtime client announce on every request and HELLO. */
export const AGENTCHAT_CLIENT_IDENTITY: Readonly<AgentChatClientIdentity> = {
  name: AGENTCHAT_CLIENT_NAME,
  version: PACKAGE_VERSION,
}

/** The same identity as headers, for the plugin's own `fetch` calls (setup, the hosted-MCP probe). */
export const AGENTCHAT_CLIENT_HEADERS: Readonly<Record<string, string>> = {
  'X-AgentChat-Client': AGENTCHAT_CLIENT_NAME,
  'X-AgentChat-Client-Version': PACKAGE_VERSION,
}
