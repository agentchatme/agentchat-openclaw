import { describe, expect, it } from 'vitest'
import * as path from 'node:path'

import {
  createRuntimeCheck,
  createRuntimeModelCall,
  createRuntimeTurnStarter,
  resolveIntegrationAgentId,
  resolveGateAgent,
  readLlmAgentOverrideOptIn,
  withLlmAgentOverrideOptIn,
  LLM_AGENT_OVERRIDE_PATH,
  RuntimeUnavailableError,
  DEFAULT_GATE_MAX_TOKENS,
  RUNTIME_CHECK_MAX_TOKENS,
  RUNTIME_CHECK_PROMPT,
  RUNTIME_CHECK_TIMEOUT_MS,
  turnReadiness,
  readLiveConfig,
} from '../../src/integration/model.js'
import type { PluginRuntime } from 'openclaw/plugin-sdk/channel-core'
import { testKey } from '../helpers/keys.js'
import { assistantCalls, mcpOk, mcpServerError, userPrompt, withSeq } from '../helpers/openclaw-rows.js'

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

  it('the kit loop’s deadline reaches OpenClaw: its signal aborts the completion together with our own timeout', async () => {
    const { runtime, calls } = fakeRuntime({ completeText: 'answer' })
    const callModel = createRuntimeModelCall({ runtime: () => runtime, timeoutMs: 60_000 })
    const deadline = new AbortController()
    await callModel('p', { signal: deadline.signal })
    const passed = (calls.complete[0] as { signal: AbortSignal }).signal
    expect(passed).toBeInstanceOf(AbortSignal)
    expect(passed.aborted).toBe(false)
    deadline.abort(new Error('gate-call deadline'))
    expect(passed.aborted).toBe(true)
  })

  it('throws RuntimeUnavailableError when setRuntime never happened (the gate then fails closed)', async () => {
    const callModel = createRuntimeModelCall({ runtime: () => null })
    await expect(callModel('p')).rejects.toBeInstanceOf(RuntimeUnavailableError)
  })
})

