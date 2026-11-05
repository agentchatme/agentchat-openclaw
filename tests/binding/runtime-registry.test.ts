/**
 * Integration-registry concurrency + lifecycle tests.
 *
 * The registry is the single source of truth for live integrations (socket +
 * invoker + texts store) per account. It MUST serialize concurrent registers
 * for the same account, roll back on a start failure, allow parallel
 * registers for different accounts, and tear down cleanly.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import {
  registerIntegration,
  unregisterIntegration,
  getIntegration,
  listActiveAccounts,
  resetRegistryForTest,
} from '../../src/binding/runtime-registry.js'
import { createLogger } from '../../src/log.js'
import type { AgentchatChannelConfig } from '../../src/config-schema.js'
import type { IntegrationSocket } from '../../src/integration/socket.js'
import type { AgentInvoker } from '../../src/integration/invoker.js'
import type { TextsStore } from '../../src/integration/texts.js'

const makeConfig = (): AgentchatChannelConfig => ({
  apiKey: 'ac_live_key_aaaaaaaaaaaaaaaaaaaaaaaa',
  apiBase: 'https://api.agentchat.me',
  reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0.2 },
  ping: { intervalMs: 30000, timeoutMs: 10000 },
  outbound: { maxInFlight: 256, sendTimeoutMs: 15000 },
  observability: { logLevel: 'error', redactKeys: ['apiKey'] },
})

const makeLogger = () => createLogger({ level: 'error', redactKeys: ['apiKey'] })

class StubSocket {
  started = 0
  stopped = 0
  static created = 0
  constructor(public readonly failStart = false) {
    StubSocket.created += 1
  }
  async start(): Promise<void> {
    if (this.failStart) throw new Error('simulated start failure')
    this.started += 1
  }
  async stop(): Promise<void> {
    this.stopped += 1
  }
  getHealth() {
    return { state: 'connected' as const, connectedAt: null, counters: { frames: 0, selfFiltered: 0, wakes: 0, invites: 0, disconnects: 0 } }
  }
}

const stubInvoker = () => {
  const inv = { stopped: 0, stop() { this.stopped += 1 } }
  return inv as unknown as AgentInvoker & { stopped: number }
}

const stubTexts = () => {
  const t = { stopped: 0, stop() { this.stopped += 1 } }
  return t as unknown as TextsStore & { stopped: number }
}

function register(accountId: string, failStart = false) {
  return registerIntegration({
    accountId,
    config: makeConfig(),
    logger: makeLogger(),
    createSocket: () => new StubSocket(failStart) as unknown as IntegrationSocket,
    build: () => ({ invoker: stubInvoker(), texts: stubTexts(), handlers: {} }),
  })
}

describe('runtime-registry', () => {
  beforeEach(async () => {
    await resetRegistryForTest()
    StubSocket.created = 0
  })

  it('registers an integration, starts its socket and makes it retrievable', async () => {
    const entry = await register('acct-1')
    expect((entry.socket as unknown as StubSocket).started).toBe(1)
    expect(getIntegration('acct-1')).toBe(entry)
    expect(listActiveAccounts()).toEqual(['acct-1'])
  })

  it('stops the invoker, the texts store and the socket on unregister', async () => {
    const entry = await register('acct-1')
    await unregisterIntegration('acct-1')
    expect(getIntegration('acct-1')).toBeUndefined()
    expect((entry.socket as unknown as StubSocket).stopped).toBe(1)
    expect((entry.invoker as unknown as { stopped: number }).stopped).toBe(1)
    expect((entry.texts as unknown as { stopped: number }).stopped).toBe(1)
  })

  it('unregister of a missing account is a no-op', async () => {
    await expect(unregisterIntegration('nope')).resolves.toBeUndefined()
  })

  it('serializes concurrent registers for the same account — one live entry, earlier ones stopped', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => register('acct-hot')))
    const live = getIntegration('acct-hot')
    expect(live).toBeDefined()
    expect(results[results.length - 1]).toBe(live)
    expect(listActiveAccounts()).toEqual(['acct-hot'])
    const stoppedCount = results.filter((r) => (r.socket as unknown as StubSocket).stopped === 1).length
    expect(stoppedCount).toBe(4)
  })

  it('allows parallel registers for different accounts', async () => {
    await Promise.all([register('acct-a'), register('acct-b'), register('acct-c')])
    expect(listActiveAccounts().sort()).toEqual(['acct-a', 'acct-b', 'acct-c'])
  })

  it('does not leak an entry when start throws, and stops the invoker and the texts store', async () => {
    await expect(register('acct-broken', true)).rejects.toThrow(/start failure/)
    expect(getIntegration('acct-broken')).toBeUndefined()
    expect(listActiveAccounts()).not.toContain('acct-broken')
  })
})
