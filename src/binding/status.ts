/**
 * ChannelStatusAdapter — the doctor-style status for `openclaw channels status`.
 *
 * `probeAccount` reports three things an operator needs to know, with one
 * short timeout each:
 *
 *   1. the key authenticates (`GET /v1/agents/me`) and the account is active;
 *   2. the hosted MCP server is reachable with that key (one MCP
 *      `initialize`), because that is where every AgentChat tool lives;
 *   3. placement: the key in the gateway environment, the identity line in
 *      AGENTS.md, the manual, the `mcp.servers.agentchat` entry.
 *
 * Plus the socket's live state when the doorbell is running.
 */

import type { ChannelStatusAdapter, ChannelCapabilitiesDisplayLine } from './openclaw-types.js'

import type { AgentchatResolvedAccount } from '../channel.js'
import { getClient } from './sdk-client.js'
import { probeHostedMcp } from '../doorbell/mcp.js'
import { checkPlacement, type PlacementCheck } from '../doorbell/placement.js'
import { getDoorbell } from './runtime-registry.js'
import { readDoorbellModeFromEnv } from '../credentials/read-env.js'
import { multiAccountRefusal } from '../channel-account.js'

export type AgentchatProbeResult = {
  readonly ok: boolean
  readonly handle?: string
  readonly status?: 'active' | 'restricted' | 'suspended' | 'deleted'
  readonly pausedByOwner?: 'none' | 'send' | 'full'
  readonly error?: string
  readonly mcp?: { readonly ok: boolean; readonly detail: string }
  readonly placement?: readonly PlacementCheck[]
  readonly doorbell?: { readonly mode: 'v3' | 'off'; readonly state?: string; readonly ackNegotiated?: boolean; readonly knocks?: number; readonly cycles?: number; readonly turns?: number }
  /** Set when the doorbell refuses to start (more than one account configured). */
  readonly refusal?: string
}

const PROBE_MIN_MS = 1_000
const PROBE_MAX_MS = 10_000

export const agentchatStatusAdapter: ChannelStatusAdapter<AgentchatResolvedAccount, AgentchatProbeResult> = {
  async probeAccount({ account, timeoutMs, cfg }) {
    if (!account.config) {
      return { ok: false, error: 'missing channels.agentchat configuration' }
    }
    const config = account.config
    const clampedTimeout = Math.min(PROBE_MAX_MS, Math.max(PROBE_MIN_MS, timeoutMs))

    const client = getClient({ accountId: account.accountId, config })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), clampedTimeout)
    let me: Awaited<ReturnType<typeof client.getMe>>
    try {
      me = await client.getMe({ signal: controller.signal })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }

    const mcpProbe = await probeHostedMcp({ apiKey: config.apiKey, apiBase: config.apiBase, timeoutMs: clampedTimeout })
    const mcp = {
      ok: mcpProbe.ok,
      detail: mcpProbe.ok
        ? `hosted MCP server reachable with this key${mcpProbe.serverName ? ` (${mcpProbe.serverName}${mcpProbe.serverVersion ? ` ${mcpProbe.serverVersion}` : ''})` : ''}`
        : `hosted MCP server not reachable with this key: ${mcpProbe.error ?? 'unknown error'}`,
    }

    const placement = checkPlacement({
      cfg: cfg as object | undefined,
      handle: config.agentHandle ?? me.handle,
      apiKey: config.apiKey,
      apiBase: config.apiBase,
    })

    const live = getDoorbell(account.accountId)
    const health = live?.runtime.getHealth()
    const counters = live?.invoker?.counters()
    const doorbell = {
      mode: readDoorbellModeFromEnv(),
      ...(health ? { state: health.state.kind, ackNegotiated: health.ackNegotiated } : {}),
      ...(counters ? { knocks: counters.knocks, cycles: counters.cycles, turns: counters.turns } : {}),
    }
    const refusal = multiAccountRefusal(cfg as never)
    // A legacy server (no `ack` echoed) marks envelopes delivered on push,
    // before any verdict — rule 1 is off. That is an error, not a footnote.
    const legacyServer = health !== undefined && health.authenticated && !health.ackNegotiated

    return {
      ok: me.status === 'active' && mcp.ok && placement.every((c) => c.ok) && !refusal && !legacyServer,
      handle: me.handle,
      status: me.status,
      pausedByOwner: me.paused_by_owner ?? 'none',
      mcp,
      placement,
      doorbell,
      ...(refusal ? { refusal } : {}),
    }
  },

  formatCapabilitiesProbe({ probe }) {
    const lines: ChannelCapabilitiesDisplayLine[] = []
    if (probe.error) {
      lines.push({ text: probe.error, tone: 'error' })
      return lines
    }
    lines.push({ text: `authenticated as @${probe.handle}`, tone: 'success' })
    if (probe.status && probe.status !== 'active') {
      lines.push({ text: `account status: ${probe.status}`, tone: probe.status === 'restricted' ? 'warn' : 'error' })
    }
    if (probe.pausedByOwner && probe.pausedByOwner !== 'none') {
      lines.push({ text: `owner paused this account (${probe.pausedByOwner})`, tone: 'warn' })
    }
    if (probe.mcp) lines.push({ text: probe.mcp.detail, tone: probe.mcp.ok ? 'success' : 'error' })
    for (const check of probe.placement ?? []) {
      lines.push({ text: `${check.name}: ${check.detail}`, tone: check.ok ? 'muted' : 'warn' })
    }
    if (probe.refusal) lines.push({ text: `doorbell not started — ${probe.refusal}`, tone: 'error' })
    if (probe.doorbell) {
      const d = probe.doorbell
      if (d.mode === 'off') lines.push({ text: 'doorbell off (AGENTCHAT_DOORBELL=off): no socket, no knocks, no turns', tone: 'warn' })
      else if (d.state) {
        lines.push({
          text: `doorbell ${d.state} — knocks ${d.knocks ?? 0}, cycles ${d.cycles ?? 0}, turns ${d.turns ?? 0}`,
          tone: d.state === 'READY' ? 'success' : 'warn',
        })
        if (d.ackNegotiated === false && (d.state === 'READY' || d.state === 'DEGRADED')) {
          lines.push({
            text: 'server did not negotiate the ack capability — envelopes are marked delivered on push, before any verdict; this server predates the main line',
            tone: 'error',
          })
        }
      } else if (!probe.refusal) lines.push({ text: 'doorbell not running in this process', tone: 'muted' })
    }
    return lines
  },

  resolveAccountState({ account, configured, enabled }) {
    if (!enabled) return 'disabled'
    if (!configured) return 'not configured'
    if (account.configured) return 'linked'
    return 'not linked'
  },
}
