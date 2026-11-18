/**
 * Configured-state predicate for the AgentChat channel.
 *
 * OpenClaw calls this to decide whether the channel has "enough" config to
 * be considered active (counts toward enabled channels, shown in UI, etc.).
 *
 * Bar: a key AND a non-empty `agentHandle`. The key is named by
 * `apiKeyFile` (the path of the `0600` key file setup writes) or, on an
 * install from before the key file, by a plain-text `apiKey` of plausible
 * length. This predicate stays pure — no filesystem read: the gateway and
 * `openclaw channels capabilities` read the file and say when it cannot be
 * used. Without the handle the runtime will start but the agent has no
 * identity to add to prompts or to use as a self-filter on inbound — both
 * downstream surfaces silently degrade. Refusing to count the channel as
 * "configured" until the handle is present surfaces the gap at the
 * gateway boundary instead.
 */

export interface MaybeConfigured {
  readonly apiKey?: unknown
  readonly apiKeyFile?: unknown
  readonly agentHandle?: unknown
}

export function hasAgentChatConfiguredState(config: MaybeConfigured | undefined): boolean {
  if (!config || typeof config !== 'object') return false
  const file = config.apiKeyFile
  const key = config.apiKey
  const namesKey = (typeof file === 'string' && file.trim().length > 0) || (typeof key === 'string' && key.length >= 20)
  if (!namesKey) return false
  const handle = config.agentHandle
  if (typeof handle !== 'string' || handle.trim().length === 0) return false
  return true
}
