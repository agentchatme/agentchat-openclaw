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
 *      AGENTS.md (checked against the last served copy when one is cached),
 *      the manual, the `mcp.servers.agentchat` entry.
 *
 * Plus the socket's live state when the integration is running.
 */

import type { ChannelStatusAdapter, ChannelCapabilitiesDisplayLine } from './openclaw-types.js'

import type { AgentchatResolvedAccount } from '../channel.js'
import { getClient } from './sdk-client.js'
import { probeHostedMcp } from '../integration/mcp.js'
import { checkPlacement, resolvePlacementAgentId, type PlacementCheck } from '../integration/placement.js'
import { cachedIdentityLine } from '../integration/texts.js'
import { overdueTurnLines } from '../integration/running.js'
import type { SocketState } from '../integration/socket.js'
import type { MetricsSnapshot } from '../metrics.js'
import { getIntegration } from './runtime-registry.js'
import { LEGACY_WAKE_MODE_ENV, WAKE_MODE_ENV, readWakeModeFromEnv } from '../credentials/read-env.js'
import { agentchatReenableHint, isAgentchatAccountEnabled, multiAccountRefusal } from '../channel-account.js'

export type AgentchatProbeResult = {
  readonly ok: boolean
  readonly handle?: string
  readonly status?: 'active' | 'restricted' | 'suspended' | 'deleted'
  readonly pausedByOwner?: 'none' | 'send' | 'full'
  readonly error?: string
  readonly mcp?: { readonly ok: boolean; readonly detail: string }
  readonly placement?: readonly PlacementCheck[]
  readonly integration?: {
    readonly mode: 'on' | 'off'
    readonly state?: SocketState
    readonly wakes?: number
    readonly cycles?: number
    readonly turns?: number
    /** Where the served texts came from: the server, the cached copy, or nowhere yet. */
    readonly texts?: 'server' | 'cache' | 'missing'
    /** The socket's counters since the account started: wakes by source, closes by code/initiator, SDK notices by class. */
    readonly socket?: MetricsSnapshot
    /** Turns running past 30 minutes, one operator line each (the conversation, and what ends the run). */
    readonly overdue?: readonly string[]
  }
  /** Set when the integration refuses to start (more than one account configured). */
  readonly refusal?: string
  /** Set when the account is disabled: the re-enable route (never `channels add`, which would fetch the npm build while the plugin is not loaded). */
  readonly disabled?: string
}

const PROBE_MIN_MS = 1_000
const PROBE_MAX_MS = 10_000

/** `{ message: 3, connect: 1 }` → `connect 1, message 3`; empty → `none`. */
function formatCounts(counts: Readonly<Record<string, number>>): string {
  const parts = Object.entries(counts).map(([label, n]) => `${label} ${n}`)
  return parts.length > 0 ? parts.join(', ') : 'none'
}

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
      identityLine: cachedIdentityLine(account.accountId),
      agentId: resolvePlacementAgentId(cfg as object | undefined, account.accountId),
      accountId: account.accountId,
    })
    const enabled = account.enabled && isAgentchatAccountEnabled(cfg as never, account.accountId)

    const live = getIntegration(account.accountId)
    const health = live?.socket.getHealth()
    const loopStatus = live?.loop?.loop.status()
    const counters = loopStatus
      ? {
          wakes: loopStatus.coalescer.wakes,
          cycles: loopStatus.coalescer.cycles,
          turns: loopStatus.counters.turnsStarted + loopStatus.counters.inviteTurnsStarted + loopStatus.counters.runsStarted,
        }
      : undefined
    const overdue = loopStatus ? overdueTurnLines(loopStatus.turns, cfg) : []
    const servedFrom = live?.texts?.source
    const textsSource: 'server' | 'cache' | 'missing' | undefined = live ? (servedFrom === 'server' || servedFrom === 'cache' ? servedFrom : 'missing') : undefined
    const socketCounters = live?.metrics?.snapshot?.()
    const integration: NonNullable<AgentchatProbeResult['integration']> = {
      mode: readWakeModeFromEnv().mode,
      ...(health ? { state: health.state } : {}),
      ...(counters ? { wakes: counters.wakes, cycles: counters.cycles, turns: counters.turns } : {}),
      ...(textsSource ? { texts: textsSource } : {}),
      ...(socketCounters ? { socket: socketCounters } : {}),
      ...(overdue.length > 0 ? { overdue } : {}),
    }
    const refusal = multiAccountRefusal(cfg as never)

    return {
      ok: enabled && me.status === 'active' && mcp.ok && placement.every((c) => c.ok) && !refusal,
      handle: me.handle,
      status: me.status,
      pausedByOwner: me.paused_by_owner ?? 'none',
      mcp,
      placement,
      integration,
      ...(refusal ? { refusal } : {}),
      ...(enabled ? {} : { disabled: agentchatReenableHint(cfg as never, account.accountId) }),
    }
  },

  formatCapabilitiesProbe({ probe }) {
    const lines: ChannelCapabilitiesDisplayLine[] = []
    if (probe.error) {
      lines.push({ text: probe.error, tone: 'error' })
      return lines
    }
    lines.push({ text: `authenticated as @${probe.handle}`, tone: 'success' })
    if (probe.disabled) lines.push({ text: probe.disabled, tone: 'warn' })
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
    if (probe.refusal) lines.push({ text: `integration not started — ${probe.refusal}`, tone: 'error' })
    if (probe.integration) {
      const d = probe.integration
      if (d.mode === 'off') lines.push({ text: `integration off (${WAKE_MODE_ENV}=off or ${LEGACY_WAKE_MODE_ENV}=off): no socket, no wakes, no turns`, tone: 'warn' })
      else if (d.state) {
        lines.push({
          text: `integration ${d.state} — wakes ${d.wakes ?? 0}, cycles ${d.cycles ?? 0}, turns ${d.turns ?? 0}`,
          tone: d.state === 'ready' ? 'success' : 'warn',
        })
        if (d.socket) {
          lines.push({
            text: `socket — wakes: ${formatCounts(d.socket.wakes)} · closes: ${formatCounts(d.socket.disconnects)} · notices: ${formatCounts(d.socket.errors)}`,
            tone: 'muted',
          })
        }
        for (const line of d.overdue ?? []) lines.push({ text: line, tone: 'warn' })
        if (d.texts === 'missing') {
          lines.push({ text: 'served texts not available yet (AgentChat unreachable, nothing cached) — turns wait for the first copy', tone: 'error' })
        } else if (d.texts === 'cache') {
          lines.push({ text: 'served texts from the cached copy — AgentChat was unreachable at start; refreshed when it is back', tone: 'warn' })
        }
      } else if (!probe.refusal) lines.push({ text: 'integration not running in this process', tone: 'muted' })
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
