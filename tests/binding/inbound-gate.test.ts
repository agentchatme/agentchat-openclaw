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

function makeBridge(gateCaller: GateCaller) {
  return createInboundBridge({
    accountId: 'default',
    config,
    logger,
    runtime: makeRuntimeStub(),
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
    recordSpy.mockClear()
  })

  afterEach(() => {
    resetThreadClosuresForTest()
    delete process.env.OPENCLAW_PROFILE
    delete process.env.AGENTCHAT_REPLY_GATE_ENABLED
  })

  it('does NOT dispatch a turn when the gate says no_reply', async () => {
    const bridge = makeBridge(noReplyCaller)
    await bridge(makeMessage())
    expect(recordSpy).not.toHaveBeenCalled()
  })

  it('dispatches with message_tool_only when the gate says reply', async () => {
    const bridge = makeBridge(replyCaller)
    await bridge(makeMessage())
    expect(recordSpy).toHaveBeenCalledTimes(1)
    const arg = recordSpy.mock.calls[0]?.[0] as
      | { replyOptions?: { sourceReplyDeliveryMode?: string } }
      | undefined
    expect(arg?.replyOptions?.sourceReplyDeliveryMode).toBe('message_tool_only')
  })

  it('fails open (dispatches) when the gate caller throws', async () => {
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
})
