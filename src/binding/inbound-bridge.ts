/**
 * Inbound bridge — NormalizedInbound → OpenClaw's inbound dispatch, gated.
 *
 * The runtime's WS delivers typed `NormalizedInbound` events. For a text
 * message we run the **reply gate** first (a forced reply/no-reply decision on
 * the agent's own model); only a `reply` verdict proceeds to an agent turn.
 *
 * When we do dispatch, we set `sourceReplyDeliveryMode: "message_tool_only"`,
 * so the agent's final turn text is NOT auto-sent. The agent replies only by
 * calling the message tool — and if it stays silent, nothing goes on the wire.
 * That is what makes AgentChat a place where the agent *decides* what to do
 * (reply, do something else, or nothing) instead of a chat interface that
 * answers every turn. Two agents can no longer ping-pong by construction: a
 * no-reply turn sends nothing, so the other side is never re-woken.
 *
 * Non-text events (presence, typing, read receipts, rate-limit warnings, group
 * invites, group deletions) are surfaced through logs; they do NOT trigger a
 * turn.
 *
 * Self-sends are filtered: the AgentChat server emits `message.new` for both
 * sides of every send, so we'd otherwise feed our own outbound back to the
 * agent. Detection is by handle match against the configured `agentHandle`.
 */

import { resolveInboundRouteEnvelopeBuilderWithRuntime } from 'openclaw/plugin-sdk/inbound-envelope'
import { recordInboundSessionAndDispatchReply } from 'openclaw/plugin-sdk/inbound-reply-dispatch'

import type { Logger } from '../log.js'
import type { AgentchatChannelConfig } from '../config-schema.js'
import type {
  NormalizedInbound,
  NormalizedMessage,
  NormalizedGroupInvite,
  NormalizedGroupDeleted,
} from '../inbound.js'
import type { AgentchatChannelRuntime } from '../runtime.js'
import type { OpenClawConfig } from './openclaw-types.js'
import { getThreadClosures } from './thread-closures.js'
import { getClient } from './sdk-client.js'
import { decideReply, type GateCaller } from './gate.js'
import type { GateInboundEvent, GateRawMessage, HistoryTurn } from './reply-gate.js'

/** How many recent messages to fetch for the gate's signals + history. */
const GATE_HISTORY_LIMIT = 30

export interface InboundBridgeDeps {
  readonly accountId: string
  readonly config: AgentchatChannelConfig
  readonly logger: Logger
  readonly runtime: AgentchatChannelRuntime
  /**
   * OpenClaw's channelRuntime surface — exposed on `ChannelGatewayContext`.
   * When `undefined` (e.g. during tests or when the gateway was booted
   * without AI wiring) we degrade to log-only: the message is visible in
   * logs but no reply is generated.
   */
  readonly channelRuntime?: ChannelRuntimeLike
  readonly gatewayCfg: unknown
  readonly selfHandle?: string
  /**
   * Test seam: override the reply gate's model caller. Production leaves this
   * unset so the gate runs on the agent's own configured model.
   */
  readonly gateCaller?: GateCaller
}

/**
 * The runtime surface OpenClaw passes via channelRuntime. We only declare the
 * bits we actually call — the object passed at runtime is fuller and is the
 * same shape every bundled channel uses. Casts to `never` at the dispatch
 * boundary sidestep a deep TS type-name conflict between OpenClaw's internal
 * cfg type and our `gatewayCfg` passthrough.
 */
export type ChannelRuntimeLike = {
  readonly routing?: unknown
  readonly session?: unknown
  readonly reply?: {
    readonly dispatchReplyWithBufferedBlockDispatcher?: (params: unknown) => Promise<unknown>
    readonly resolveEnvelopeFormatOptions?: unknown
    readonly formatAgentEnvelope?: unknown
    readonly finalizeInboundContext?: unknown
  }
}

/**
 * Return a `(NormalizedInbound) => void` handler suitable for plugging into
 * `ChannelRuntimeHandlers.onInbound`. Call this once per account inside
 * `gateway.startAccount`.
 */
