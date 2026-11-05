import { describe, expect, it } from 'vitest'

import {
  createRuntimeModelCall,
  createRuntimeTurnStarter,
  resolveIntegrationAgentId,
  resolveGateAgent,
  readLlmAgentOverrideOptIn,
  withLlmAgentOverrideOptIn,
  LLM_AGENT_OVERRIDE_PATH,
  RuntimeUnavailableError,
  DEFAULT_GATE_MAX_TOKENS,
} from '../../src/integration/model.js'
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

describe('createRuntimeModelCall — the gate is a tool-free completion', () => {
  it('default path: the rendered prompt as one user message, no system prompt, NO tools, temperature 0, NO agentId', async () => {
    const { runtime, calls } = fakeRuntime({ completeText: 'answer' })
    const callModel = createRuntimeModelCall({ runtime: () => runtime, timeoutMs: 1000 })
    const text = await callModel('rendered gate prompt')
    expect(text).toBe('answer')
    const params = calls.complete[0] as Record<string, unknown>
    expect(params.messages).toEqual([{ role: 'user', content: 'rendered gate prompt' }])
    expect('systemPrompt' in params).toBe(false)
    expect('tools' in params).toBe(false)
    expect(params.maxTokens).toBe(DEFAULT_GATE_MAX_TOKENS)
    expect(params.temperature).toBe(0)
    // OpenClaw 2026.10.9 rejects any agentId as an override unless
    // plugins.entries.agentchat.llm.allowAgentIdOverride is set; the
    // default path must not send one at all.
    expect('agentId' in params).toBe(false)
    expect(params.signal).toBeInstanceOf(AbortSignal)
  })

  it('override path: passes agentId only when the account is routed to a non-default agent', async () => {
    const { runtime, calls } = fakeRuntime({ completeText: 'answer' })
    const callModel = createRuntimeModelCall({ agentIdOverride: 'ops', runtime: () => runtime })
    await callModel('p')
    expect((calls.complete[0] as Record<string, unknown>).agentId).toBe('ops')
  })

  it('throws RuntimeUnavailableError when setRuntime never happened (the gate then fails closed)', async () => {
    const callModel = createRuntimeModelCall({ runtime: () => null })
    await expect(callModel('p')).rejects.toBeInstanceOf(RuntimeUnavailableError)
  })
})

describe('resolveGateAgent + the llm override opt-in', () => {
  it('no override when the routed agent is the ambient default (or the default is unknown and routing fell back)', () => {
    expect(resolveGateAgent({ routedAgentId: 'main', ambientAgentId: 'main' })).toEqual({ agentId: 'main', agentIdOverride: undefined })
    expect(resolveGateAgent({ routedAgentId: 'Main', ambientAgentId: 'main' })).toEqual({ agentId: 'main', agentIdOverride: undefined })
    expect(resolveGateAgent({ routedAgentId: 'main', ambientAgentId: undefined })).toEqual({ agentId: 'main', agentIdOverride: undefined })
  })

  it('an override when the account is bound to another agent', () => {
    expect(resolveGateAgent({ routedAgentId: 'ops', ambientAgentId: 'main' })).toEqual({ agentId: 'ops', agentIdOverride: 'ops' })
  })

  it('reads and writes plugins.entries.agentchat.llm.allowAgentIdOverride', () => {
    expect(LLM_AGENT_OVERRIDE_PATH).toBe('plugins.entries.agentchat.llm.allowAgentIdOverride')
    expect(readLlmAgentOverrideOptIn({})).toBe(false)
    const written = withLlmAgentOverrideOptIn({ plugins: { entries: { agentchat: { enabled: true } } } })
    expect(written.changed).toBe(true)
    expect(written.cfg).toEqual({ plugins: { entries: { agentchat: { enabled: true, llm: { allowAgentIdOverride: true } } } } })
    expect(readLlmAgentOverrideOptIn(written.cfg)).toBe(true)
    expect(withLlmAgentOverrideOptIn(written.cfg).changed).toBe(false)
  })
})

describe('createRuntimeTurnStarter — admission first, completion later', () => {
  it('admits one run with deliver:false on the given session and lane, and resolves `done` once it is waited for', async () => {
    const { runtime, calls } = fakeRuntime()
    const start = createRuntimeTurnStarter({ runtime: () => runtime, waitMs: 1234 })
    const admission = await start({ sessionKey: 'agent:main:subagent:agentchat-wake-x', prompt: 'P', lane: 'agentchat-integration:default' })
    expect(admission.ran).toBe(true)
    if (!admission.ran) throw new Error('unreachable')
    expect(admission.runId).toBe('run_42')
    expect(calls.run[0]).toEqual({ sessionKey: 'agent:main:subagent:agentchat-wake-x', message: 'P', lane: 'agentchat-integration:default', deliver: false })
    expect(await admission.done).toEqual({ ran: true, runId: 'run_42', status: 'ok' })
    expect(calls.wait[0]).toEqual({ runId: 'run_42', timeoutMs: 1234 })
  })

  it('reports a run that was not admitted', async () => {
    const { runtime } = fakeRuntime({ runError: new Error('lane busy') })
    const start = createRuntimeTurnStarter({ runtime: () => runtime })
    expect(await start({ sessionKey: 's', prompt: 'P', lane: 'l' })).toEqual({ ran: false, error: 'lane busy' })
  })

  it("a failed wait still counts as a run (the turn is OpenClaw's now)", async () => {
    const { runtime } = fakeRuntime({ waitThrows: true })
    const start = createRuntimeTurnStarter({ runtime: () => runtime })
    const admission = await start({ sessionKey: 's', prompt: 'P', lane: 'l' })
    expect(admission.ran).toBe(true)
    if (!admission.ran) throw new Error('unreachable')
    expect(await admission.done).toEqual({ ran: true, runId: 'run_42', status: 'unknown', error: 'wait failed' })
  })

  it('without a runtime the turn is not started and says why', async () => {
    const start = createRuntimeTurnStarter({ runtime: () => null })
    const admission = await start({ sessionKey: 's', prompt: 'P', lane: 'l' })
    expect(admission.ran).toBe(false)
    if (admission.ran) throw new Error('unreachable')
    expect(admission.error).toMatch(/setRuntime/)
  })
})

describe('resolveIntegrationAgentId', () => {
  it("asks OpenClaw's routing for this channel/account with a synthetic direct peer", () => {
    const seen: unknown[] = []
    const agentId = resolveIntegrationAgentId({
      cfg: { x: 1 },
      accountId: 'acct',
      channelRuntime: {
        routing: {
          resolveAgentRoute: (p) => {
            seen.push(p)
            return { agentId: 'ops', sessionKey: 'agent:ops:agentchat:direct:wake' }
          },
        },
      },
    })
    expect(agentId).toBe('ops')
    expect(seen[0]).toEqual({ cfg: { x: 1 }, channel: 'agentchat', accountId: 'acct', peer: { kind: 'direct', id: 'wake' } })
  })

  it('falls back to main when routing is absent or throws', () => {
    expect(resolveIntegrationAgentId({ cfg: {}, accountId: 'a', channelRuntime: undefined })).toBe('main')
    expect(
      resolveIntegrationAgentId({
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
