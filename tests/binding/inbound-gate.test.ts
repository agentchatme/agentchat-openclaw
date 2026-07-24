/**
 * Inbound reply-gate integration — proves the gate actually gates the agent
 * turn, and that dispatch requests `message_tool_only` so the turn text is
 * never auto-sent.
 *
 * The SDK client (history fetch) and the route/dispatch plugin-sdk helpers are
 * mocked so the test is deterministic and never touches the network or a model
 * — the gate verdict is supplied via the injectable `gateCaller`.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

const { recordSpy } = vi.hoisted(() => ({ recordSpy: vi.fn(async (_params: unknown) => {}) }))

vi.mock('../../src/binding/sdk-client.js', () => ({
  getClient: () => ({ getMessages: vi.fn(async () => []) }),
  disposeClient: vi.fn(),
  resetClientCacheForTest: vi.fn(),
}))

vi.mock('openclaw/plugin-sdk/inbound-envelope', () => ({
  resolveInboundRouteEnvelopeBuilderWithRuntime: () => ({
    route: { agentId: 'agent-main', sessionKey: 'dm:test' },
    buildEnvelope: () => ({ storePath: '/tmp/s', body: 'envelope-body' }),
  }),
}))

vi.mock('openclaw/plugin-sdk/inbound-reply-dispatch', () => ({
  dispatchChannelInboundReply: recordSpy,
}))

import { createInboundBridge } from '../../src/binding/inbound-bridge.js'
import { resetThreadClosuresForTest } from '../../src/binding/thread-closures.js'
import {
  recordAgentSend,
  resetSendTrackerForTest,
} from '../../src/binding/send-tracker.js'
import type { GateCaller } from '../../src/binding/gate.js'
import type { NormalizedMessage } from '../../src/inbound.js'
import type { AgentchatChannelConfig } from '../../src/config-schema.js'
import type { AgentchatChannelRuntime } from '../../src/runtime.js'

const config: AgentchatChannelConfig = {
  apiKey: 'ac_live_key_aaaaaaaaaaaaaaaaaaaaaaaa',
  apiBase: 'https://api.agentchat.me',
  agentHandle: 'self-agent',
  reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0.2 },
  ping: { intervalMs: 30000, timeoutMs: 10000 },
  outbound: { maxInFlight: 256, sendTimeoutMs: 15000 },
  observability: { logLevel: 'error', redactKeys: ['apiKey'] },
}

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
}

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    kind: 'message',
    conversationKind: 'direct',
    conversationId: 'conv_abc',
    sender: 'peer-agent',
    messageId: 'msg_1',
    clientMsgId: 'cmid_1',
    seq: 1,
    messageType: 'text',
    content: { text: 'can you review the spec?' },
    metadata: {},
    status: null,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    readAt: null,
    receivedAt: Date.now(),
    senderDisplayName: null,
    senderKind: 'agent',
    groupName: null,
    memberCount: null,
    mentions: [],
    ...overrides,
  }
}

function makeRuntimeStub(): AgentchatChannelRuntime {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message: { id: 'out_1' } }),
  } as unknown as AgentchatChannelRuntime
}

function makeChannelRuntime(): unknown {
  return {
    reply: {
      finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {}),
    },
    session: { recordInboundSession: vi.fn(async () => {}) },
  }
}

function makeBridge(gateCaller: GateCaller, runtime = makeRuntimeStub()) {
  return createInboundBridge({
    accountId: 'default',
    config,
    logger,
    runtime,
    channelRuntime: makeChannelRuntime() as never,
    gatewayCfg: {},
    selfHandle: 'self-agent',
    gateCaller,
  })
}

const replyCaller: GateCaller = async () => '{"decision":"reply","category":"open_request"}'
const noReplyCaller: GateCaller = async () => '{"decision":"no_reply","category":"closing"}'

describe('inbound reply gate', () => {
  beforeEach(() => {
    process.env.OPENCLAW_PROFILE = `inbound-gate-${Math.random().toString(36).slice(2)}`
    delete process.env.AGENTCHAT_REPLY_GATE_ENABLED // gate on by default
    delete process.env.AGENTCHAT_REPLY_GATE_FAIL_OPEN // fail-closed by default
    delete process.env.AGENTCHAT_SOURCE_REPLY_MODE // automatic by default
    recordSpy.mockClear()
  })

  afterEach(() => {
    resetThreadClosuresForTest()
    resetSendTrackerForTest()
    delete process.env.OPENCLAW_PROFILE
    delete process.env.AGENTCHAT_REPLY_GATE_ENABLED
    delete process.env.AGENTCHAT_REPLY_GATE_FAIL_OPEN
    delete process.env.AGENTCHAT_SOURCE_REPLY_MODE
  })

  function dispatchedMode(): string | undefined {
    const arg = recordSpy.mock.calls[0]?.[0] as
      | { replyOptions?: { sourceReplyDeliveryMode?: string } }
      | undefined
    return arg?.replyOptions?.sourceReplyDeliveryMode
  }

  it('does NOT dispatch a turn when the gate says no_reply', async () => {
    const bridge = makeBridge(noReplyCaller)
    await bridge(makeMessage())
    expect(recordSpy).not.toHaveBeenCalled()
  })

  it('dispatches with automatic delivery by default when the gate says reply', async () => {
    // automatic so the gated reply lands even when the agent's tool profile
    // strips the message tool (the loop is already prevented by the gate).
    const bridge = makeBridge(replyCaller)
    await bridge(makeMessage())
    expect(recordSpy).toHaveBeenCalledTimes(1)
    expect(dispatchedMode()).toBe('automatic')
  })

  it('uses message_tool_only delivery when opted in via env', async () => {
    process.env.AGENTCHAT_SOURCE_REPLY_MODE = 'message_tool_only'
    const bridge = makeBridge(replyCaller)
    await bridge(makeMessage())
    expect(recordSpy).toHaveBeenCalledTimes(1)
    expect(dispatchedMode()).toBe('message_tool_only')
  })

  it('fails CLOSED (no dispatch) by default when the gate caller throws', async () => {
    // A model outage must not reseed a loop: silence under uncertainty.
    const bridge = makeBridge(async () => {
      throw new Error('provider down')
    })
    await bridge(makeMessage())
    expect(recordSpy).not.toHaveBeenCalled()
  })

  it('fails open (dispatches) when opted in via env and the caller throws', async () => {
    process.env.AGENTCHAT_REPLY_GATE_FAIL_OPEN = '1'
    const bridge = makeBridge(async () => {
      throw new Error('provider down')
    })
    await bridge(makeMessage())
    expect(recordSpy).toHaveBeenCalledTimes(1)
  })

  it('skips the gate entirely when disabled, and still dispatches', async () => {
    process.env.AGENTCHAT_REPLY_GATE_ENABLED = '0'
    const caller = vi.fn(noReplyCaller) // would say no_reply if consulted
    const bridge = makeBridge(caller)
    await bridge(makeMessage())
    expect(caller).not.toHaveBeenCalled()
    expect(recordSpy).toHaveBeenCalledTimes(1)
  })

  it('also gates group messages', async () => {
    const bridge = makeBridge(noReplyCaller)
    await bridge(makeMessage({ conversationKind: 'group', conversationId: 'group_abc' }))
    expect(recordSpy).not.toHaveBeenCalled()
  })

  // ── Context pipe ──────────────────────────────────────────────────────
  // The gate already computes when/who/pace; those signals are piped into the
  // agent-facing body so the composing turn is no longer context-blind.

  function dispatchedCtx(): Record<string, unknown> | undefined {
    return (recordSpy.mock.calls[0]?.[0] as { ctxPayload?: Record<string, unknown> })?.ctxPayload
  }

  it('pipes arrival time + gate signals into BodyForAgent, leaving RawBody untouched', async () => {
    const bridge = makeBridge(replyCaller)
    await bridge(makeMessage())
    expect(recordSpy).toHaveBeenCalledTimes(1)
    const ctx = dispatchedCtx()
    const bodyForAgent = String(ctx?.['BodyForAgent'] ?? '')
    // Absolute arrival time (a stateless agent has no clock of its own).
    expect(bodyForAgent).toContain('Received:')
    expect(bodyForAgent).toContain('UTC')
    // Gate signals piped verbatim (history mock is empty → first contact).
    expect(bodyForAgent).toContain('Conversation type: direct')
    expect(bodyForAgent).toContain('Relationship: first contact')
    // Original message text is preserved under the header…
    expect(bodyForAgent).toContain('can you review the spec?')
    // …and the raw fields used for command parsing stay clean.
    expect(ctx?.['RawBody']).toBe('can you review the spec?')
    expect(ctx?.['CommandBody']).toBe('can you review the spec?')
  })

  it('still stamps arrival time + type when the gate is disabled (no signals to pipe)', async () => {
    process.env.AGENTCHAT_REPLY_GATE_ENABLED = '0'
    const bridge = makeBridge(replyCaller)
    await bridge(makeMessage())
    const bodyForAgent = String(dispatchedCtx()?.['BodyForAgent'] ?? '')
    expect(bodyForAgent).toContain('Received:')
    expect(bodyForAgent).toContain('Conversation type: direct')
    // No gate ran, so no relationship/pace signal is fabricated.
    expect(bodyForAgent).not.toContain('Relationship:')
    expect(bodyForAgent).toContain('can you review the spec?')
  })

  it('surfaces resolved sender identity, group name, and mention', async () => {
    const bridge = makeBridge(replyCaller)
    await bridge(
      makeMessage({
        conversationKind: 'group',
        conversationId: 'group_ops',
        sender: 'bob',
        senderDisplayName: 'Bob Builder',
        groupName: 'Ops',
        mentions: ['self-agent'], // config.agentHandle
      }),
    )
    const bodyForAgent = String(dispatchedCtx()?.['BodyForAgent'] ?? '')
    expect(bodyForAgent).toContain('From: Bob Builder (@bob)')
    expect(bodyForAgent).toContain('group "Ops"')
    expect(bodyForAgent).toContain('You were @-mentioned in this message.')
  })

  it('flags a system sender in the header', async () => {
    const bridge = makeBridge(replyCaller)
    await bridge(
      makeMessage({
        sender: 'chatfather',
        senderDisplayName: 'Chatfather',
        senderKind: 'system',
      }),
    )
    expect(String(dispatchedCtx()?.['BodyForAgent'] ?? '')).toContain(
      'From: Chatfather (@chatfather), a system agent',
    )
  })

  // ── Single-send invariant ─────────────────────────────────────────────
  // Hermes never double-sends: its invoker discards the turn text and the
  // tool is the only wire path. Our equivalent: the final-turn-text delivery
  // runs ONLY when the turn produced no send of its own.

  it('suppresses the final turn text when the agent already sent via a tool this turn', async () => {
    recordSpy.mockImplementationOnce(async (params: unknown) => {
      // Simulate the agent turn: a message-tool send lands mid-turn, then the
      // framework hands the final turn text (self-narration) to `deliver`.
      recordAgentSend('default', 'conv_abc', Date.now())
      const p = params as { delivery: { deliver: (x: { text: string }) => Promise<void> } }
      await p.delivery.deliver({ text: "I've responded to @peer-agent!" })
    })
    const runtime = makeRuntimeStub()
    const bridge = makeBridge(replyCaller, runtime)
    await bridge(makeMessage())
    expect(recordSpy).toHaveBeenCalledTimes(1)
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('delivers the final turn text when the turn made no send of its own', async () => {
    recordSpy.mockImplementationOnce(async (params: unknown) => {
      const p = params as { delivery: { deliver: (x: { text: string }) => Promise<void> } }
      await p.delivery.deliver({ text: 'Paris' })
    })
    const runtime = makeRuntimeStub()
    const bridge = makeBridge(replyCaller, runtime)
    await bridge(makeMessage())
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1)
    const arg = (runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      content?: { text?: string }
    }
    expect(arg?.content?.text).toBe('Paris')
  })

  it('does not suppress based on sends from before this turn', async () => {
    // A send in a previous turn must not swallow this turn's reply.
    recordAgentSend('default', 'conv_abc', Date.now() - 60_000)
    recordSpy.mockImplementationOnce(async (params: unknown) => {
      const p = params as { delivery: { deliver: (x: { text: string }) => Promise<void> } }
      await p.delivery.deliver({ text: 'a fresh reply' })
    })
    const runtime = makeRuntimeStub()
    const bridge = makeBridge(replyCaller, runtime)
    await bridge(makeMessage())
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('does not suppress when the mid-turn send went to a different conversation', async () => {
    recordSpy.mockImplementationOnce(async (params: unknown) => {
      recordAgentSend('default', 'conv_other', Date.now())
      const p = params as { delivery: { deliver: (x: { text: string }) => Promise<void> } }
      await p.delivery.deliver({ text: 'reply to the origin thread' })
    })
    const runtime = makeRuntimeStub()
    const bridge = makeBridge(replyCaller, runtime)
    await bridge(makeMessage())
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1)
  })
})
