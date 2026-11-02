/**
 * ChannelDoctorAdapter — `openclaw doctor` for the placement.
 *
 * `collectPreviewWarnings` reports what the doorbell needs and does not find
 * in the config and the environment; `repairConfig` adds the one thing a
 * config repair can add — the `mcp.servers.agentchat` entry (a template on
 * `AGENTCHAT_API_KEY`, never the key) — and leaves hand-written entries
 * alone. The identity line and the `.env` key are files, not config; the
 * warnings name the command that places them.
 */

import type { ChannelDoctorAdapter, OpenClawConfig } from './openclaw-types.js'

import { AGENTCHAT_CHANNEL_ID, listConfiguredAccountIds, multiAccountRefusal, readAgentchatConfigField } from '../channel-account.js'
import { checkPlacement, resolvePlacementAgentId } from '../doorbell/placement.js'
import { DEFAULT_API_BASE, withHostedMcpEntry } from '../doorbell/mcp.js'
import { LLM_AGENT_OVERRIDE_PATH, readLlmAgentOverrideOptIn, withLlmAgentOverrideOptIn } from '../doorbell/model.js'
import { resolveBoundAgentId, resolveOpenClawDefaultAgentId } from '../openclaw-layout.js'

export const agentchatDoctorAdapter: ChannelDoctorAdapter = {
  collectPreviewWarnings({ cfg, doctorFixCommand, env }) {
    const warnings: string[] = []
    const refusal = multiAccountRefusal(cfg)
    if (refusal) warnings.push(`[${AGENTCHAT_CHANNEL_ID}] doorbell will not start — ${refusal}`)
    for (const accountId of listConfiguredAccountIds(cfg)) {
      const apiKey = readAgentchatConfigField(cfg, accountId, 'apiKey')
      const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase') ?? DEFAULT_API_BASE
      const handle = readAgentchatConfigField(cfg, accountId, 'agentHandle')
      const agentId = resolvePlacementAgentId(cfg, accountId)
      for (const check of checkPlacement({ cfg, handle, apiKey, apiBase, agentId, env })) {
        if (check.ok) continue
        const fix = check.name === 'mcp' ? ` (${doctorFixCommand} adds it)` : ''
        warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] ${check.name}: ${check.detail}${fix}`)
      }
      const bound = resolveBoundAgentId(cfg, AGENTCHAT_CHANNEL_ID, accountId)
      const ambient = resolveOpenClawDefaultAgentId(cfg)
      if (bound && bound !== (ambient ?? bound) && !readLlmAgentOverrideOptIn(cfg)) {
        warnings.push(
          `[${AGENTCHAT_CHANNEL_ID}:${accountId}] gate: this account is bound to agent "${bound}", not OpenClaw's default — the gate call is refused (LLM_COMPLETION_NOT_AUTHORIZED) until ${LLM_AGENT_OVERRIDE_PATH} is true (${doctorFixCommand} writes it)`,
        )
      }
    }
    return warnings
  },

  repairConfig({ cfg }) {
    const changes: string[] = []
    let next: OpenClawConfig = cfg
    const bases = new Map<string, string | undefined>()
    for (const accountId of listConfiguredAccountIds(cfg)) {
      bases.set(readAgentchatConfigField(cfg, accountId, 'apiBase') ?? DEFAULT_API_BASE, readAgentchatConfigField(cfg, accountId, 'apiKey'))
      const bound = resolveBoundAgentId(cfg, AGENTCHAT_CHANNEL_ID, accountId)
      const ambient = resolveOpenClawDefaultAgentId(cfg)
      if (bound && bound !== (ambient ?? bound)) {
        const optIn = withLlmAgentOverrideOptIn(next)
        next = optIn.cfg
        if (optIn.changed) changes.push(`set ${LLM_AGENT_OVERRIDE_PATH} = true (account ${accountId} is bound to agent "${bound}")`)
      }
    }
    // One hosted server entry per API base; every configured account on the
    // default base shares the single `agentchat` entry.
    for (const [apiBase, apiKey] of bases) {
      const result = withHostedMcpEntry(next, apiBase, apiKey)
      next = result.cfg
      if (result.outcome === 'added') changes.push(`added mcp.servers.agentchat → ${apiBase}/mcp (bearer template on AGENTCHAT_API_KEY)`)
    }
    return { config: next, changes }
  },
}
