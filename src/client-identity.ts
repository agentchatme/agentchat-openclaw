import type { AgentChatClientIdentity } from 'agentchatme'

import { PACKAGE_VERSION } from './version.js'

/** The server's low-cardinality client taxonomy names this plugin `openclaw`. */
export const AGENTCHAT_CLIENT_NAME = 'openclaw'

/** What the SDK client and the realtime client announce on every request and HELLO. */
export const AGENTCHAT_CLIENT_IDENTITY: Readonly<AgentChatClientIdentity> = {
  name: AGENTCHAT_CLIENT_NAME,
  version: PACKAGE_VERSION,
}
