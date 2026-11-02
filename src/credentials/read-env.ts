/**
 * Environment variable readers — isolated from outbound networking.
 *
 * The wizard, runtime, and SDK consume the helpers below instead of
 * touching the host environment directly. The split keeps credential
 * lookup in a small audit-friendly module that imports nothing more
 * than its own typings: no SDK, no transport, no logging.
 *
 * See SECURITY.md ("Defensive separation of credential lookup from
 * outbound I/O") for the full rationale and the contract callers
 * must respect.
 */

/** The variable the key lives under — the same name the hosted MCP server's bearer template references. */
export const API_KEY_ENV = 'AGENTCHAT_API_KEY'

/**
 * Reads the AgentChat API key from `AGENTCHAT_API_KEY`.
 *
 * Returns the trimmed value when non-empty AND meeting `minLength`,
 * otherwise `undefined`. The min-length is supplied by the caller
 * (`MIN_API_KEY_LENGTH` from `channel-account.ts`) so this module
 * owns no domain constants.
 */
export function readApiKeyFromEnv(minLength: number): string | undefined {
  const raw = process.env[API_KEY_ENV]?.trim()
  if (!raw) return undefined
  if (raw.length < minLength) return undefined
  return raw
}

/**
 * Reads `OPENCLAW_PROFILE` for workspace path resolution. Mirrors
 * OpenClaw's own logic: non-default profile name →
 * `~/.openclaw/workspace-${profile}`.
 *
 * Returns the trimmed profile name only when it is set AND not equal
 * to "default" (case-insensitive). Returns `undefined` otherwise so
 * callers can fall through to the bare default.
 */
export function readOpenClawProfileFromEnv(): string | undefined {
  const raw = process.env.OPENCLAW_PROFILE?.trim()
  if (!raw) return undefined
  if (raw.toLowerCase() === 'default') return undefined
  return raw
}

/**
 * Reads `OPENCLAW_STATE_DIR` — OpenClaw's override for its state directory
 * (`~/.openclaw` by default; `resolveStateDir` in OpenClaw). The doorbell
 * places the key in `<state dir>/.env`, which OpenClaw loads at start
 * (docs.openclaw.ai/gateway/configuration/environment-variables).
 */
export function readOpenClawStateDirFromEnv(): string | undefined {
  const raw = process.env.OPENCLAW_STATE_DIR?.trim()
  return raw ? raw : undefined
}

/**
 * Reads `OPENCLAW_WORKSPACE_DIR` — OpenClaw's explicit override for the
 * default agent workspace (`resolveDefaultAgentWorkspaceDir` in OpenClaw
 * checks it first).
 */
export function readOpenClawWorkspaceDirFromEnv(): string | undefined {
  const raw = process.env.OPENCLAW_WORKSPACE_DIR?.trim()
  return raw ? raw : undefined
}

export type DoorbellMode = 'v3' | 'off'

/**
 * `AGENTCHAT_DOORBELL=v3|off`. `off` keeps the hosted tools and the manual
 * but opens no socket, takes no knocks and starts no turns. Anything else
 * (including unset) is `v3`.
 */
export function readDoorbellModeFromEnv(): DoorbellMode {
  const raw = (process.env.AGENTCHAT_DOORBELL ?? '').trim().toLowerCase()
  return raw === 'off' ? 'off' : 'v3'
}

const OFF_TOKENS = new Set(['0', 'false', 'off', 'no'])
const ON_TOKENS = new Set(['1', 'true', 'on', 'yes'])

/** `AGENTCHAT_REPLY_GATE_ENABLED=0` turns the gate step off; the agent then judges every card inside the turn. */
export function readReplyGateEnabledFromEnv(): boolean {
  return !OFF_TOKENS.has((process.env.AGENTCHAT_REPLY_GATE_ENABLED ?? '').trim().toLowerCase())
}

/** `AGENTCHAT_REPLY_GATE_FAIL_OPEN=1` starts the turn when the gate cannot run; the default is fail-closed (silence, re-knock). */
export function readReplyGateFailOpenFromEnv(): boolean {
  return ON_TOKENS.has((process.env.AGENTCHAT_REPLY_GATE_FAIL_OPEN ?? '').trim().toLowerCase())
}

/** `AGENTCHAT_REPLY_GATE_TIMEOUT_MS` — decision-call timeout override; `undefined` lets the gate apply its default. */
export function readReplyGateTimeoutMsFromEnv(): number | undefined {
  const raw = process.env.AGENTCHAT_REPLY_GATE_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
