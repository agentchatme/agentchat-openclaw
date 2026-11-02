/**
 * ChannelGatewayAdapter — start/stop the doorbell per account.
 *
 * OpenClaw calls `startAccount` when a configured account is enabled. The
 * doorbell then:
 *
 *   socket frame / connect ──► knock ──► coalesce ──► tray ──► gate ──► one turn
 *
 * everything after the knock lives in `../doorbell/invoker.ts`; this file
 * only wires OpenClaw's context (config, logger, status sink, abort signal,
 * agent routing, the plugin runtime captured by `setRuntime`) to it and
 * keeps the account task pending until OpenClaw aborts it.
 *
 * `AGENTCHAT_DOORBELL=off` skips all of it: no socket, no knocks, no turns.
 * The hosted tools and the manual stay placed, so the agent can still use
 * AgentChat when something else wakes it.
 */

import type { ChannelGatewayAdapter, ChannelGatewayContext } from './openclaw-types.js'

import type { AgentchatResolvedAccount } from '../channel.js'
import { createLogger, type Logger } from '../log.js'
import { readDoorbellModeFromEnv, readReplyGateEnabledFromEnv, readReplyGateFailOpenFromEnv, readReplyGateTimeoutMsFromEnv } from '../credentials/read-env.js'
import { multiAccountRefusal } from '../channel-account.js'
import { registerDoorbell, unregisterDoorbell, getDoorbell } from './runtime-registry.js'
import { AgentInvoker } from '../doorbell/invoker.js'
import { MainLineClient } from '../doorbell/main-line.js'
import {
  createRuntimeGateCaller,
  createRuntimeTurnRunner,
  resolveDoorbellAgentId,
  resolveGateAgent,
  readLlmAgentOverrideOptIn,
  LLM_AGENT_OVERRIDE_PATH,
  type ChannelRuntimeLike,
} from '../doorbell/model.js'
import { resolveOpenClawDefaultAgentId } from '../openclaw-layout.js'
import { getClient } from './sdk-client.js'
import { groupInviteFromRecord } from '../knock-frames.js'

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

