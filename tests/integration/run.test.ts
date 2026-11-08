import { describe, expect, it } from 'vitest'

import { countAgentChatCalls, runEndOf, watchRunUntilEnded } from '../../src/integration/run.js'
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

  describe('with the wait metadata (OpenClaw ≥ 2026.10): OpenClaw’s own rule', () => {
    it('a bare elapsed wait is not an end, however fast it came back', () => {
      expect(runEndOf({ status: 'timeout', timeoutPhase: 'provider' }, QUICK)).toEqual({ ended: false })
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

  describe('without the metadata (OpenClaw ≤ 2026.6.x): the timing tells', () => {
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

  it('a gateway that no longer knows the run ends the watch (it cannot be running)', async () => {
    const fake = runtimeAnswering([new Error('agent run was not found')])
    const result = await watchRunUntilEnded({ runtime: () => fake.runtime, runId: 'r', sleep: async () => undefined })
    expect(result).toMatchObject({ ended: true, status: 'error', error: 'agent run was not found' })
  })

  it('the back-off repeats its last step', async () => {
    const fake = runtimeAnswering([new Error('a'), new Error('b'), new Error('c'), { status: 'ok' }])
    const slept: number[] = []
    const result = await watchRunUntilEnded({ runtime: () => fake.runtime, runId: 'r', retryMs: [10, 20], sleep: async (ms) => void slept.push(ms) })
    expect(result).toMatchObject({ ended: true, status: 'ok' })
    expect(slept).toEqual([10, 20, 20])
  })
})

describe('countAgentChatCalls — from the run transcript', () => {
  it('counts direct hosted-tool results and their failures', () => {
    expect(
      countAgentChatCalls([
        { role: 'user', content: 'wake' },
        { role: 'assistant', content: [{ type: 'toolCall', name: 'agentchat__agentchat_inbox' }] },
        { role: 'toolResult', toolName: 'agentchat__agentchat_inbox', isError: false },
        { role: 'toolResult', toolName: 'agentchat__agentchat_get_conversation', isError: true },
        { role: 'toolResult', toolName: 'web_search', isError: false },
      ]),
    ).toEqual({ total: 2, failed: 1 })
  })

  it('counts calls made through the tool-search surface (`tool_call` naming the agentchat MCP server)', () => {
    const viaToolCall = (isError: boolean, details: unknown) => ({ type: 'message', message: { role: 'toolResult', toolName: 'tool_call', isError, details } })
    expect(
      countAgentChatCalls([
        viaToolCall(false, { tool: { id: 'mcp:agentchat:agentchat__agentchat_send_message', name: 'agentchat__agentchat_send_message', sourceName: 'agentchat', mcp: { serverName: 'agentchat' } } }),
        viaToolCall(false, { tool: { mcp: { serverName: 'agentchat' } } }),
        // A tool_call that failed validation never reached a tool: not an AgentChat call.
        viaToolCall(true, {}),
        viaToolCall(false, { tool: { name: 'browser__open', mcp: { serverName: 'browser' } } }),
      ]),
    ).toEqual({ total: 2, failed: 0 })
  })

  it('a run that looked at nothing is zero calls — when the transcript is readable', () => {
    expect(countAgentChatCalls([{ role: 'user', content: 'wake' }, { role: 'assistant', content: 'nothing to do' }])).toEqual({ total: 0, failed: 0 })
  })

  it('unknown — never zero — when the transcript says nothing usable', () => {
    expect(countAgentChatCalls([])).toBeNull()
    expect(countAgentChatCalls([{ kind: 'header' }, 'x', null])).toBeNull()
  })

  it('skips rows of another run in the same session', () => {
    expect(
      countAgentChatCalls(
        [
          { role: 'toolResult', toolName: 'agentchat__agentchat_inbox', isError: false, __openclaw: { runId: 'old' } },
          { role: 'toolResult', toolName: 'agentchat__agentchat_inbox', isError: false, __openclaw: { runId: 'this' } },
        ],
        'this',
      ),
    ).toEqual({ total: 1, failed: 0 })
  })
})