export function createInboundBridge(deps: InboundBridgeDeps) {
  return async function onInbound(event: NormalizedInbound): Promise<void> {
    switch (event.kind) {
      case 'message':
        await handleMessage(deps, event)
        return
      case 'group-invite':
        handleGroupInvite(deps, event)
        return
      case 'group-deleted':
        handleGroupDeleted(deps, event)
        return
      case 'read-receipt':
      case 'typing':
      case 'presence':
      case 'rate-limit-warning':
      case 'unknown':
        // Low-signal events — surface to logs, do not trigger a turn.
        deps.logger.debug({ event: event.kind }, 'inbound signal')
        return
    }
  }
}

async function handleMessage(
  deps: InboundBridgeDeps,
  event: NormalizedMessage,
): Promise<void> {
  const senderHandle = event.sender
  const selfHandle = deps.selfHandle ?? deps.config.agentHandle
  if (selfHandle && senderHandle === selfHandle) {
    // Server echoes our own send back over WS. Ignore so the agent does not
    // reply to itself.
    deps.logger.trace(
      { messageId: event.messageId, sender: senderHandle },
      'inbound self-message — ignored',
    )
    return
  }

  const body = typeof event.content.text === 'string' ? event.content.text : ''
  if (!body && !event.content.attachmentId && !event.content.data) {
    // Empty payload — nothing meaningful to dispatch.
    return
  }

  const threadClosures = getThreadClosures(
    deps.gatewayCfg as OpenClawConfig | undefined,
    deps.accountId,
  )
  if (threadClosures.isClosed(event.conversationId)) {
    deps.logger.info(
      { conversationId: event.conversationId, messageId: event.messageId, sender: event.sender },
      'inbound skipped for locally closed thread',
    )
    return
  }

  const channelRuntime = deps.channelRuntime
  if (
    !channelRuntime ||
    typeof channelRuntime.reply?.dispatchReplyWithBufferedBlockDispatcher !== 'function'
  ) {
    // HARD degradation: gateway booted without AI wiring (e.g. tests or a
    // misconfigured deployment). The message reached the plugin but there is
    // nowhere to dispatch it. Server-side it stays durable — a restart with a
    // properly-wired runtime drains it from sync.
    deps.logger.error(
      {
        event: 'inbound_dispatch_unavailable',
        messageId: event.messageId,
        conversationId: event.conversationId,
        conversationKind: event.conversationKind,
        sender: event.sender,
      },
      'channelRuntime unavailable — message NOT dispatched to agent (will be redelivered on next sync)',
    )
    return
  }

  const ts =
    typeof event.createdAt === 'number' ? event.createdAt : Date.parse(event.createdAt)
  const recipientHandle = selfHandle ?? 'me'
  const conversationLabel =
    event.conversationKind === 'group'
      ? `group ${event.conversationId}`
      : `dm with @${senderHandle}`

  // Fallback delivery path. With `message_tool_only` the framework suppresses
  // auto-delivery of the agent's final text, so this is normally not invoked —
  // the agent's reply goes out through the message tool / outbound adapter. We
  // keep it so any non-suppressed payload still threads back correctly.
  const sendReply = async (replyText: string): Promise<void> => {
    if (!replyText) return
    const target =
      event.conversationKind === 'group'
        ? { kind: 'group' as const, conversationId: event.conversationId }
        : { kind: 'direct' as const, to: senderHandle }
    await deps.runtime.sendMessage({
      ...target,
      type: 'text',
      content: { text: replyText },
      metadata: { reply_to: event.messageId },
    })
  }
  const deliver = async (payload: { text?: string; blocks?: unknown[] }) => {
    if (threadClosures.isClosed(event.conversationId)) {
      deps.logger.info(
        { conversationId: event.conversationId, messageId: event.messageId },
        'reply suppressed for locally closed thread',
      )
      return
    }
    await sendReply(payload.text ?? extractText(payload.blocks))
  }

  try {
    // Resolve the agent route once — both direct and group go through the same
    // assembly. `route.agentId` is also what the gate runs the decision on.
    const runtime = channelRuntime as never
    const peer =
      event.conversationKind === 'group'
        ? ({ kind: 'group', id: event.conversationId } as const)
        : ({ kind: 'direct', id: senderHandle } as const)
    const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
      cfg: deps.gatewayCfg as never,
      channel: 'agentchat',
      accountId: deps.accountId,
      peer,
      runtime,
    })

    // ── Reply gate ──────────────────────────────────────────────────────
    // Forced reply/no-reply decision BEFORE the agent turn. `no_reply` ends
    // here — no turn, nothing sent. This is the loop-breaker: silence is a
    // first-class outcome, so two agents stop instead of trading acks forever.
    if (gateEnabled()) {
      const decision = await runReplyGate({
        deps,
        event,
        body,
        agentId: route.agentId,
        selfHandle,
        senderHandle,
        nowMs: Number.isFinite(ts) ? ts : Date.now(),
      })
      deps.logger.info(
        {
          conversationId: event.conversationId,
          messageId: event.messageId,
          reply: decision.reply,
          source: decision.source,
          category: decision.category,
          latencyMs: decision.latencyMs,
          reason: decision.reason,
        },
        'reply gate decision',
      )
      if (!decision.reply) return
    }

    // ── Dispatch (message_tool_only: agent sends via the tool, not auto) ──
    const { storePath, body: envelopeBody } = buildEnvelope({
      channel: 'AgentChat',
      from: conversationLabel,
      body,
      timestamp: ts,
    })
    const finalize = (
      channelRuntime.reply as {
        finalizeInboundContext: (c: Record<string, unknown>) => Record<string, unknown>
      }
    ).finalizeInboundContext
    const ctxPayload = finalize({
      Body: envelopeBody,
      BodyForAgent: body,
      RawBody: body,
      CommandBody: body,
      From: `@${senderHandle}`,
      To: `@${recipientHandle}`,
      SessionKey: route.sessionKey,
      AccountId: deps.accountId,
      ChatType: event.conversationKind === 'group' ? 'group' : 'direct',
      ConversationLabel: conversationLabel,
      SenderId: senderHandle,
      Provider: 'agentchat',
      Surface: 'agentchat',
      MessageSid: event.messageId,
      MessageSidFull: event.messageId,
      Timestamp: ts,
      OriginatingChannel: 'agentchat',
      OriginatingTo: `@${recipientHandle}`,
    })
    const session = channelRuntime.session as { recordInboundSession: never }
    await recordInboundSessionAndDispatchReply({
      cfg: deps.gatewayCfg as never,
      channel: 'agentchat',
      accountId: deps.accountId,
      agentId: route.agentId,
      routeSessionKey: route.sessionKey,
      storePath,
      ctxPayload: ctxPayload as never,
      recordInboundSession: session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher: channelRuntime.reply!
        .dispatchReplyWithBufferedBlockDispatcher! as never,
      deliver,
      // The agent replies only by calling the message tool; its final text is
      // not auto-delivered. Silence (no tool call) sends nothing.
      replyOptions: { sourceReplyDeliveryMode: 'message_tool_only' } as never,
      onRecordError: (err: unknown) => {
        deps.logger.error(
          { err: err instanceof Error ? err.message : String(err), messageId: event.messageId },
          'recordInboundSession failed',
        )
      },
      onDispatchError: (err: unknown, info: { kind: string }) => {
        deps.logger.error(
          {
            err: err instanceof Error ? err.message : String(err),
            messageId: event.messageId,
            kind: info.kind,
          },
          'inbound dispatch failed',
        )
      },
    })
  } catch (err) {
    deps.logger.error(
      { err: err instanceof Error ? err.message : String(err), messageId: event.messageId },
      'inbound dispatch failed',
    )
  }
}

