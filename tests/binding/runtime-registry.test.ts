/**
 * Integration-registry concurrency + lifecycle tests.
 *
 * The registry is the single source of truth for live integrations (socket
 * binding + receive loop + served texts) per account. It MUST serialize
 * concurrent registers for the same account, roll back on a start failure,
 * allow parallel registers for different accounts, and tear down cleanly.
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
import type { IntegrationLoop } from '../../src/integration/loop.js'

const makeConfig = (): AgentchatChannelConfig => ({
  apiKey: ['ac', 'live', 'key', 'a'.repeat(24)].join('_'),
  apiBase: 'https://api.agentchat.me',
  reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0.2 },
  ping: { intervalMs: 30000, timeoutMs: 10000 },
  outbound: { maxInFlight: 256, sendTimeoutMs: 15000 },
  observability: { logLevel: 'error', redactKeys: ['apiKey'] },
})

const makeLogger = () => createLogger({ level: 'error', redactKeys: ['apiKey'] })

class StubSocket {
  bound = 0
  stoppedCount = 0
  disconnects = 0
  static created = 0
  readonly realtime = { disconnect: () => void (this.disconnects += 1) }
  constructor() {
    StubSocket.created += 1
  }
  bind(): void {
    this.bound += 1
  }
  stopped(): void {
    this.stoppedCount += 1
  }
  getHealth() {
    return { state: 'ready' as const, connectedAt: null, counters: { wakeFrames: 0, disconnects: 0 } }
  }
}

const stubLoop = (failStart: boolean) => {
  const loop = {
    started: 0,
    stopped: 0,
    loop: {
      start: async () => {
        if (failStart) throw new Error('simulated start failure')
        loop.started += 1
      },
    },
    stop: async () => {
      loop.stopped += 1
    },
  }
  return loop
}

const stubTextsCache = () => {
  const t = { stopped: 0, stop() { this.stopped += 1 } }
  return t
}

function register(accountId: string, failStart = false) {
  const loop = stubLoop(failStart)
  const textsCache = stubTextsCache()
  return registerIntegration({
    accountId,
    config: makeConfig(),
    logger: makeLogger(),
    createSocket: () => new StubSocket() as unknown as IntegrationSocket,
    build: () => ({ loop: loop as unknown as IntegrationLoop, textsCache: textsCache as never, handlers: {} }),
  }).then((entry) => ({ entry, loop, textsCache }))
}

describe('runtime-registry', () => {
  beforeEach(async () => {
    await resetRegistryForTest()
    StubSocket.created = 0
  })

  it('registers an integration: binds the socket, starts the loop (which connects), and makes it retrievable', async () => {
    const { entry, loop } = await register('acct-1')
    expect((entry.socket as unknown as StubSocket).bound).toBe(1)
    expect(loop.started).toBe(1)
    expect(getIntegration('acct-1')).toBe(entry)
    expect(listActiveAccounts()).toEqual(['acct-1'])
  })

  it('stops the loop, reports the socket stopped, and stops the texts timer on unregister', async () => {
    const { entry, loop, textsCache } = await register('acct-1')
    await unregisterIntegration('acct-1')
    expect(getIntegration('acct-1')).toBeUndefined()
    expect(loop.stopped).toBe(1)
    expect((entry.socket as unknown as StubSocket).stoppedCount).toBe(1)
    expect(textsCache.stopped).toBe(1)
  })

  it('unregister of a missing account is a no-op', async () => {
    await expect(unregisterIntegration('nope')).resolves.toBeUndefined()
  })

  it('serializes concurrent registers for the same account — one live entry, earlier ones stopped', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => register('acct-hot')))
    const live = getIntegration('acct-hot')
    expect(live).toBeDefined()
    expect(results[results.length - 1]!.entry).toBe(live)
    expect(listActiveAccounts()).toEqual(['acct-hot'])
    expect(results.filter((r) => r.loop.stopped === 1)).toHaveLength(4)
  })

  it('allows parallel registers for different accounts', async () => {
    await Promise.all([register('acct-a'), register('acct-b'), register('acct-c')])
    expect(listActiveAccounts().sort()).toEqual(['acct-a', 'acct-b', 'acct-c'])
  })

  it('does not leak an entry when the loop fails to start, and stops what was built', async () => {
    let built: { loop: ReturnType<typeof stubLoop>; textsCache: ReturnType<typeof stubTextsCache> } | null = null
    const loop = stubLoop(true)
    const textsCache = stubTextsCache()
    await expect(
      registerIntegration({
        accountId: 'acct-broken',
        config: makeConfig(),
        logger: makeLogger(),
        createSocket: () => new StubSocket() as unknown as IntegrationSocket,
        build: () => {
          built = { loop, textsCache }
          return { loop: loop as unknown as IntegrationLoop, textsCache: textsCache as never, handlers: {} }
        },
      }),
    ).rejects.toThrow(/start failure/)
    expect(built).not.toBeNull()
    expect(getIntegration('acct-broken')).toBeUndefined()
    expect(listActiveAccounts()).not.toContain('acct-broken')
    expect(loop.stopped).toBe(1)
    expect(textsCache.stopped).toBe(1)
  })
})