describe('createRuntimeCheck — could not process: does the agent’s model answer now?', () => {
  it('one minimal completion on the gate’s own path: the fixed prompt as one user message, NO tools, no system prompt, the gate’s output cap, temperature 0, NO agentId, a signal', async () => {
    const { runtime, calls } = fakeRuntime({ completeText: 'OK' })
    const check = createRuntimeCheck({ runtime: () => runtime })
    expect(await check()).toEqual({ ok: true })
    expect(calls.complete).toHaveLength(1)
    const params = calls.complete[0] as Record<string, unknown>
    expect(params.messages).toEqual([{ role: 'user', content: RUNTIME_CHECK_PROMPT }])
    expect(RUNTIME_CHECK_PROMPT).toBe('Reply with the single word OK.')
    expect('tools' in params).toBe(false)
    expect('systemPrompt' in params).toBe(false)
    // The gate's cap: a model that reasons first needs room, or it answers with no text and the check fails while the gate works.
    expect(params.maxTokens).toBe(RUNTIME_CHECK_MAX_TOKENS)
    expect(RUNTIME_CHECK_MAX_TOKENS).toBe(DEFAULT_GATE_MAX_TOKENS)
    expect(params.temperature).toBe(0)
    expect('agentId' in params).toBe(false)
    expect(params.purpose).toMatch(/runtime check/)
    expect(params.signal).toBeInstanceOf(AbortSignal)
    // The bound: 45 s, inside the kit's own 60 s ceiling.
    expect(RUNTIME_CHECK_TIMEOUT_MS).toBe(45_000)
  })

  it('the same agent the gate asks: agentId only when the account is routed to a non-default agent', async () => {
    const { runtime, calls } = fakeRuntime({ completeText: 'OK' })
    await createRuntimeCheck({ agentIdOverride: 'ops', runtime: () => runtime })()
    expect((calls.complete[0] as Record<string, unknown>).agentId).toBe('ops')
  })

  it('the answer is discarded: any words pass, nothing of it comes back', async () => {
    const { runtime } = fakeRuntime({ completeText: 'Sure — OK!' })
    expect(await createRuntimeCheck({ runtime: () => runtime })()).toEqual({ ok: true })
  })

  it('fails on an empty answer, a thrown call (a provider refusal, the account signed out) and a missing runtime; it never throws', async () => {
    const empty = fakeRuntime({ completeText: '   ' })
    expect(await createRuntimeCheck({ runtime: () => empty.runtime })()).toEqual({ ok: false, detail: 'the model answered with no text' })
    const refusing = {
      llm: {
        complete: async () => {
          throw new Error('401 the provider rejected the credentials')
        },
      },
    } as unknown as PluginRuntime
    expect(await createRuntimeCheck({ runtime: () => refusing })()).toEqual({ ok: false, detail: '401 the provider rejected the credentials' })
    const none = await createRuntimeCheck({ runtime: () => null })()
    expect(none.ok).toBe(false)
    expect(none.detail).toMatch(/runtime check/)
  })

  it('bounded: a model that does not answer within the bound fails the check (its signal aborts the call)', async () => {
    const hanging = {
      llm: {
        complete: (params: { signal?: AbortSignal }) =>
          new Promise((_, reject) => params.signal?.addEventListener('abort', () => reject(new Error('aborted: no answer in time')), { once: true })),
      },
    } as unknown as PluginRuntime
    const answer = await createRuntimeCheck({ runtime: () => hanging, timeoutMs: 20 })()
    expect(answer).toEqual({ ok: false, detail: 'aborted: no answer in time' })
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

describe('createRuntimeTurnStarter — admission first, the confirmed end later', () => {
  it('admits one run with deliver:false on the given session and lane, and resolves `done` once OpenClaw reports the end', async () => {
    const { runtime, calls } = fakeRuntime()
    const start = createRuntimeTurnStarter({ runtime: () => runtime, waitChunkMs: 1234 })
    const admission = await start({ sessionKey: 'agent:main:subagent:agentchat-wake-x', prompt: 'P', lane: 'agentchat-integration:default' })
    expect(admission.ran).toBe(true)
    if (!admission.ran) throw new Error('unreachable')
    expect(admission.runId).toBe('run_42')
    expect(calls.run[0]).toEqual({ sessionKey: 'agent:main:subagent:agentchat-wake-x', message: 'P', lane: 'agentchat-integration:default', deliver: false })
    const outcome = await admission.done
    expect(outcome).toMatchObject({ ran: true, runId: 'run_42', status: 'ok' })
    expect(calls.wait[0]).toEqual({ runId: 'run_42', timeoutMs: 1234 })
  })

  it('reports a run that was not admitted', async () => {
    const { runtime } = fakeRuntime({ runError: new Error('lane busy') })
    const start = createRuntimeTurnStarter({ runtime: () => runtime })
    expect(await start({ sessionKey: 's', prompt: 'P', lane: 'l' })).toEqual({ ran: false, error: 'lane busy' })
  })

  it('a wait that elapses is not an end: the run is waited for again until OpenClaw reports it over', async () => {
    const answers = [{ status: 'timeout', timeoutPhase: 'queue' }, { status: 'pending' }, { status: 'ok', endedAt: 5 }]
    const waits: unknown[] = []
    const runtime = {
      subagent: {
        run: async () => ({ runId: 'run_7' }),
        waitForRun: async (params: unknown) => {
          waits.push(params)
          return answers.shift()
        },
        getSessionMessages: async () => ({ messages: [] }),
      },
    } as unknown as PluginRuntime
    const still: number[] = []
    const start = createRuntimeTurnStarter({ runtime: () => runtime, waitChunkMs: 60_000, onStillRunning: ({ elapsedMs }) => still.push(elapsedMs), sleep: async () => undefined })
    const admission = await start({ sessionKey: 's', prompt: 'P', lane: 'l' })
    if (!admission.ran) throw new Error('unreachable')
    expect(await admission.done).toMatchObject({ ran: true, runId: 'run_7', status: 'ok', agentchatCalls: null })
    expect(waits).toHaveLength(3)
    expect(still).toHaveLength(2)
  })

  it('a failed wait is not an end either: it is asked again after a back-off', async () => {
    let n = 0
    const runtime = {
      subagent: {
        run: async () => ({ runId: 'run_8' }),
        waitForRun: async () => {
          n += 1
          if (n < 3) throw new Error('gateway busy')
          return { status: 'error', error: 'model refused' }
        },
      },
    } as unknown as PluginRuntime
    const errors: Array<{ attempt: number; retryInMs: number }> = []
    const slept: number[] = []
    const start = createRuntimeTurnStarter({
      runtime: () => runtime,
      onWaitError: ({ attempt, retryInMs }) => errors.push({ attempt, retryInMs }),
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    const admission = await start({ sessionKey: 's', prompt: 'P', lane: 'l' })
    if (!admission.ran) throw new Error('unreachable')
    expect(await admission.done).toMatchObject({ status: 'error', error: 'model refused', agentchatCalls: null })
    expect(errors).toEqual([
      { attempt: 1, retryInMs: 1_000 },
      { attempt: 2, retryInMs: 5_000 },
    ])
    expect(slept).toEqual([1_000, 5_000])
  })

  it('the AgentChat calls are counted from the run transcript after the end', async () => {
    const runtime = {
      subagent: {
        run: async () => ({ runId: 'run_9' }),
        waitForRun: async () => ({ status: 'ok' }),
        getSessionMessages: async (params: unknown) => {
          expect(params).toEqual({ sessionKey: 'sk', limit: 200 })
          return {
            messages: withSeq([
              userPrompt(),
              assistantCalls([
                { id: 'call_inbox', name: 'agentchat__agentchat_inbox', arguments: {} },
                { id: 'call_send', name: 'agentchat__agentchat_send_message', arguments: {} },
              ]),
              mcpOk('2026.6.10', 'call_inbox', 'agentchat_inbox'),
              mcpServerError('2026.6.10', 'call_send', 'agentchat_send_message'),
            ]),
          }
        },
      },
    } as unknown as PluginRuntime
    const start = createRuntimeTurnStarter({ runtime: () => runtime })
    const admission = await start({ sessionKey: 'sk', prompt: 'P', lane: 'l' })
    if (!admission.ran) throw new Error('unreachable')
    expect(await admission.done).toMatchObject({ status: 'ok', agentchatCalls: { made: 2, failed: 1 } })
  })

  it('the transcript is read from the session OpenClaw accepted the run in (newer releases return a normalized key)', async () => {
    const reads: unknown[] = []
    const runtime = {
      subagent: {
        run: async () => ({ runId: 'run_11', sessionKey: 'agent:main:subagent:normalized' }),
        waitForRun: async () => ({ status: 'ok' }),
        getSessionMessages: async (params: unknown) => {
          reads.push(params)
          return {
            messages: withSeq([userPrompt(), assistantCalls([{ id: 'call_inbox', name: 'agentchat__agentchat_inbox', arguments: {} }]), mcpOk('2026.11.3', 'call_inbox', 'agentchat_inbox')]),
          }
        },
      },
    } as unknown as PluginRuntime
    const start = createRuntimeTurnStarter({ runtime: () => runtime })
    const admission = await start({ sessionKey: 'agent:main:subagent:asked', prompt: 'P', lane: 'l' })
    if (!admission.ran) throw new Error('unreachable')
    expect(admission.sessionKey).toBe('agent:main:subagent:normalized')
    expect(await admission.done).toMatchObject({ agentchatCalls: { made: 1, failed: 0 } })
    expect(reads).toEqual([{ sessionKey: 'agent:main:subagent:normalized', limit: 200 }])
  })

  it('a refused or empty transcript read is unknown (null) — never zero: the kit then defers rather than dismisses', async () => {
    for (const getSessionMessages of [
      async () => {
        throw new Error('sessions.get: not authorized for this plugin')
      },
      async () => ({ messages: [] }),
    ]) {
      const runtime = { subagent: { run: async () => ({ runId: 'run_12' }), waitForRun: async () => ({ status: 'ok' }), getSessionMessages } } as unknown as PluginRuntime
      const start = createRuntimeTurnStarter({ runtime: () => runtime })
      const admission = await start({ sessionKey: 's', prompt: 'P', lane: 'l' })
      if (!admission.ran) throw new Error('unreachable')
      expect(await admission.done).toMatchObject({ status: 'ok', agentchatCalls: null })
    }
  })

  it('a runtime that disappears before the end is `gone`, not an end', async () => {
    let present = true
    const runtime = {
      subagent: {
        run: async () => ({ runId: 'run_10' }),
        waitForRun: async () => {
          present = false
          return { status: 'timeout', timeoutPhase: 'queue' }
        },
      },
    } as unknown as PluginRuntime
    const start = createRuntimeTurnStarter({ runtime: () => (present ? runtime : null), sleep: async () => undefined })
    const admission = await start({ sessionKey: 's', prompt: 'P', lane: 'l' })
    if (!admission.ran) throw new Error('unreachable')
    expect(await admission.done).toMatchObject({ ran: true, runId: 'run_10', status: 'gone' })
  })

  it('without a runtime the turn is not started and says why', async () => {
    const start = createRuntimeTurnStarter({ runtime: () => null })
    const admission = await start({ sessionKey: 's', prompt: 'P', lane: 'l' })
    expect(admission.ran).toBe(false)
    if (admission.ran) throw new Error('unreachable')
    expect(admission.error).toMatch(/setRuntime/)
  })
})

describe('readLiveConfig — the current config, on every OpenClaw line', () => {
  it('OpenClaw main: runtime.config.current(); older releases: runtime.config.loadConfig(); neither: the snapshot', () => {
    const current = { mcp: { from: 'current' } }
    const loaded = { mcp: { from: 'loadConfig' } }
    expect(readLiveConfig({ snapshot: true }, () => ({ config: { current: () => current } }) as never)).toEqual({ cfg: current, live: true })
    expect(readLiveConfig({ snapshot: true }, () => ({ config: { loadConfig: () => loaded } }) as never)).toEqual({ cfg: loaded, live: true })
    expect(readLiveConfig({ snapshot: true }, () => ({ config: { current: () => { throw new Error('x') }, loadConfig: () => loaded } }) as never)).toEqual({ cfg: loaded, live: true })
    expect(readLiveConfig({ snapshot: true }, () => ({}) as never)).toEqual({ cfg: { snapshot: true }, live: false })
  })
})

describe('turnReadiness / withTurnReadiness — a turn only when it can have the hosted tools', () => {
  const apiBase = 'https://api.agentchat.me'
  const apiKey = testKey('k'.repeat(24))
  const ours = { mcp: { servers: { agentchat: { url: 'https://api.agentchat.me/mcp', transport: 'streamable-http', headers: { Authorization: 'Bearer ${AGENTCHAT_API_KEY}' } } } } }

  it('not ready without the mcp.servers.agentchat entry, or with it disabled', () => {
    expect(turnReadiness({ cfg: {}, apiBase, apiKey, env: { AGENTCHAT_API_KEY: apiKey } })).toEqual({
      ready: false,
      reason: expect.stringMatching(/mcp\.servers\.agentchat is not in the gateway config/),
    })
    const disabled = { mcp: { servers: { agentchat: { ...ours.mcp.servers.agentchat, enabled: false } } } }
    expect(turnReadiness({ cfg: disabled, apiBase, apiKey, env: { AGENTCHAT_API_KEY: apiKey } })).toEqual({
      ready: false,
      reason: expect.stringMatching(/mcp\.servers\.agentchat is disabled/),
    })
  })

  it('our entry is ready only when the key its bearer template names is in this process (a cold gateway holds the unresolved template)', () => {
    expect(turnReadiness({ cfg: ours, apiBase, apiKey, env: {} })).toEqual({
      ready: false,
      reason: expect.stringMatching(/AGENTCHAT_API_KEY is not set in the gateway process/),
    })
    expect(turnReadiness({ cfg: ours, apiBase, apiKey, env: { AGENTCHAT_API_KEY: '   ' } }).ready).toBe(false)
    expect(turnReadiness({ cfg: ours, apiBase, apiKey, env: { AGENTCHAT_API_KEY: apiKey } })).toEqual({ ready: true })
    // OpenClaw hands the plugin the env-substituted config: the bearer then carries the key itself.
    const substituted = { mcp: { servers: { agentchat: { ...ours.mcp.servers.agentchat, headers: { Authorization: `Bearer ${apiKey}` } } } } }
    expect(turnReadiness({ cfg: substituted, apiBase, apiKey, env: { AGENTCHAT_API_KEY: apiKey } })).toEqual({ ready: true })
  })

  it('our entry with a different key in this process is not ready: the turn would act as another agent, or on the old key after a rotation (T6-F10)', () => {
    const other = testKey('o'.repeat(24))
    const readiness = turnReadiness({ cfg: ours, apiBase, apiKey, env: { AGENTCHAT_API_KEY: other } })
    expect(readiness.ready).toBe(false)
    const reason = (readiness as { reason: string }).reason
    expect(reason).toMatch(/AGENTCHAT_API_KEY in the gateway's environment is not the key channels\.agentchat is configured with/)
    expect(reason).toContain(`the key changed since the gateway started — OpenClaw reads ${path.join(process.env.OPENCLAW_STATE_DIR!, '.env')} only when the gateway starts, and \`openclaw doctor --fix\` places the account's key there`)
    expect(reason).toContain('openclaw gateway install --force')
    expect(reason).not.toContain(other)
    expect(reason).not.toContain(apiKey)
    // In production OpenClaw hands the plugin the env-substituted config: the bearer then carries the variable's key.
    const substituted = { mcp: { servers: { agentchat: { ...ours.mcp.servers.agentchat, headers: { Authorization: `Bearer ${other}` } } } } }
    expect(turnReadiness({ cfg: substituted, apiBase, apiKey, env: { AGENTCHAT_API_KEY: other } }).ready).toBe(false)
    // A bearer that is the account's key written out does not read the variable; neither does a hand-written entry on another credential.
    const literal = { mcp: { servers: { agentchat: { ...ours.mcp.servers.agentchat, headers: { Authorization: `Bearer ${apiKey}` } } } } }
    expect(turnReadiness({ cfg: literal, apiBase, apiKey, env: { AGENTCHAT_API_KEY: other } })).toEqual({ ready: true })
    const theirs = { mcp: { servers: { agentchat: { ...ours.mcp.servers.agentchat, headers: { Authorization: 'Bearer ${MY_OWN_VAR}' } } } } }
    expect(turnReadiness({ cfg: theirs, apiBase, apiKey, env: { AGENTCHAT_API_KEY: other } })).toEqual({ ready: true })
  })

  it("a hand-written entry is the operator's and counts as ready", () => {
    const theirs = { mcp: { servers: { agentchat: { url: 'https://proxy.example/mcp', transport: 'streamable-http' } } } }
    expect(turnReadiness({ cfg: theirs, apiBase, apiKey, env: {} })).toEqual({ ready: true })
  })

  it('the restart hint appears only when the config could not be read live', () => {
    const live = turnReadiness({ cfg: {}, apiBase, apiKey, env: {}, live: true })
    const snapshot = turnReadiness({ cfg: {}, apiBase, apiKey, env: {}, live: false })
    if (live.ready || snapshot.ready) throw new Error('unreachable')
    expect(live.reason).not.toMatch(/restart the gateway/)
    expect(snapshot.reason).toMatch(/run `openclaw doctor --fix`, then restart the gateway/)
    expect(turnReadiness({ cfg: {}, apiBase, apiKey, env: {} })).toEqual(live) // omitted = live
  })

  it('readLiveConfig reads the gateway config through the runtime (OpenClaw hot-applies mcp.*) and falls back to the snapshot without one', () => {
    const snapshot = { mcp: { servers: {} } }
    const liveCfg = { mcp: { servers: { agentchat: ours.mcp.servers.agentchat } } }
    const runtime = { config: { loadConfig: () => liveCfg } } as unknown as PluginRuntime
    expect(readLiveConfig(snapshot, () => runtime)).toEqual({ cfg: liveCfg, live: true })
    expect(readLiveConfig(snapshot, () => null)).toEqual({ cfg: snapshot, live: false })
    const throwing = { config: { loadConfig: () => { throw new Error('not in this registration mode') } } } as unknown as PluginRuntime
    expect(readLiveConfig(snapshot, () => throwing)).toEqual({ cfg: snapshot, live: false })
    // The two together: doctor --fix wrote the entry after start → ready without a restart.
    const read = readLiveConfig(snapshot, () => runtime)
    expect(turnReadiness({ cfg: read.cfg, apiBase, apiKey, env: { AGENTCHAT_API_KEY: apiKey }, live: read.live })).toEqual({ ready: true })
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
