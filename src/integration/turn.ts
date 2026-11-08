/**
 * Turns: the name OpenClaw gives the hosted tools, and the session keys and
 * lane the turns run on.
 *
 * No text lives here. What a turn starts with — the served wake instruction
 * or invite prompt and the id it is about — is composed by the SDK kit's
 * receive loop from `GET /v1/texts?runtime=openclaw`, which the server spells
 * the way OpenClaw exposes the hosted tools (`agentchat__<tool>`). The plugin
 * still re-spells served text on the way out (`spellToolsForOpenClaw`): it
 * is a no-op on `agentchat__…`, and it keeps the tool names right if a
 * server that serves bare names comes back (a rolled-back deploy). The tray's
 * gate question (`GET /v1/inbox` serves bare names) is spelled by the kit's
 * gate with `OPENCLAW_TOOL_NAMER`.
 *
 * OpenClaw exposes an MCP server's tools to the model as `<server>__<tool>`:
 * the tool-policy pipeline builds the namespace prefix as
 * `normalizeToolName(sanitizeServerName(serverName) + "__")`
 * (`openclaw/dist/tool-policy-*.js`, 2026.6.10) and the docs describe the
 * same shape (docs.openclaw.ai/tools/mcp).
 */

import type { ToolNamer } from 'agentchatme'

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

/**
 * How OpenClaw spells a hosted tool. Idempotent: a name that already carries
 * the server prefix is returned as is, so a server that one day serves the
 * OpenClaw spelling itself is not prefixed twice.
 */
export const OPENCLAW_TOOL_NAMER: ToolNamer = (tool) => (tool.startsWith(MCP_TOOL_PREFIX) ? tool : mcpToolName(tool))

// A bare hosted tool name: `agentchat_` followed by the tool, never a second
// underscore (the already-prefixed form) and never inside a longer word —
// `agentchat__agentchat_inbox` matches nowhere (the inner `agentchat_` has
// no word boundary before it), and `api.agentchat.me` has no underscore.
const HOSTED_TOOL_TOKEN = /\bagentchat_(?!_)[a-z0-9_]+\b/g

/** Re-spell every bare hosted tool name in a served text the way OpenClaw exposes it. Pure, idempotent; a no-op on text the server already spelled. */
export function spellToolsForOpenClaw(text: string): string {
  return text.replace(HOSTED_TOOL_TOKEN, (token) => OPENCLAW_TOOL_NAMER(token))
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

/**
 * A fresh session per invite turn too. An invite can get a second turn (the
 * kit's rule dismisses one still pending after two turns that looked); a
 * reused session would show it the first turn's history, and a turn that
 * then makes no AgentChat call would read as one that could not look.
 */
export function inviteSessionKey(agentId: string, inviteId: string, now: number = Date.now(), nonce: string = randomNonce()): string {
  return `agent:${agentId}:subagent:agentchat-invite-${sanitizeKeyPart(inviteId)}-${utcStamp(now)}-${nonce}`
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
