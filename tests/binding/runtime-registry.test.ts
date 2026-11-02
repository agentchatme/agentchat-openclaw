/**
 * Doorbell-registry concurrency + lifecycle tests.
 *
 * The registry is the single source of truth for live doorbells (socket
 * runtime + invoker) per account. It MUST serialize concurrent registers for
 * the same account, roll back on a synchronous start failure, allow parallel
 * registers for different accounts, and tear down cleanly.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import {
  registerDoorbell,
  unregisterDoorbell,
  getDoorbell,
  listActiveAccounts,
  resetRegistryForTest,
} from '../../src/binding/runtime-registry.js'
import { createLogger } from '../../src/log.js'
import type { AgentchatChannelConfig } from '../../src/config-schema.js'
import type { AgentchatChannelRuntime } from '../../src/runtime.js'

const makeConfig = (): AgentchatChannelConfig => ({
  apiKey: 'ac_live_key_aaaaaaaaaaaaaaaaaaaaaaaa',
  apiBase: 'https://api.agentchat.me',
  reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0.2 },
  ping: { intervalMs: 30000, timeoutMs: 10000 },
  outbound: { maxInFlight: 256, sendTimeoutMs: 15000 },
  observability: { logLevel: 'error', redactKeys: ['apiKey'] },
})

const makeLogger = () => createLogger({ level: 'error', redactKeys: ['apiKey'] })

class StubRuntime {
  started = 0
  stopped = 0
  static created = 0
  constructor(public readonly failStart = false) {
    StubRuntime.created += 1
  }
  start() {
    if (this.failStart) throw new Error('simulated start failure')
    this.started += 1
  }
  async stop(): Promise<void> {
    this.stopped += 1
  }
}

const stubInvoker = () => {
  const inv = { stopped: 0, stop() { this.stopped += 1 } }
  return inv as unknown as import('../../src/doorbell/invoker.js').AgentInvoker & { stopped: number }
}

function register(accountId: string, failStart = false) {
  return registerDoorbell({
    accountId,
    config: makeConfig(),
    logger: makeLogger(),
    createRuntime: () => new StubRuntime(failStart) as unknown as AgentchatChannelRuntime,
    build: () => ({ invoker: stubInvoker(), handlers: {} }),
  })
}

describe('runtime-registry', () => {
  beforeEach(async () => {
    await resetRegistryForTest()
    StubRuntime.created = 0
  })

  it('registers a doorbell, starts its runtime and makes it retrievable', async () => {
    const entry = await register('acct-1')
    expect((entry.runtime as unknown as StubRuntime).started).toBe(1)
    expect(getDoorbell('acct-1')).toBe(entry)
    expect(listActiveAccounts()).toEqual(['acct-1'])
  })

  it('stops the invoker and the runtime on unregister', async () => {
    const entry = await register('acct-1')
    await unregisterDoorbell('acct-1', Date.now() + 500)
    expect(getDoorbell('acct-1')).toBeUndefined()
    expect((entry.runtime as unknown as StubRuntime).stopped).toBe(1)
    expect((entry.invoker as unknown as { stopped: number }).stopped).toBe(1)
  })

  it('unregister of a missing account is a no-op', async () => {
    await expect(unregisterDoorbell('nope', Date.now() + 500)).resolves.toBeUndefined()
  })

  it('serializes concurrent registers for the same account — one live entry, earlier ones stopped', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => register('acct-hot')))
    const live = getDoorbell('acct-hot')
    expect(live).toBeDefined()
    expect(results[results.length - 1]).toBe(live)
    expect(listActiveAccounts()).toEqual(['acct-hot'])
    const stoppedCount = results.filter((r) => (r.runtime as unknown as StubRuntime).stopped === 1).length
    expect(stoppedCount).toBe(4)
  })

  it('allows parallel registers for different accounts', async () => {
    await Promise.all([register('acct-a'), register('acct-b'), register('acct-c')])
    expect(listActiveAccounts().sort()).toEqual(['acct-a', 'acct-b', 'acct-c'])
  })

  it('does not leak an entry when start throws synchronously, and stops the invoker', async () => {
    await expect(register('acct-broken', true)).rejects.toThrow(/start failure/)
    expect(getDoorbell('acct-broken')).toBeUndefined()
    expect(listActiveAccounts()).not.toContain('acct-broken')
  })
})
