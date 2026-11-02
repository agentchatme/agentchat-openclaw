import { describe, expect, it } from 'vitest'

import { createRuntimeGateCaller, createRuntimeTurnRunner, resolveDoorbellAgentId, RuntimeUnavailableError } from '../../src/doorbell/model.js'
import type { PluginRuntime } from 'openclaw/plugin-sdk/channel-core'

function fakeRuntime(overrides: { completeText?: string; runError?: Error; waitStatus?: string; waitThrows?: boolean } = {}) {
  const calls: { complete: unknown[]; run: unknown[]; wait: unknown[] } = { complete: [], run: [], wait: [] }
  const runtime = {
    llm: {
      complete: async (params: unknown) => {
        calls.complete.push(params)
        return { text: overrides.completeText ?? '{"decisions":[]}', provider: 'p', model: 'm', agentId: 'main', usage: {} }
      },
    },
    subagent: {
      run: async (params: unknown) => {
        calls.run.push(params)
        if (overrides.runError) throw overrides.runError
        return { runId: 'run_42' }
      },
      waitForRun: async (params: unknown) => {
        calls.wait.push(params)
        if (overrides.waitThrows) throw new Error('wait failed')
        return { status: overrides.waitStatus ?? 'ok' }
      },
    },
  } as unknown as PluginRuntime
  return { runtime, calls }
}

describe('createRuntimeGateCaller', () => {
  it('runs one tool-free completion on the agent\'s own model: system prompt, one user message, temperature 0, agentId', async () => {
    const { runtime, calls } = fakeRuntime({ completeText: 'answer' })
    const caller = createRuntimeGateCaller({ agentId: 'ops', runtime: () => runtime })
    const text = await caller({ systemPrompt: 'Q + wrapper', userContent: 'tray', maxTokens: 2048, timeoutMs: 1000 })
    expect(text).toBe('answer')
    const params = calls.complete[0] as Record<string, unknown>
    expect(params.systemPrompt).toBe('Q + wrapper')
    expect(params.messages).toEqual([{ role: 'user', content: 'tray' }])
    expect(params.maxTokens).toBe(2048)
    expect(params.temperature).toBe(0)
    expect(params.agentId).toBe('ops')
    expect(params.signal).toBeInstanceOf(AbortSignal)
  })

  it('throws RuntimeUnavailableError when setRuntime never happened (the gate then fails closed)', async () => {
    const caller = createRuntimeGateCaller({ agentId: 'main', runtime: () => null })
    await expect(caller({ systemPrompt: '', userContent: '', maxTokens: 1, timeoutMs: 1 })).rejects.toBeInstanceOf(RuntimeUnavailableError)
  })
})

describe('createRuntimeTurnRunner', () => {
  it('admits one run with deliver:false on the given session and lane, then waits for it', async () => {
    const { runtime, calls } = fakeRuntime()
    const run = createRuntimeTurnRunner({ runtime: () => runtime, waitMs: 1234 })
    const outcome = await run({ sessionKey: 'agent:main:subagent:agentchat-knock-x', prompt: 'P', lane: 'agentchat-doorbell:default' })
    expect(outcome).toEqual({ ran: true, runId: 'run_42', status: 'ok' })
    expect(calls.run[0]).toEqual({ sessionKey: 'agent:main:subagent:agentchat-knock-x', message: 'P', lane: 'agentchat-doorbell:default', deliver: false })
    expect(calls.wait[0]).toEqual({ runId: 'run_42', timeoutMs: 1234 })
  })

  it('reports a run that was not admitted', async () => {
    const { runtime } = fakeRuntime({ runError: new Error('lane busy') })
    const run = createRuntimeTurnRunner({ runtime: () => runtime })
    expect(await run({ sessionKey: 's', prompt: 'P', lane: 'l' })).toEqual({ ran: false, error: 'lane busy' })
  })

  it('a failed wait still counts as a run (the turn is OpenClaw\'s now)', async () => {
    const { runtime } = fakeRuntime({ waitThrows: true })
    const run = createRuntimeTurnRunner({ runtime: () => runtime })
    expect(await run({ sessionKey: 's', prompt: 'P', lane: 'l' })).toEqual({ ran: true, runId: 'run_42', status: 'unknown', error: 'wait failed' })
  })

  it('without a runtime the turn is not started and says why', async () => {
    const run = createRuntimeTurnRunner({ runtime: () => null })
    const outcome = await run({ sessionKey: 's', prompt: 'P', lane: 'l' })
    expect(outcome.ran).toBe(false)
    expect(outcome.error).toMatch(/setRuntime/)
  })
})

describe('resolveDoorbellAgentId', () => {
  it('asks OpenClaw\'s routing for this channel/account with a synthetic direct peer', () => {
    const seen: unknown[] = []
    const agentId = resolveDoorbellAgentId({
      cfg: { x: 1 },
      accountId: 'acct',
      channelRuntime: {
        routing: {
          resolveAgentRoute: (p) => {
            seen.push(p)
            return { agentId: 'ops', sessionKey: 'agent:ops:agentchat:direct:doorbell' }
          },
        },
      },
    })
    expect(agentId).toBe('ops')
    expect(seen[0]).toEqual({ cfg: { x: 1 }, channel: 'agentchat', accountId: 'acct', peer: { kind: 'direct', id: 'doorbell' } })
  })

  it('falls back to main when routing is absent or throws', () => {
    expect(resolveDoorbellAgentId({ cfg: {}, accountId: 'a', channelRuntime: undefined })).toBe('main')
    expect(
      resolveDoorbellAgentId({
        cfg: {},
        accountId: 'a',
        channelRuntime: {
          routing: {
            resolveAgentRoute: () => {
              throw new Error('no')
            },
          },
        },
      }),
    ).toBe('main')
  })
})