/**
 * Run the reply gate for one inbound message: fetch recent history (best-effort)
 * and ask the agent's own model whether a reply is warranted.
 */
async function runReplyGate(params: {
  deps: InboundBridgeDeps
  event: NormalizedMessage
  body: string
  agentId: string
  selfHandle: string | undefined
  senderHandle: string
  nowMs: number
}): ReturnType<typeof decideReply> {
  const { deps, event, body, agentId, selfHandle, senderHandle, nowMs } = params
  const ownHandle = selfHandle ?? ''

  let rawMessages: GateRawMessage[] = []
  try {
    const client = getClient({ accountId: deps.accountId, config: deps.config })
    const fetched = await client.getMessages(event.conversationId, { limit: GATE_HISTORY_LIMIT })
    if (Array.isArray(fetched)) rawMessages = fetched as unknown as GateRawMessage[]
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err), conversationId: event.conversationId },
      'reply gate: history fetch failed — deciding on the new message alone',
    )
  }

  const gateEvent: GateInboundEvent = {
    conversationKind: event.conversationKind,
    senderHandle,
    contentText: body,
  }

  return decideReply({
    cfg: deps.gatewayCfg as OpenClawConfig,
    agentId,
    handle: ownHandle.replace(/^@/, ''),
    event: gateEvent,
    history: translateHistory(rawMessages, ownHandle, event.conversationKind, event.messageId),
    rawMessages,
    triggerMessageId: event.messageId,
    ownHandle,
    nowMs,
    failOpen: gateFailOpen(),
    caller: deps.gateCaller,
  })
}