export function statusStateFor(kind: string): StatusState {
  switch (kind) {
    case 'READY':
      return 'linked'
    case 'AUTH_FAIL':
      return 'not-linked'
    case 'CLOSED':
      return 'configured'
    default:
      // CONNECTING, AUTHENTICATING, DISCONNECTED, DEGRADED, DRAINING
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

    if (readDoorbellModeFromEnv() === 'off') {
      ctx.log?.info?.(
        `[agentchat:${ctx.accountId}] AGENTCHAT_DOORBELL=off — no socket, no knocks, no turns; the hosted tools and the manual stay placed`,
      )
      ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: false, connected: false, linked: true, statusState: 'disabled' }, 'stopped'))
      await waitUntilAbort(ctx.abortSignal, () => undefined)
      return
    }

    // One account per gateway in this release (see `multiAccountRefusal`):
    // a second account's turn would call the hosted tools as the first.
    const refusal = multiAccountRefusal(ctx.cfg)
    if (refusal) {
      ctx.log?.error?.(`[agentchat:${ctx.accountId}] doorbell not started — ${refusal}`)
      ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: false, connected: false, statusState: 'not-linked', lastDisconnect: { at: Date.now(), error: refusal } }, 'blocked'))
      await waitUntilAbort(ctx.abortSignal, () => undefined)
      return
    }

    const channelRuntime = ctx.channelRuntime as ChannelRuntimeLike | undefined
    // Which agent wakes: OpenClaw's routing for this account. The gate call
    // names that agent only when it differs from OpenClaw's ambient default
    // — an override OpenClaw must be told to allow (D1, `model.ts`).
    const { agentId, agentIdOverride } = resolveGateAgent({
      routedAgentId: resolveDoorbellAgentId({ cfg: ctx.cfg, accountId: ctx.accountId, channelRuntime }),
      ambientAgentId: resolveOpenClawDefaultAgentId(ctx.cfg),
    })
    if (agentIdOverride && !readLlmAgentOverrideOptIn(ctx.cfg)) {
      ctx.log?.warn?.(
        `[agentchat:${ctx.accountId}] this account is routed to agent "${agentIdOverride}", not OpenClaw's default — the gate call will be refused (LLM_COMPLETION_NOT_AUTHORIZED) until ${LLM_AGENT_OVERRIDE_PATH} is true; \`openclaw doctor --fix\` writes it`,
      )
    }
    const mainLine = new MainLineClient({ apiKey: config.apiKey, apiBase: config.apiBase })
    const gateTimeoutMs = readReplyGateTimeoutMsFromEnv()

    await registerDoorbell({
      accountId: ctx.accountId,
      config,
      logger,
      build: (runtime) => {
        const invoker = new AgentInvoker({
          accountId: ctx.accountId,
          agentId,
          mainLine,
          gateCaller: createRuntimeGateCaller({ agentIdOverride }),
          turnRunner: createRuntimeTurnRunner(),
          logger,
          gateEnabled: readReplyGateEnabledFromEnv(),
          gateFailOpen: readReplyGateFailOpenFromEnv(),
          ...(gateTimeoutMs !== undefined ? { gateTimeoutMs } : {}),
        })
        return {
          invoker,
          handlers: {
            onKnock: (source) => invoker.knock(source),
            onGroupInvite: (invite) => invoker.groupInvite(invite, 'live'),
            onAuthenticated: (at) => {
              ctx.log?.info?.(`[agentchat:${ctx.accountId}] authenticated at ${new Date(at).toISOString()} (agent ${agentId})`)
              ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: true, connected: true, linked: true, statusState: 'linked', lastConnectedAt: at }, 'ready'))
              // Invite frames are live-only (not part of any drain), so an
              // invite that landed while the socket was down is fetched once
              // per connect and handed to the invoker, which dedups by id.
              void catchUpInvites(ctx.accountId, config, invoker, logger)
            },
            onError: (err) => {
              ctx.log?.warn?.(`[agentchat:${ctx.accountId}] runtime error: ${err.message} (class=${err.class_})`)
            },
            onStateChanged: (next) => {
              const running = next.kind !== 'CLOSED' && next.kind !== 'AUTH_FAIL'
              const connected = next.kind === 'READY' || next.kind === 'DEGRADED'
              const lifecycle: Lifecycle =
                next.kind === 'READY' || next.kind === 'DEGRADED'
                  ? 'ready'
                  : next.kind === 'AUTH_FAIL'
                    ? 'blocked'
                    : next.kind === 'CLOSED'
                      ? 'stopped'
                      : runtime.getHealth().counters.knocks > 0
                        ? 'recovering'
                        : 'starting'
              ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running, connected, statusState: statusStateFor(next.kind) }, lifecycle))
              if (next.kind === 'AUTH_FAIL') {
                ctx.log?.error?.(`[agentchat:${ctx.accountId}] AUTH_FAIL — rotate the key or re-run openclaw channels add agentchat`)
              }
            },
          },
        }
      },
    })

    // Keep the channel task pending until OpenClaw aborts it. A resolved
    // promise would read as "channel exited" and trigger auto-restart.
    await waitUntilAbort(ctx.abortSignal, async () => {
      try {
        await unregisterDoorbell(ctx.accountId, Date.now() + 5_000)
      } catch (err) {
        ctx.log?.error?.(`[agentchat:${ctx.accountId}] unregister failed on abort: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  },

  async stopAccount(ctx) {
    await unregisterDoorbell(ctx.accountId, Date.now() + 5_000)
    ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: false, connected: false }, 'stopped'))
  },
}

async function catchUpInvites(
  accountId: string,
  config: AgentchatResolvedAccount['config'] & object,
  invoker: AgentInvoker,
  logger: Logger,
): Promise<void> {
  try {
    const client = getClient({ accountId, config })
    const invites: unknown = await client.listGroupInvites()
    if (!Array.isArray(invites)) return
    let surfaced = 0
    for (const row of invites) {
      const invite = groupInviteFromRecord(row)
      if (invite && invoker.groupInvite(invite, 'catch-up')) surfaced += 1
    }
    if (surfaced > 0) logger.info({ surfaced }, 'pending group invites surfaced on connect')
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'pending-invite catch-up failed — live invite frames are unaffected and the agent can still list invites with the hosted tools',
    )
  }
}

export { getDoorbell }
