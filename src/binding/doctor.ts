/**
 * ChannelDoctorAdapter — `openclaw doctor` for the placement.
 *
 * `collectPreviewWarnings` (plain `openclaw doctor`) reports what the
 * doorbell needs and does not find in the config, the environment and the
 * workspace. `repairConfig` (`openclaw doctor --fix` only — OpenClaw never
 * calls it in preview) adds the `mcp.servers.agentchat` entry (a template on
 * `AGENTCHAT_API_KEY`, never the key; hand-written entries are left alone),
 * persists `agentHandle`, writes the llm opt-in for a non-default bound
 * agent, and places a missing identity line for the configured handle — a
 * file, but the one placement a re-enable through
 * `openclaw config set channels.agentchat.enabled true` cannot restore any
 * other way. An identity line already present is never rewritten.
 *
 * A disabled account gets one warning naming the re-enable route and no
 * repair: its identity line and tools entry are absent by design.
 */

import type { ChannelDoctorAdapter, OpenClawConfig } from './openclaw-types.js'

import {
  AGENTCHAT_CHANNEL_ID,
  agentchatReenableHint,
  applyAgentchatAccountPatch,
  isAgentchatAccountEnabled,
  listConfiguredAccountIds,
  multiAccountRefusal,
  readAgentchatConfigField,
} from '../channel-account.js'
import { validateApiKey } from '../setup-client.js'
import { checkPlacement, resolvePlacementAgentId, restoreIdentityLine } from '../doorbell/placement.js'
import { DEFAULT_API_BASE, withHostedMcpEntry } from '../doorbell/mcp.js'
import { LLM_AGENT_OVERRIDE_PATH, readLlmAgentOverrideOptIn, withLlmAgentOverrideOptIn } from '../doorbell/model.js'
import { resolveBoundAgentId, resolveOpenClawDefaultAgentId } from '../openclaw-layout.js'

export const agentchatDoctorAdapter: ChannelDoctorAdapter = {
  collectPreviewWarnings({ cfg, doctorFixCommand, env }) {
    const warnings: string[] = []
    const refusal = multiAccountRefusal(cfg)
    if (refusal) warnings.push(`[${AGENTCHAT_CHANNEL_ID}] doorbell will not start — ${refusal}`)
    for (const accountId of listConfiguredAccountIds(cfg)) {
      if (!isAgentchatAccountEnabled(cfg, accountId)) {
        warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] ${agentchatReenableHint(cfg, accountId)}`)
        continue
      }
      const apiKey = readAgentchatConfigField(cfg, accountId, 'apiKey')
      const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase') ?? DEFAULT_API_BASE
      const handle = readAgentchatConfigField(cfg, accountId, 'agentHandle')
      const agentId = resolvePlacementAgentId(cfg, accountId)
      for (const check of checkPlacement({ cfg, handle, apiKey, apiBase, agentId, accountId, env })) {
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

  async repairConfig({ cfg }) {
    const changes: string[] = []
    const warnings: string[] = []
    let next: OpenClawConfig = cfg
    const bases = new Map<string, string | undefined>()
    // One identity line per workspace: with several accounts configured the
    // doorbell refuses to start and the line would flip between handles.
    const placeIdentityLines = multiAccountRefusal(cfg) === null
    for (const accountId of listConfiguredAccountIds(cfg)) {
      // Disabled: the identity line and the tools entry are absent by design.
      if (!isAgentchatAccountEnabled(cfg, accountId)) continue
      const apiKey = readAgentchatConfigField(cfg, accountId, 'apiKey')
      const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase') ?? DEFAULT_API_BASE
      bases.set(apiBase, apiKey)
      // The handle the key authenticates as is the one config field only the
      // server knows. Missing (an older OpenClaw's non-interactive add could
      // not learn it before the write) → one live check per account.
      if (apiKey && !readAgentchatConfigField(cfg, accountId, 'agentHandle')) {
        try {
          const result = await validateApiKey(apiKey, { apiBase })
          if (result.ok) {
            next = applyAgentchatAccountPatch(next, accountId, { agentHandle: result.agent.handle })
            changes.push(`set channels.agentchat${accountId === 'default' ? '' : `.accounts.${accountId}`}.agentHandle = ${result.agent.handle}`)
          } else {
            warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] agentHandle not set and the key did not pass the live check (${result.reason}): ${result.message}`)
          }
        } catch (err) {
          warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] agentHandle not set and AgentChat was not reachable to learn it: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const bound = resolveBoundAgentId(cfg, AGENTCHAT_CHANNEL_ID, accountId)
      const ambient = resolveOpenClawDefaultAgentId(cfg)
      if (bound && bound !== (ambient ?? bound)) {
        const optIn = withLlmAgentOverrideOptIn(next)
        next = optIn.cfg
        if (optIn.changed) changes.push(`set ${LLM_AGENT_OVERRIDE_PATH} = true (account ${accountId} is bound to agent "${bound}")`)
      }
      // The identity line for the configured handle (including one learnt
      // just above). Present → untouched, byte for byte.
      const handle = readAgentchatConfigField(next, accountId, 'agentHandle')
      if (apiKey && handle && placeIdentityLines) {
        const restored = restoreIdentityLine(next, accountId, handle)
        if (restored.outcome === 'placed') changes.push(`placed the identity line for @${handle.replace(/^@/, '')} in ${restored.path}`)
        else if (restored.outcome === 'failed') warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] could not place the identity line for @${handle.replace(/^@/, '')}: ${restored.detail ?? 'unknown error'}`)
      }
    }
    // One hosted server entry per API base; every configured account on the
    // default base shares the single `agentchat` entry.
    for (const [apiBase, apiKey] of bases) {
      const result = withHostedMcpEntry(next, apiBase, apiKey)
      next = result.cfg
      if (result.outcome === 'added') changes.push(`added mcp.servers.agentchat → ${apiBase}/mcp (bearer template on AGENTCHAT_API_KEY)`)
    }
    return { config: next, changes, ...(warnings.length > 0 ? { warnings } : {}) }
  },
}
