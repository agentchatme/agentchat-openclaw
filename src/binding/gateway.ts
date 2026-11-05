/**
 * ChannelGatewayAdapter — start/stop the integration per account.
 *
 * OpenClaw calls `startAccount` when a configured account is enabled. The
 * integration then:
 *
 *   socket frame / connect / wake frame ──► wake ──► coalesce ──► tray ──► gate ──► one turn per reply
 *
 * everything after the wake lives in `../integration/invoker.ts`; this file
 * only wires OpenClaw's context (config, logger, status sink, abort signal,
 * agent routing, the plugin runtime captured by `setRuntime`) to it and
 * keeps the account task pending until OpenClaw aborts it.
 *
 * `AGENTCHAT_WAKE=off` (the old spelling `AGENTCHAT_DOORBELL=off` still
 * works) skips all of it: no socket, no wakes, no turns. The hosted tools
 * and the manual stay placed, so the agent can still use AgentChat when
 * something else wakes it.
 */

import type { ChannelGatewayAdapter, ChannelGatewayContext } from './openclaw-types.js'

import type { AgentchatResolvedAccount } from '../channel.js'
import { createLogger, type Logger } from '../log.js'
import {
  LEGACY_REPLY_GATE_FAIL_OPEN_ENV,
  LEGACY_WAKE_MODE_ENV,
  WAKE_MODE_ENV,
  readLegacyReplyGateFailOpenFromEnv,
  readReplyGateEnabledFromEnv,
  readReplyGateTimeoutMsFromEnv,
  readWakeModeFromEnv,
} from '../credentials/read-env.js'
import { multiAccountRefusal } from '../channel-account.js'
import { registerIntegration, unregisterIntegration, getIntegration } from './runtime-registry.js'
import { AgentInvoker } from '../integration/invoker.js'
import { InviteLedger, groupInviteFromRecord } from '../integration/invites.js'
import { TextsStore } from '../integration/texts.js'
import { refreshIdentityLine } from '../integration/placement.js'
import {
  createRuntimeModelCall,
  createRuntimeTurnStarter,
  resolveIntegrationAgentId,
  resolveGateAgent,
  readLlmAgentOverrideOptIn,
  LLM_AGENT_OVERRIDE_PATH,
  type ChannelRuntimeLike,
} from '../integration/model.js'
import type { SocketState } from '../integration/socket.js'
import { resolveOpenClawDefaultAgentId } from '../openclaw-layout.js'
import { getClient } from './sdk-client.js'

function adaptLog(log: ChannelGatewayContext['log']): Logger | undefined {
  if (!log) return undefined
  const adapted: Logger = {
    trace: (obj, msg) => log.debug?.(formatLogLine(obj, msg)),
    debug: (obj, msg) => log.debug?.(formatLogLine(obj, msg)),
    info: (obj, msg) => log.info(formatLogLine(obj, msg)),
    warn: (obj, msg) => log.warn(formatLogLine(obj, msg)),
    error: (obj, msg) => log.error(formatLogLine(obj, msg)),
    child: () => adapted,
  }
  return adapted
}

/**
 * OpenClaw's account lifecycle (`ChannelAccountSnapshot.lifecycle` in
 * 2026.10.x: starting | ready | recovering | blocked | stopped). The field is
 * absent from the 2026.6.10 types this package compiles against, so it is
 * added through a widened type; a gateway that does not know it ignores it.
 */
type Lifecycle = 'starting' | 'ready' | 'recovering' | 'blocked' | 'stopped'

function withLifecycle<T extends object>(snapshot: T, lifecycle: Lifecycle): T {
  return Object.assign({}, snapshot, { lifecycle }) as T
}

/**
 * OpenClaw's `statusState` vocabulary for the Health table: anything else
 * is printed verbatim and read as a warning. The socket's own state name
 * stays in `lifecycle`.
 */
type StatusState = 'linked' | 'configured' | 'unstable' | 'not-linked' | 'disabled' | 'unconfigured'

export function statusStateFor(state: SocketState): StatusState {
  switch (state) {
    case 'connected':
      return 'linked'
    case 'blocked':
      return 'not-linked'
    case 'stopped':
    case 'idle':
      return 'configured'
    default:
      // connecting, reconnecting
      return 'unstable'
  }
}

function formatLogLine(obj: object, msg?: string): string {
  const head = msg ?? ''
  const keys = Object.keys(obj)
  if (keys.length === 0) return head
  const tail = keys
    .map((k) => {
      const val = (obj as Record<string, unknown>)[k]
      return `${k}=${typeof val === 'string' ? val : JSON.stringify(val)}`
    })
    .join(' ')
  return head ? `${head} ${tail}` : tail
}

/** Resolve when `signal` aborts; run `onAbort` first so cleanup completes before OpenClaw sees the task end. */
export async function waitUntilAbort(signal: AbortSignal, onAbort: () => Promise<void> | void): Promise<void> {
  if (!signal.aborted) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  await onAbort()
}

