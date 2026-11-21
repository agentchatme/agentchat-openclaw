/**
 * ChannelDoctorAdapter — `openclaw doctor` for the placement.
 *
 * `collectPreviewWarnings` (plain `openclaw doctor`) reports what the
 * integration needs and does not find in the config, the environment and
 * the workspace — without touching the network: the identity line is
 * checked against the last served copy when one is cached. `repairConfig`
 * (`openclaw doctor --fix` only — OpenClaw never calls it in preview) adds
 * the `mcp.servers.agentchat` entry (a template on `AGENTCHAT_API_KEY`,
 * never the key; hand-written entries are left alone) or brings ours up to
 * date (the header that names this client), persists
 * `agentHandle`, writes the llm opt-in for a non-default bound agent, and
 * places a missing identity line for the configured handle — fetching the
 * served text first (server, then the cached copy). An identity line
 * already holding that text is never rewritten. It also brings the manual
 * in OpenClaw's managed skills dir to the served one (`placeManual`; a file
 * there that is not this plugin's is left alone and reported).
 *
 * A disabled account gets one warning naming the re-enable route and no
 * repair: its identity line and tools entry are absent by design.
 *
 * Where the key sits on disk (plain text in openclaw.json, a key file others
 * can read, OpenClaw's own config copies holding it) is not reported here
 * but as a security warning (`security.collectWarnings`, `channel.ts`):
 * OpenClaw runs this preview only when doctor may pause the gateway, while
 * its read-only runs (`openclaw doctor --lint`; on 2026.11 also a bare
 * `--json` and answering No to the pause) run the security check and never
 * this hook.
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
import { checkApiKey } from '../setup-client.js'
import { getIntegration, listActiveAccounts } from './runtime-registry.js'
import { findAccountTurns, hungTurnsReason, overdueTurnLines, restartHoldLines } from '../integration/running.js'
import { cycleTroubleLine } from '../integration/loop.js'
import { couldNotProcessView, pausedConversations, recentTrouble } from '../integration/could-not-process.js'
import {
  checkPlacement,
  dotEnvPath,
  keyCopiesAfterRunLine,
  manualStep,
  noteKeyMovedOutOfConfig,
  placeApiKeyInDotEnv,
  readApiKeyFromDotEnv,
  resolvePlacementAgentId,
  restoreIdentityLine,
} from '../integration/placement.js'
import { resolveAgentchatApiKey, type ConfiguredKey } from '../channel-key.js'
import { tightenApiKeyFile, writeApiKeyFile } from '../credentials/key-file.js'
import { DEFAULT_API_BASE, clientIdentityText, withHostedMcpEntry } from '../integration/mcp.js'
import { LLM_AGENT_OVERRIDE_PATH, readLlmAgentOverrideOptIn, withLlmAgentOverrideOptIn } from '../integration/model.js'
import { cachedIdentityLine, identityLineOf, identityTemplateOf, loadServedTexts, type ServedTextsCopy } from '../integration/texts.js'
import { placeManual } from '../integration/manual.js'
import { resolveBoundAgentId, resolveOpenClawDefaultAgentId } from '../openclaw-layout.js'
import { createSdkClient } from './sdk-client.js'

/**
 * `openclaw doctor --fix` for the key: a plain-text `channels.agentchat.apiKey`
 * (an install from before the key file) is stored in an owner-only key file
 * and replaced by its path; a key file other users can read is tightened to
 * `0600`; the state-dir `.env` line the hosted tools read is placed when it
 * is missing or holds another key. The key file is written before OpenClaw
 * persists the config: if that write fails, the plain-text key is still in
 * the config, so the key is never lost. OpenClaw's own config copies are
 * never edited; they are not named here either, since the doctor run that
 * called this writes the config afterwards (rotating them) — the line says
 * which read-only check names them once it is done.
 */
