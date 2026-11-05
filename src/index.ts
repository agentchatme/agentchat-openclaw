/**
 * Public entry barrel for `@agentchatme/openclaw`.
 *
 * OpenClaw loads this file via `package.json`'s `openclaw.extensions` entry
 * and reads `default` to obtain the channel-entry descriptor. Keep imports
 * narrow so the bootstrap/discovery path stays lightweight.
 */

export {
  agentchatChannelEntry as default,
  agentchatChannelEntry,
  agentchatPlugin,
  AGENTCHAT_CHANNEL_ID,
  AGENTCHAT_DEFAULT_ACCOUNT_ID,
} from './channel.js'
export type { AgentchatResolvedAccount } from './channel.js'

export { agentchatSetupEntry, agentchatSetupPlugin } from './channel.setup.js'

export { hasAgentChatConfiguredState } from './configured-state.js'

export { parseChannelConfig } from './config-schema.js'
export type { AgentchatChannelConfig } from './config-schema.js'

export { IntegrationSocket, realtimeOptionsFor } from './integration/socket.js'
export type { SocketHandlers, SocketHealth, SocketState, SocketDisconnect, SocketBlocked, IntegrationSocketOptions } from './integration/socket.js'
export { AgentInvoker } from './integration/invoker.js'
export type { AgentInvokerOptions, CycleResult, CycleOutcome, WakeSource } from './integration/invoker.js'
export { WakeCoalescer } from './integration/wake.js'
export { TextsStore, loadTexts, loadIdentityLine } from './integration/texts.js'
export { InviteLedger, groupInviteFromRecord } from './integration/invites.js'
export type { GroupInvite } from './integration/invites.js'
export {
  wakeTurnPrompt,
  inviteTurnPrompt,
  spellToolsForOpenClaw,
  mcpToolName,
  MCP_SERVER_NAME,
  OPENCLAW_TOOL_NAMER,
} from './integration/turn.js'
export { hostedMcpUrl, hostedMcpServerEntry, hostedMcpSnippet, probeHostedMcp } from './integration/mcp.js'

export { AgentChatChannelError } from './errors.js'
export type { ErrorClass } from './errors.js'

export {
  validateApiKey,
  assertApiKeyValid,
  registerAgentStart,
  registerAgentVerify,
  recoverAgentStart,
  recoverAgentVerify,
} from './setup-client.js'
export type {
  AgentchatAgentIdentity,
  ValidateApiKeyResult,
  ValidateApiKeyOptions,
  EmailPolicyReason,
  RegisterAgentStartInput,
  RegisterAgentVerifyInput,
  RegisterStartResult,
  RegisterVerifyResult,
  RegisterOptions,
  RecoverAgentStartInput,
  RecoverAgentVerifyInput,
  RecoverStartResult,
  RecoverVerifyResult,
} from './setup-client.js'
