/**
 * Turns: the names OpenClaw gives the hosted tools, the prompts a turn starts
 * with, and the session keys and lane the turns run on.
 *
 * No product text lives here. The wake instruction and the invite prompt are
 * served by AgentChat (`GET /v1/texts`, fetched by `./texts.ts`) and placed
 * by this module; the one line of our own states a fact (which conversation
 * the gate decided to answer), never judgement.
 *
 * OpenClaw exposes an MCP server's tools to the model as `<server>__<tool>`:
 * the tool-policy pipeline builds the namespace prefix as
 * `normalizeToolName(sanitizeServerName(serverName) + "__")`
 * (`openclaw/dist/tool-policy-*.js`, 2026.6.10) and the docs describe the
 * same shape (docs.openclaw.ai/tools/mcp). The server spells the hosted
 * tools by their bare names (`agentchat_inbox`); `spellToolsForOpenClaw`
 * re-spells exactly those tokens so the agent is told the names it can call.
 */

import type { Texts, ToolNamer } from 'agentchatme'

/** Name of the MCP server entry this plugin places. Changing it changes every tool name the model sees — keep in lockstep with `./mcp.ts`. */
export const MCP_SERVER_NAME = 'agentchat'

/** OpenClaw's MCP namespace delimiter. */
export const MCP_TOOL_DELIMITER = '__'

/** The bundled manual, as OpenClaw loads it: the `agentchat` skill. */
export const SKILL_NAME = 'agentchat'

const MCP_TOOL_PREFIX = `${MCP_SERVER_NAME}${MCP_TOOL_DELIMITER}`

/** `agentchat_inbox` → `agentchat__agentchat_inbox`. */
export function mcpToolName(tool: string): string {
  return `${MCP_TOOL_PREFIX}${tool}`
}

export const INBOX_TOOL = mcpToolName('agentchat_inbox')
export const DECIDE_TOOL = mcpToolName('agentchat_decide')
export const GET_CONVERSATION_TOOL = mcpToolName('agentchat_get_conversation')
export const SEND_MESSAGE_TOOL = mcpToolName('agentchat_send_message')

/**
 * How OpenClaw spells a hosted tool. Idempotent: a name that already carries
 * the server prefix is returned as is, so a server that one day serves the
 * OpenClaw spelling itself is not prefixed twice.
 */
export const OPENCLAW_TOOL_NAMER: ToolNamer = (tool) => (tool.startsWith(MCP_TOOL_PREFIX) ? tool : mcpToolName(tool))

// A bare hosted tool name: `agentchat_` followed by the tool, never a second
// underscore (which is the already-prefixed form) and never inside a longer
// word. `api.agentchat.me` carries no underscore and is untouched.
const HOSTED_TOOL_TOKEN = /\bagentchat_(?!_)[a-z0-9_]+\b/g

/** Re-spell every bare hosted tool name in a served text the way OpenClaw exposes it. Pure, idempotent. */
export function spellToolsForOpenClaw(text: string): string {
  return text.replace(HOSTED_TOOL_TOKEN, (token) => OPENCLAW_TOOL_NAMER(token))
}

/**
 * The prompt a wake turn starts with: the served wake instruction and, when
 * the gate decided a specific conversation, one factual line naming it. The
 * `reply` verdict is recorded when the turn has completed — never at its
 * start — so while the turn runs the conversation is still unread and its
 * card still on the tray; the line says so, names the conversation to open,
 * and says the verdict is taken care of (recording it in the turn as well is
 * idempotent).
 */
export function wakeTurnPrompt(texts: Pick<Texts, 'wake_instruction'>, conversationId?: string): string {
  const instruction = texts.wake_instruction.trim()
  if (!conversationId) return instruction
  return `${instruction}\n\n${conversationLine(conversationId)}`
}

/** The one line of ours in a wake turn: facts about this turn, with OpenClaw's tool name. */
export function conversationLine(conversationId: string): string {
  return (
    `Conversation to answer in this turn: ${conversationId}. The gate decided reply; its card is still on the tray while you work, ` +
    `and the reply verdict for it is recorded for you when this turn completes (recording it yourself with ${DECIDE_TOOL} is idempotent) — ` +
    `open it with ${GET_CONVERSATION_TOOL} and reply.`
  )
}

/** The prompt a group-invite turn starts with: the served invite prompt. */
export function inviteTurnPrompt(texts: Pick<Texts, 'invite_prompt'>): string {
  return texts.invite_prompt.trim()
}

/**
 * A fresh OpenClaw session per wake turn, in the shape OpenClaw's own
 * documentation uses for plugin-owned runs
 * (`agent:<agentId>:subagent:<name>`, docs.openclaw.ai/plugins/sdk-runtime/background-work).
 * The conversation state lives on the server and is read through the
 * hosted tools inside the turn; a per-wake session keeps OpenClaw's own
 * history from growing without bound and stays greppable in its session
 * store.
 */
export function wakeSessionKey(agentId: string, now: number = Date.now(), nonce: string = randomNonce()): string {
  return `agent:${agentId}:subagent:agentchat-wake-${utcStamp(now)}-${nonce}`
}

export function inviteSessionKey(agentId: string, inviteId: string): string {
  return `agent:${agentId}:subagent:agentchat-invite-${sanitizeKeyPart(inviteId)}`
}

/** One serialization lane per account so AgentChat turns never block the agent's main lane and never overlap each other. */
export function integrationLane(accountId: string): string {
  return `agentchat-integration:${sanitizeKeyPart(accountId)}`
}

function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function randomNonce(): string {
  return Math.random().toString(16).slice(2, 8).padEnd(6, '0')
}

function sanitizeKeyPart(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_-]/g, '-')
  return clean.length > 0 ? clean : 'x'
}