export function moveKeyOutOfConfig(
  cfg: OpenClawConfig,
  accountId: string,
  key: Extract<ConfiguredKey, { ok: true }>,
  options: { stateDir?: string; configPath?: string; placeDotEnv?: boolean } = {},
): { cfg: OpenClawConfig; changes: string[]; warnings: string[] } {
  const changes: string[] = []
  const warnings: string[] = []
  const path = accountId === 'default' ? 'channels.agentchat' : `channels.agentchat.accounts.${accountId}`
  let next = cfg
  if (key.source === 'config') {
    try {
      const stored = writeApiKeyFile(accountId, key.apiKey, options.stateDir)
      next = applyAgentchatAccountPatch(next, accountId, { apiKeyFile: stored.path, apiKey: undefined })
      changes.push(`moved the API key out of openclaw.json: ${path}.apiKey is now ${path}.apiKeyFile = ${stored.path} (owner-only, 0600)`)
      // OpenClaw writes the config after this (more than once in a doctor run): the old text lands in its backups, which this run rotates.
      noteKeyMovedOutOfConfig()
      warnings.push(keyCopiesAfterRunLine())
    } catch (err) {
      warnings.push(`the plain-text ${path}.apiKey could not be moved to a key file (${err instanceof Error ? err.message : String(err)}); it stays in openclaw.json`)
    }
  } else {
    if (key.plainTextCopy) {
      next = applyAgentchatAccountPatch(next, accountId, { apiKey: undefined })
      changes.push(`removed the plain-text ${path}.apiKey from openclaw.json (the same key is in ${key.file ?? 'the key file'}, which stays in use)`)
      noteKeyMovedOutOfConfig()
      warnings.push(keyCopiesAfterRunLine())
    }
    if (key.loosePermissions && key.file && tightenApiKeyFile(key.file)) changes.push(`made the key file ${key.file} owner-only (0600)`)
  }
  // One `.env` variable for the hosted tools: with several accounts configured the integration refuses to start, and the line would flip between keys.
  if (options.placeDotEnv !== false && readApiKeyFromDotEnv(options.stateDir) !== key.apiKey) {
    try {
      const placed = placeApiKeyInDotEnv(key.apiKey, options.stateDir)
      if (placed.changed) changes.push(`placed the account's key as AGENTCHAT_API_KEY in ${placed.path} for the hosted tools (restart the gateway: OpenClaw reads it only at start)`)
    } catch (err) {
      warnings.push(`could not place AGENTCHAT_API_KEY in ${dotEnvPath(options.stateDir)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { cfg: next, changes, warnings }
}

export const agentchatDoctorAdapter: ChannelDoctorAdapter = {
  collectPreviewWarnings({ cfg, doctorFixCommand, env }) {
    const warnings: string[] = []
    const refusal = multiAccountRefusal(cfg)
    if (refusal) warnings.push(`[${AGENTCHAT_CHANNEL_ID}] integration will not start — ${refusal}`)
    // The manual is account-free: its lines once, with the first enabled account.
    let manualReported = false
    for (const accountId of listConfiguredAccountIds(cfg)) {
      if (!isAgentchatAccountEnabled(cfg, accountId)) {
        warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] ${agentchatReenableHint(cfg, accountId)}`)
        continue
      }
      const keySource = resolveAgentchatApiKey(cfg, accountId)
      const apiKey = keySource.ok ? keySource.apiKey : undefined
      const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase') ?? DEFAULT_API_BASE
      const handle = readAgentchatConfigField(cfg, accountId, 'agentHandle')
      const agentId = resolvePlacementAgentId(cfg, accountId)
      for (const check of checkPlacement({ cfg, handle, apiKey, apiBase, identityLine: cachedIdentityLine(accountId), agentId, accountId, keySource, env })) {
        if (check.ok && !check.notice) continue
        // Where the key sits on disk is a security warning (`security.collectWarnings` → `keyAtRestWarnings`): doctor shows it
        // under Security, and its read-only runs (--lint) too, which never call this hook.
        if (check.atRest) continue
        if (check.name === 'manual' && manualReported) continue
        const fix = check.name === 'mcp' && check.repair && !check.ok ? ` (${doctorFixCommand} adds it)` : ''
        warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] ${check.name}: ${check.detail}${fix}`)
      }
      manualReported = true
      const bound = resolveBoundAgentId(cfg, AGENTCHAT_CHANNEL_ID, accountId)
      const ambient = resolveOpenClawDefaultAgentId(cfg)
      if (bound && bound !== (ambient ?? bound) && !readLlmAgentOverrideOptIn(cfg)) {
        warnings.push(
          `[${AGENTCHAT_CHANNEL_ID}:${accountId}] gate: this account is bound to agent "${bound}", not OpenClaw's default — the gate call is refused (LLM_COMPLETION_NOT_AUTHORIZED) until ${LLM_AGENT_OVERRIDE_PATH} is true (${doctorFixCommand} writes it)`,
        )
      }
    }
    // A turn the running integration (this process) has held past 30 minutes,
    // or a conversation held after a gateway restart.
    // And cycles that decided nothing several times in a row.
    // And could not process: a conversation the server paused for this agent,
    // and the kit's counts when one needs a look (within the last hour a
    // report failed or the gate's split stopped; the last runtime check failed).
    for (const accountId of listActiveAccounts()) {
      const status = getIntegration(accountId)?.loop?.loop.status()
      if (!status) continue
      const turns = findAccountTurns(accountId)
      if (turns) {
        const hung = hungTurnsReason(turns, cfg)
        if (hung) warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] ${hung}`)
        for (const line of [...overdueTurnLines(turns.runningRuns(), cfg), ...restartHoldLines(turns)]) warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] ${line}`)
      }
      const trouble = cycleTroubleLine(status.recentCycles ?? [])
      if (trouble) warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] ${trouble}`)
      const couldNotProcess = couldNotProcessView(status.processingFailures, pausedConversations(accountId), recentTrouble(accountId))
      if (couldNotProcess.attention) warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] ${couldNotProcess.summary}`)
      for (const line of couldNotProcess.paused) warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] ${line}`)
    }
    return warnings
  },

  async repairConfig({ cfg }) {
    const changes: string[] = []
    const warnings: string[] = []
    let next: OpenClawConfig = cfg
    const bases = new Map<string, string | undefined>()
    // One identity line per workspace: with several accounts configured the
    // integration refuses to start and the line would flip between handles.
    const placeIdentityLines = multiAccountRefusal(cfg) === null
    // The manual is account-free: synced once, from the first enabled account's texts.
    let manualFrom: ServedTextsCopy | null = null
    let manualKey: { apiKey: string; apiBase: string; accountId: string } | null = null
    for (const accountId of listConfiguredAccountIds(cfg)) {
      // Disabled: the identity line and the tools entry are absent by design.
      if (!isAgentchatAccountEnabled(cfg, accountId)) continue
      const keySource = resolveAgentchatApiKey(cfg, accountId)
      const apiKey = keySource.ok ? keySource.apiKey : undefined
      const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase') ?? DEFAULT_API_BASE
      bases.set(apiBase, apiKey)
      if (!keySource.ok && !keySource.missing) warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] key: ${keySource.reason}`)
      if (keySource.ok) {
        const moved = moveKeyOutOfConfig(next, accountId, keySource, { placeDotEnv: placeIdentityLines })
        next = moved.cfg
        changes.push(...moved.changes)
        warnings.push(...moved.warnings.map((line) => `[${AGENTCHAT_CHANNEL_ID}:${accountId}] key: ${line}`))
      }
      // The handle the key authenticates as is the one config field only the
      // server knows. Missing (an older OpenClaw's non-interactive add could
      // not learn it before the write) → one live check per account.
      if (apiKey && !readAgentchatConfigField(cfg, accountId, 'agentHandle')) {
        try {
          const result = await checkApiKey(apiKey, { apiBase })
          if (result.ok) {
            next = applyAgentchatAccountPatch(next, accountId, { agentHandle: result.handle })
            changes.push(`set channels.agentchat${accountId === 'default' ? '' : `.accounts.${accountId}`}.agentHandle = ${result.handle}`)
          } else {
            warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] agentHandle not set and the key did not pass the live check (${result.code}): ${result.message}`)
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
      // just above), with the served text. Present → untouched, byte for byte.
      if (apiKey && manualKey === null) manualKey = { apiKey, apiBase, accountId }
      const handle = readAgentchatConfigField(next, accountId, 'agentHandle')
      if (apiKey && handle && placeIdentityLines) {
        const served = await loadServedTexts({ client: createSdkClient({ apiKey, apiBase }), accountId })
        manualFrom ??= served
        const restored = await restoreIdentityLine(next, accountId, handle, identityLineOf(served), identityTemplateOf(served))
        if (restored.outcome === 'placed') changes.push(`placed the identity line for @${handle.replace(/^@/, '')} in ${restored.path}`)
        else if (restored.outcome === 'updated') changes.push(`brought the identity line for @${handle.replace(/^@/, '')} in ${restored.path} to the served text`)
        else if (restored.outcome === 'left') warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] identity line for @${handle.replace(/^@/, '')} left as it is: ${restored.detail ?? ''}`)
        else if (restored.outcome === 'failed') warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] could not place the identity line for @${handle.replace(/^@/, '')}: ${restored.detail ?? 'unknown error'}`)
        else if (restored.outcome === 'skipped') warnings.push(`[${AGENTCHAT_CHANNEL_ID}:${accountId}] identity line for @${handle.replace(/^@/, '')} not placed: ${restored.detail ?? 'the served text is not available'}`)
      }
    }
    // The manual: the served one into OpenClaw's managed skills dir (someone
    // else's file there is left alone and reported).
    if (manualKey !== null) {
      const served = manualFrom ?? (await loadServedTexts({ client: createSdkClient({ apiKey: manualKey.apiKey, apiBase: manualKey.apiBase }), accountId: manualKey.accountId }))
      const step = manualStep(await placeManual({ texts: served.texts, source: served.source, apiBase: served.apiBase, cfg: next }))
      if (step.status === 'changed') changes.push(`manual: ${step.detail}`)
      else if (step.status === 'warned' || step.status === 'failed') warnings.push(`[${AGENTCHAT_CHANNEL_ID}] manual: ${step.detail}`)
    }
    // One hosted server entry per API base; every configured account on the
    // default base shares the single `agentchat` entry.
    for (const [apiBase, apiKey] of bases) {
      const result = withHostedMcpEntry(next, apiBase, apiKey)
      next = result.cfg
      if (result.outcome === 'added') changes.push(`added mcp.servers.agentchat → ${apiBase}/mcp (bearer template on AGENTCHAT_API_KEY)`)
      if (result.outcome === 'updated') changes.push(`updated mcp.servers.agentchat to name this client (${clientIdentityText()})`)
    }
    return { config: next, changes, ...(warnings.length > 0 ? { warnings } : {}) }
  },
}
