import { describe, expect, it } from 'vitest'

import { isHardTimeout, runEndOf, watchRunUntilEnded } from '../../src/integration/run.js'
import type { PluginRuntime } from 'openclaw/plugin-sdk/channel-core'

const FULL = { requestedMs: 300_000, elapsedMs: 300_000 }
const QUICK = { requestedMs: 300_000, elapsedMs: 40 }

describe('runEndOf — a wait timeout is not an end', () => {
  it('ok and error are ends; "completed" in error is read as ok, as OpenClaw does', () => {
    expect(runEndOf({ status: 'ok' }, FULL)).toEqual({ ended: true, status: 'ok' })
    expect(runEndOf({ status: 'error', error: 'boom' }, FULL)).toEqual({ ended: true, status: 'error', error: 'boom' })
    expect(runEndOf({ status: 'error', error: ' Completed ' }, FULL)).toEqual({ ended: true, status: 'ok' })
  })

  it('pending and unknown statuses are not ends', () => {
    expect(runEndOf({ status: 'pending' }, QUICK)).toEqual({ ended: false })
    expect(runEndOf({ status: 'weird' }, QUICK)).toEqual({ ended: false })
    expect(runEndOf(null, QUICK)).toEqual({ ended: false })
  })

  it('OpenClaw main: a wait that elapses comes back bare ({ runId, status: timeout }, no snapshot) after the whole wait — not an end', () => {
    expect(runEndOf({ runId: 'r', status: 'timeout' } as never, FULL)).toEqual({ ended: false })
  })

  describe('with the wait metadata (OpenClaw ≥ 2026.10): OpenClaw’s own rule', () => {
    it('a queued run and a lifecycle reset are not ends, however fast they came back', () => {
      expect(runEndOf({ status: 'timeout', timeoutPhase: 'queue' }, QUICK)).toEqual({ ended: false })
      expect(runEndOf({ status: 'timeout', timeoutPhase: 'queue', providerStarted: false }, FULL)).toEqual({ ended: false })
      expect(runEndOf({ status: 'timeout', timeoutPhase: 'gateway_draining' }, FULL)).toEqual({ ended: false })
    })

    it('a timeout with a pending error may still recover: not an end', () => {
      expect(runEndOf({ status: 'timeout', pendingError: true, error: 'rate limited', startedAt: 1 }, FULL)).toEqual({ ended: false })
    })

    it('the run’s own deadline is an end: endedAt, stopReason, livenessState or an error', () => {
      expect(runEndOf({ status: 'timeout', endedAt: 123 }, FULL)).toEqual({ ended: true, status: 'timeout' })
      expect(runEndOf({ status: 'timeout', stopReason: 'hard_timeout', startedAt: 1 }, FULL)).toEqual({ ended: true, status: 'timeout' })
      expect(runEndOf({ status: 'timeout', livenessState: 'abandoned', startedAt: 1 }, FULL)).toEqual({ ended: true, status: 'timeout' })
      expect(runEndOf({ status: 'timeout', error: 'run timed out', startedAt: 1 }, FULL)).toEqual({ ended: true, status: 'timeout', error: 'run timed out' })
    })
  })

  describe('the hard_timeout reading (OpenClaw resolveAgentRunTerminalFacts)', () => {
    it('a snapshot without endedAt is an end when its phase only the run’s own deadline reports', () => {
      for (const timeoutPhase of ['preflight', 'provider', 'tool_execution', 'post_turn']) {
        expect(runEndOf({ status: 'timeout', timeoutPhase }, FULL), timeoutPhase).toEqual({ ended: true, status: 'timeout' })
      }
    })

    it('a timeout after the provider started is an end — unless the stop was a restart', () => {
      expect(runEndOf({ status: 'timeout', providerStarted: true }, FULL)).toEqual({ ended: true, status: 'timeout' })
      expect(isHardTimeout({ status: 'timeout', providerStarted: true, stopReason: 'restart' })).toBe(false)
      expect(isHardTimeout({ status: 'timeout', timeoutPhase: 'queue', providerStarted: false })).toBe(false)
    })
  })

  describe('without the metadata (OpenClaw 2026.6 / 2026.7 lines): the timing tells', () => {
    it('a timeout answered at once came from the run’s terminal record: an end', () => {
      expect(runEndOf({ status: 'timeout' }, QUICK)).toEqual({ ended: true, status: 'timeout' })
      expect(runEndOf({ status: 'timeout', error: 'aborted' }, QUICK)).toEqual({ ended: true, status: 'timeout', error: 'aborted' })
    })

    it('a timeout that took the whole wait is an elapsed wait (or a pending error): not an end', () => {
      expect(runEndOf({ status: 'timeout' }, FULL)).toEqual({ ended: false })
      expect(runEndOf({ status: 'timeout', error: 'provider overloaded' }, { requestedMs: 300_000, elapsedMs: 299_000 })).toEqual({ ended: false })
    })
  })
})

describe('watchRunUntilEnded', () => {
  function runtimeAnswering(answers: Array<unknown | Error>): { runtime: PluginRuntime; waits: number } {
    const state = { waits: 0 }
    const runtime = {
      subagent: {
        waitForRun: async () => {
          state.waits += 1
          const next = answers.shift()
          if (next instanceof Error) throw next
          return next
        },
      },
    } as unknown as PluginRuntime
    return {
      runtime,
      get waits() {
        return state.waits
      },
    }
  }

  it('keeps waiting through elapsed waits and pending observations, and spaces fast non-terminal answers', async () => {
    const fake = runtimeAnswering([{ status: 'timeout', timeoutPhase: 'queue' }, { status: 'pending' }, { status: 'timeout', endedAt: 9 }])
    const slept: number[] = []
    let clock = 0
    const result = await watchRunUntilEnded({
      runtime: () => fake.runtime,
      runId: 'r',
      chunkMs: 1_000_000,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock += ms
      },
    })
    expect(result).toMatchObject({ ended: true, status: 'timeout' })
    expect(fake.waits).toBe(3)
    // Both non-terminal answers came back instantly: each is spaced by 1 s so the watch never loops hot.
    expect(slept).toEqual([1_000, 1_000])
  })

  it('a run the gateway does not know is answered like an elapsed wait: it is not an end — the account hands it off later', async () => {
    let clock = 0
    const fake = runtimeAnswering([{ status: 'timeout', timeoutPhase: 'queue', providerStarted: false }, { status: 'timeout', timeoutPhase: 'queue', providerStarted: false }, { status: 'ok' }])
    const still: number[] = []
    const result = await watchRunUntilEnded({ runtime: () => fake.runtime, runId: 'r', chunkMs: 1_000, now: () => clock, sleep: async (ms) => void (clock += ms), onStillRunning: (ms) => still.push(ms) })
    expect(still).toHaveLength(2)
    expect(result).toMatchObject({ ended: true, status: 'ok' })
  })

  it('the back-off repeats its last step', async () => {
    const fake = runtimeAnswering([new Error('a'), new Error('b'), new Error('c'), { status: 'ok' }])
    const slept: number[] = []
    const result = await watchRunUntilEnded({ runtime: () => fake.runtime, runId: 'r', retryMs: [10, 20], sleep: async (ms) => void slept.push(ms) })
    expect(result).toMatchObject({ ended: true, status: 'ok' })
    expect(slept).toEqual([10, 20, 20])
  })
})

// Counting the AgentChat calls in the transcript: ./agentchat-calls.test.ts (OpenClaw's own row shapes).
