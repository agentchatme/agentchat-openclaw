/**
 * ChannelDirectoryAdapter — handle-prefix lookup against `/v1/directory`.
 *
 * AgentChat's directory is phone-book-style: exact handle or prefix match
 * only. No name/role/bio search (that's MoltBook's job). We expose this to
 * OpenClaw's shared directory surfaces so agents can autocomplete peers
 * from the normal compose/search UIs — and so the `search` message action
 * and `agentchat_search_directory` tool both route through the same code.
 *
 * `listGroups` / `listGroupMembers` map through conversations + group
 * participants. `self` returns the configured agent's public profile.
 */

import type {
  ChannelDirectoryAdapter,
  ChannelDirectoryEntry,
  OpenClawConfig,
} from './openclaw-types.js'

import { readChannelSection, readAccountRaw } from '../channel-account.js'
import { parseChannelConfig } from '../config-schema.js'
import { getClient } from './sdk-client.js'

function resolveAccount(cfg: OpenClawConfig | undefined, accountId?: string | null) {
  const section = readChannelSection(cfg)
  const raw = readAccountRaw(section, accountId ?? 'default')
  if (!raw) return null
  try {
    return parseChannelConfig(raw)
  } catch {
    return null
  }
}

function profileToEntry(agent: {
  readonly handle: string
  readonly display_name?: string | null
  readonly description?: string | null
  readonly avatar_url?: string | null
}): ChannelDirectoryEntry {
  return {
    kind: 'user',
    id: agent.handle,
    handle: agent.handle,
    name: agent.display_name ?? agent.handle,
    ...(agent.avatar_url ? { avatarUrl: agent.avatar_url } : {}),
  }
}

/**
 * Directory implementations are module-level functions, not object methods.
 *
 * OpenClaw's runtime directory surface forwards `self` / `listPeersLive` /
 * `listGroupsLive` / `listGroupMembers` as **detached** function references
 * (`createRuntimeDirectoryLiveAdapter` in the plugin SDK pulls the method off
 * the adapter and calls it standalone). A detached method has no `this`, so an
 * implementation that reached a sibling via `this.listGroups!(...)` threw
 * `Cannot read properties of undefined (reading 'listGroups')` and silently
 * failed the caller — e.g. resolving a group target for `addParticipant`,
 * which is why adding a member to a group crashed client-side.
 *
 * Standalone functions are `this`-free by construction, so they behave
 * identically whether invoked as `adapter.listGroupsLive(...)` or forwarded
 * detached. The `*Live` variants are literal aliases of their base impl so the
 * two can never drift.
 */

type SelfFn = NonNullable<ChannelDirectoryAdapter['self']>
type ListFn = NonNullable<ChannelDirectoryAdapter['listPeersLive']>
type MembersFn = NonNullable<ChannelDirectoryAdapter['listGroupMembers']>

const directorySelf: SelfFn = async ({ cfg, accountId }) => {
  const config = resolveAccount(cfg, accountId)
  if (!config) return null
  const client = getClient({ accountId: accountId ?? 'default', config })
  try {
    const me = await client.getMe()
    return profileToEntry(me)
  } catch {
    return null
  }
}

const listPeers: ListFn = async ({ cfg, accountId, query, limit }) => {
  const config = resolveAccount(cfg, accountId)
  if (!config) return []
  const q = (query ?? '').trim()
  if (q.length < 2) return []
  const client = getClient({ accountId: accountId ?? 'default', config })
  try {
    const result = await client.searchAgents(q, { limit: limit ?? 20 })
    return result.agents.map(profileToEntry)
  } catch {
    return []
  }
}

const listGroups: ListFn = async ({ cfg, accountId, query, limit }) => {
  const config = resolveAccount(cfg, accountId)
  if (!config) return []
  const client = getClient({ accountId: accountId ?? 'default', config })
  try {
    const convs = await client.listConversations()
    const q = (query ?? '').trim().toLowerCase()
    const groupRows = convs.filter((c) => c.type === 'group')
    const filtered = q
      ? groupRows.filter((c) => (c.group_name ?? '').toLowerCase().includes(q))
      : groupRows
    const cap = limit ?? 50
    return filtered.slice(0, cap).map((c) => ({
      kind: 'group' as const,
      id: c.id,
      name: c.group_name ?? 'Untitled group',
      ...(c.group_avatar_url ? { avatarUrl: c.group_avatar_url } : {}),
    }))
  } catch {
    return []
  }
}

const listGroupMembers: MembersFn = async ({ cfg, accountId, groupId, limit }) => {
  const config = resolveAccount(cfg, accountId)
  if (!config) return []
  const client = getClient({ accountId: accountId ?? 'default', config })
  try {
    const group = await client.getGroup(groupId)
    const cap = limit ?? 256
    return group.members.slice(0, cap).map((m) => ({
      kind: 'user' as const,
      id: m.handle,
      handle: m.handle,
      name: m.display_name ?? m.handle,
    }))
  } catch {
    return []
  }
}

export const agentchatDirectoryAdapter: ChannelDirectoryAdapter = {
  self: directorySelf,
  listPeers,
  // `*Live` are literal aliases of the base impls — never `this.listPeers!`,
  // which breaks when the runtime forwards the method detached.
  listPeersLive: listPeers,
  listGroups,
  listGroupsLive: listGroups,
  listGroupMembers,
}
