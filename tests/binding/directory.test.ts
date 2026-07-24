/**
 * directory: `this`-binding safety.
 *
 * OpenClaw's runtime directory surface (`createRuntimeDirectoryLiveAdapter`)
 * forwards `self` / `listPeersLive` / `listGroupsLive` / `listGroupMembers` as
 * **detached** function references — it pulls the method off the adapter and
 * calls it standalone, so `this` is `undefined`. The previous
 * `this.listGroups!(params)` form threw `Cannot read properties of undefined
 * (reading 'listGroups')`, which silently broke group-member resolution (a
 * real crash when adding a participant to a group). These tests lock in the
 * `this`-free contract so we can never regress.
 */
import { describe, expect, it } from 'vitest'

import { agentchatDirectoryAdapter } from '../../src/binding/directory.js'

// A cfg with no agentchat channel makes resolveAccount() return null, so the
// impls short-circuit to [] before any network call. `runtime` is unused by
// these methods; both are cast because their exact shape is irrelevant here.
const noAccountParams = {
  cfg: {},
  accountId: 'default',
  query: 'anything',
  runtime: {},
} as unknown as Parameters<NonNullable<typeof agentchatDirectoryAdapter.listGroupsLive>>[0]

describe('agentchatDirectoryAdapter — `this`-free directory methods', () => {
  it('`*Live` are the exact same function ref as their base impl (cannot drift)', () => {
    expect(agentchatDirectoryAdapter.listGroupsLive).toBe(agentchatDirectoryAdapter.listGroups)
    expect(agentchatDirectoryAdapter.listPeersLive).toBe(agentchatDirectoryAdapter.listPeers)
  })

  it('listGroupsLive works when pulled off the adapter (regression: this.listGroups)', async () => {
    const { listGroupsLive } = agentchatDirectoryAdapter
    expect(listGroupsLive).toBeDefined()
    // Detached call — `this` is undefined, exactly like the SDK forwarder.
    await expect(listGroupsLive!(noAccountParams)).resolves.toEqual([])
  })

  it('listPeersLive works when pulled off the adapter', async () => {
    const { listPeersLive } = agentchatDirectoryAdapter
    expect(listPeersLive).toBeDefined()
    await expect(listPeersLive!(noAccountParams)).resolves.toEqual([])
  })
})
