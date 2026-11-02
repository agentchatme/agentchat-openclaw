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

export { AgentchatChannelRuntime } from './runtime.js'
export type { ChannelRuntimeHandlers, ChannelRuntimeOptions, HealthSnapshot, KnockSource } from './runtime.js'
export type { Knock, MessageKnock, GroupInviteKnock } from './knock-frames.js'

export { AgentChatChannelError } from './errors.js'
export type { ErrorClass } from './errors.js'

export type { ConnectionState } from './state-machine.js'

export { MainLineClient, MainLineError } from './doorbell/main-line.js'
export type { Tray, Decision } from './doorbell/main-line.js'
export { AgentInvoker } from './doorbell/invoker.js'
export { KnockCoalescer } from './doorbell/knock.js'
export {
  WAKE_INSTRUCTION,
  KNOCK_TURN_PROMPT,
  INVITE_TURN_PROMPT,
  knockTurnPrompt,
  inviteTurnPrompt,
  mcpToolName,
  MCP_SERVER_NAME,
} from './doorbell/turn.js'
export { hostedMcpUrl, hostedMcpServerEntry, hostedMcpSnippet, probeHostedMcp } from './doorbell/mcp.js'

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
