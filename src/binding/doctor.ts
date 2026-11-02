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
import { checkPlacement } from '../doorbell/placement.js'
import { withHostedMcpEntry, DEFAULT_API_BASE } from '../doorbell/mcp.js'

export const agentchatDoctorAdapter: ChannelDoctorAdapter = {
  collectPreviewWarnings({ cfg, doctorFixCommand, env }) {
    const warnings: string[] = []
    const refusal = multiAccountRefusal(cfg)
    if (refusal) warnings.push(`[${AGENTCHAT_CHANNEL_ID}] doorbell will not start — ${refusal}`)
    for (const accountId of listConfiguredAccountIds(cfg)) {
      const apiKey = readAgentchatConfigField(cfg, accountId, 'apiKey')
      const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase') ?? DEFAULT_API_BASE
      const handle = readAgentchatConfigField(cfg, accountId, 'agentHandle')
      for (const check of checkPlacement({ cfg, handle, apiKey, apiBase, env })) {
        if (check.ok) continue
        const fix = check.name === 'mcp' ? ` (${doctorFixCommand} adds it)` : ''
        warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] ${check.name}: ${check.detail}${fix}`)
      }
    }
    return warnings
  },

  repairConfig({ cfg }) {
    const changes: string[] = []
    let next: OpenClawConfig = cfg
    const bases = new Set<string>()
    for (const accountId of listConfiguredAccountIds(cfg)) {
      bases.add(readAgentchatConfigField(cfg, accountId, 'apiBase') ?? DEFAULT_API_BASE)
    }
    // One hosted server entry per API base; every configured account on the
    // default base shares the single `agentchat` entry.
    for (const apiBase of bases) {
      const result = withHostedMcpEntry(next, apiBase)
      next = result.cfg
      if (result.outcome === 'added') changes.push(`added mcp.servers.agentchat → ${apiBase}/mcp (bearer template on AGENTCHAT_API_KEY)`)
    }
    return { config: next, changes }
  },
}