/**
 * Translate raw AgentChat message rows into the gate's `{role, content}` turns,
 * oldest first. `is_own` (or a sender-handle match) maps to `assistant`; group
 * peers are prefixed with `[@handle]` so a multi-party thread is attributable.
 * The trigger message is excluded — it arrives as the new message.
 */
function translateHistory(
  messages: readonly GateRawMessage[],
  ownHandle: string,
  conversationKind: 'direct' | 'group',
  triggerMessageId: string,
): HistoryTurn[] {
  const own = ownHandle.replace(/^@/, '').toLowerCase()
  const isGroup = conversationKind === 'group'
  const sorted = [...messages]
    .filter((m): m is GateRawMessage => Boolean(m) && typeof m === 'object')
    .sort((a, b) => readSeq(a) - readSeq(b))

  const out: HistoryTurn[] = []
  for (const m of sorted) {
    if (m.id === triggerMessageId) continue
    const type = typeof m.type === 'string' ? m.type : 'text'
    if (type !== 'text') continue
    const content = m.content
    const text =
      content && typeof content === 'object'
        ? (content as { text?: unknown }).text
        : undefined
    if (typeof text !== 'string' || !text) continue

    const senderRaw = String(m.sender ?? m.from ?? m.sender_handle ?? '')
    const isOwn =
      typeof m.is_own === 'boolean'
        ? m.is_own
        : senderRaw.replace(/^@/, '').toLowerCase() === own

    if (isOwn) {
      out.push({ role: 'assistant', content: text })
    } else if (isGroup) {
      out.push({ role: 'user', content: `[@${senderRaw.replace(/^@/, '') || '?'}] ${text}` })
    } else {
      out.push({ role: 'user', content: text })
    }
  }
  return out
}

function readSeq(m: GateRawMessage): number {
  const seq = (m as { seq?: unknown }).seq
  return typeof seq === 'number' ? seq : 0
}

const OFF_TOKENS = new Set(['0', 'false', 'off', 'no'])

/** Reply gate kill switch — set `AGENTCHAT_REPLY_GATE_ENABLED=0` to disable. */
function gateEnabled(): boolean {
  return !OFF_TOKENS.has((process.env.AGENTCHAT_REPLY_GATE_ENABLED ?? '').trim().toLowerCase())
}

/**
 * On a gate failure, reply (fail-open, default) or stay silent (fail-closed via
 * `AGENTCHAT_REPLY_GATE_FAIL_OPEN=0`). Fail-open is self-correcting: a dropped
 * reply reads as a dead agent, and the gate re-runs on the next inbound.
 */
function gateFailOpen(): boolean {
  return !OFF_TOKENS.has((process.env.AGENTCHAT_REPLY_GATE_FAIL_OPEN ?? '').trim().toLowerCase())
}

function handleGroupInvite(deps: InboundBridgeDeps, event: NormalizedGroupInvite): void {
  deps.logger.info(
    {
      event: 'group-invite',
      groupId: event.groupId,
      inviterHandle: event.inviterHandle,
      groupName: event.groupName,
    },
    'received group invite',
  )
}

function handleGroupDeleted(deps: InboundBridgeDeps, event: NormalizedGroupDeleted): void {
  deps.logger.warn(
    {
      event: 'group-deleted',
      groupId: event.groupId,
      deletedBy: event.deletedByHandle,
    },
    'group was deleted',
  )
}

function extractText(blocks: unknown[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block && typeof block === 'object' && 'text' in block) {
      const text = (block as { text: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n\n').trim()
}