export const agentchatGatewayAdapter: ChannelGatewayAdapter<AgentchatResolvedAccount> = {
  async startAccount(ctx) {
    const account = ctx.account
    if (!account.enabled) {
      ctx.log?.info?.(`[agentchat:${ctx.accountId}] account disabled — skipping start`)
      return
    }
    if (!account.configured || !account.config) {
      ctx.log?.warn?.(`[agentchat:${ctx.accountId}] account not configured — skipping start`)
      return
    }
    const config = account.config
    const logger =
      adaptLog(ctx.log) ??
      createLogger({ level: config.observability.logLevel, redactKeys: config.observability.redactKeys })

    ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: true, connected: false }, 'starting'))

    const wakeMode = readWakeModeFromEnv()
    if (wakeMode.mode === 'off') {
      ctx.log?.info?.(
        `[agentchat:${ctx.accountId}] ${wakeMode.variable}=off — no socket, no wakes, no turns; the hosted tools and the manual stay placed` +
          (wakeMode.variable === LEGACY_WAKE_MODE_ENV ? ` (${LEGACY_WAKE_MODE_ENV} is the old spelling; ${WAKE_MODE_ENV} is the new one)` : ''),
      )
      ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: false, connected: false, linked: true, statusState: 'disabled' }, 'stopped'))
      await waitUntilAbort(ctx.abortSignal, () => undefined)
      return
    }
    if (readLegacyReplyGateFailOpenFromEnv()) {
      ctx.log?.warn?.(
        `[agentchat:${ctx.accountId}] ${LEGACY_REPLY_GATE_FAIL_OPEN_ENV} is set but no longer honoured — a gate that cannot run fails closed (nothing recorded, no turn) and re-wakes on the ladder`,
      )
    }

    // One account per gateway in this release (see `multiAccountRefusal`):
    // a second account's turn would call the hosted tools as the first.
    const refusal = multiAccountRefusal(ctx.cfg)
    if (refusal) {
      ctx.log?.error?.(`[agentchat:${ctx.accountId}] integration not started — ${refusal}`)
      ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: false, connected: false, statusState: 'not-linked', lastDisconnect: { at: Date.now(), error: refusal } }, 'blocked'))
      await waitUntilAbort(ctx.abortSignal, () => undefined)
      return
    }

    const channelRuntime = ctx.channelRuntime as ChannelRuntimeLike | undefined
    // Which agent wakes: OpenClaw's routing for this account. The gate call
    // names that agent only when it differs from OpenClaw's ambient default
    // — an override OpenClaw must be told to allow (D1, `model.ts`).
    const { agentId, agentIdOverride } = resolveGateAgent({
      routedAgentId: resolveIntegrationAgentId({ cfg: ctx.cfg, accountId: ctx.accountId, channelRuntime }),
      ambientAgentId: resolveOpenClawDefaultAgentId(ctx.cfg),
    })
    if (agentIdOverride && !readLlmAgentOverrideOptIn(ctx.cfg)) {
      ctx.log?.warn?.(
        `[agentchat:${ctx.accountId}] this account is routed to agent "${agentIdOverride}", not OpenClaw's default — the gate call will be refused (LLM_COMPLETION_NOT_AUTHORIZED) until ${LLM_AGENT_OVERRIDE_PATH} is true; \`openclaw doctor --fix\` writes it`,
      )
    }
    const client = getClient({ accountId: ctx.accountId, config })
    const gateTimeoutMs = readReplyGateTimeoutMsFromEnv()

    // The served texts: fetched now (server, then the cached copy), refreshed
    // daily. Unreachable with nothing cached → the store says so once and the
    // integration starts anyway; turns wait for the first copy.
    const texts = new TextsStore({ client, accountId: ctx.accountId, logger })
    await texts.start()
    const handle = config.agentHandle
    if (handle) {
      // A fresh server copy that differs from the placed line refreshes it;
      // an absent line is the wizard's / doctor's to place.
      texts.onServerCopy((copy) => {
        const refreshed = refreshIdentityLine(ctx.cfg, ctx.accountId, handle, copy.identity_line)
        if (refreshed.outcome === 'updated') ctx.log?.info?.(`[agentchat:${ctx.accountId}] identity line refreshed from the served texts in ${refreshed.path}`)
        else if (refreshed.outcome === 'failed') ctx.log?.warn?.(`[agentchat:${ctx.accountId}] identity line could not be refreshed in ${refreshed.path}: ${refreshed.detail ?? 'unknown error'}`)
      })
    }
    const invites = new InviteLedger({
      accountId: ctx.accountId,
      onWriteError: (err) => ctx.log?.warn?.(`[agentchat:${ctx.accountId}] invite ledger could not be written: ${err instanceof Error ? err.message : String(err)}`),
    })

    await registerIntegration({
      accountId: ctx.accountId,
      config,
      logger,
      socketOptions: { client },
      build: (socket) => {
        const invoker = new AgentInvoker({
          accountId: ctx.accountId,
          agentId,
          client,
          callModel: createRuntimeModelCall({ agentIdOverride, ...(gateTimeoutMs !== undefined ? { timeoutMs: gateTimeoutMs } : {}) }),
          startTurn: createRuntimeTurnStarter(),
          texts,
          invites,
          logger,
          gateEnabled: readReplyGateEnabledFromEnv(),
        })
        // True from the first rejected key until a HELLO is accepted again
        // (or the account stops). The SDK reports a rejection as a close and
        // then as the error that ends its reconnect loop; a later retry of
        // ours would walk the same states. For the operator that is one
        // situation, so it is one error line and one steady `blocked`
        // status, not a health flap and an error per signal.
        let blocked = false
        const block = (reason: string, line: string): void => {
          if (blocked) {
            ctx.log?.debug?.(`[agentchat:${ctx.accountId}] still blocked (${reason})`)
            return
          }
          blocked = true
          ctx.log?.error?.(`[agentchat:${ctx.accountId}] ${line}`)
          ctx.setStatus(
            withLifecycle(
              { ...ctx.getStatus(), running: false, connected: false, statusState: 'not-linked', lastDisconnect: { at: Date.now(), error: reason } },
              'blocked',
            ),
          )
        }
        return {
          invoker,
          texts,
          handlers: {
            onWake: (source) => invoker.wake(source),
            onGroupInvite: (invite) => invoker.groupInvite(invite, 'live'),
            onConnected: (at) => {
              if (blocked) {
                blocked = false
                ctx.log?.info?.(`[agentchat:${ctx.accountId}] key accepted again — blocked cleared`)
              }
              ctx.log?.info?.(`[agentchat:${ctx.accountId}] connected at ${new Date(at).toISOString()} (agent ${agentId})`)
              ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: true, connected: true, linked: true, statusState: 'linked', lastConnectedAt: at }, 'ready'))
              // Invite frames are live-only (not part of any drain), so an
              // invite that landed while the socket was down is fetched once
              // per connect and handed to the invoker, which dedups by id
              // against the ledger.
              void catchUpInvites(ctx.accountId, client, invoker, logger)
            },
            onDisconnected: (info) => {
              if (info.keyRejected) {
                block(
                  `key rejected: close ${info.code}${info.reason ? ` ${info.reason}` : ''}`,
                  `key rejected (close ${info.code}${info.reason ? ` ${info.reason}` : ''}) — the server refused the key; rotate it or re-run openclaw channels add agentchat, then restart the gateway`,
                )
                return
              }
              if (blocked) {
                ctx.log?.debug?.(`[agentchat:${ctx.accountId}] socket closed while blocked: ${info.code} ${info.reason}`)
                return
              }
              ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: true, connected: false, statusState: 'unstable' }, 'recovering'))
            },
            onStopped: (reason) => {
              // The SDK ended its reconnect loop (a terminal close code). Only
              // a new socket recovers: a gateway restart or a config reload.
              block(`socket stopped: ${reason}`, `socket stopped — ${reason}; restart the gateway (or reload the channel config) once the key is right`)
            },
            onError: (err) => {
              // While blocked the one error line already said it.
              ctx.log?.[blocked ? 'debug' : 'warn']?.(`[agentchat:${ctx.accountId}] socket error: ${err.message}`)
            },
            onStateChanged: (next) => {
              if (next === 'stopped') ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: false, connected: false, statusState: 'configured' }, 'stopped'))
            },
          },
        }
      },
    })

    // Keep the channel task pending until OpenClaw aborts it. A resolved
    // promise would read as "channel exited" and trigger auto-restart.
    await waitUntilAbort(ctx.abortSignal, async () => {
      try {
        await unregisterIntegration(ctx.accountId)
      } catch (err) {
        ctx.log?.error?.(`[agentchat:${ctx.accountId}] unregister failed on abort: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  },

  async stopAccount(ctx) {
    await unregisterIntegration(ctx.accountId)
    ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: false, connected: false }, 'stopped'))
  },
}

async function catchUpInvites(
  accountId: string,
  client: ReturnType<typeof getClient>,
  invoker: AgentInvoker,
  logger: Logger,
): Promise<void> {
  try {
    const invites: unknown = await client.listGroupInvites()
    if (!Array.isArray(invites)) return
    let surfaced = 0
    for (const row of invites) {
      const invite = groupInviteFromRecord(row)
      if (invite && invoker.groupInvite(invite, 'catch-up')) surfaced += 1
    }
    if (surfaced > 0) logger.info({ accountId, surfaced }, 'pending group invites surfaced on connect')
  } catch (err) {
    logger.warn(
      { accountId, err: err instanceof Error ? err.message : String(err) },
      'pending-invite catch-up failed — live invite frames are unaffected and the agent can still list invites with the hosted tools',
    )
  }
}

export { getIntegration }
