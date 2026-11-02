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
import { readDoorbellModeFromEnv, readReplyGateEnabledFromEnv, readReplyGateFailOpenFromEnv, readReplyGateTimeoutMsFromEnv, API_KEY_ENV } from '../credentials/read-env.js'
import { registerDoorbell, unregisterDoorbell, getDoorbell } from './runtime-registry.js'
import { AgentInvoker } from '../doorbell/invoker.js'
import { MainLineClient } from '../doorbell/main-line.js'
import { createRuntimeGateCaller, createRuntimeTurnRunner, resolveDoorbellAgentId, type ChannelRuntimeLike } from '../doorbell/model.js'
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

    if (readDoorbellModeFromEnv() === 'off') {
      ctx.log?.info?.(
        `[agentchat:${ctx.accountId}] AGENTCHAT_DOORBELL=off — no socket, no knocks, no turns; the hosted tools and the manual stay placed`,
      )
      ctx.setStatus({ ...ctx.getStatus(), running: false, connected: false, linked: true })
      await waitUntilAbort(ctx.abortSignal, () => undefined)
      return
    }

    // The hosted MCP server's bearer header is a template on this variable.
    // OpenClaw resolves config templates from the gateway's environment; if
    // the wizard placed the key after the gateway started, make it visible
    // for the next config reload (a restart is still the documented step).
    if (!(process.env[API_KEY_ENV] ?? '').trim()) {
      process.env[API_KEY_ENV] = config.apiKey
      ctx.log?.info?.(`[agentchat:${ctx.accountId}] ${API_KEY_ENV} was not in the gateway environment — set in-process for the hosted tools`)
    }

    const channelRuntime = ctx.channelRuntime as ChannelRuntimeLike | undefined
    const agentId = resolveDoorbellAgentId({ cfg: ctx.cfg, accountId: ctx.accountId, channelRuntime })
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
          gateCaller: createRuntimeGateCaller({ agentId }),
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
              ctx.setStatus({ ...ctx.getStatus(), running: true, connected: true, linked: true, lastConnectedAt: at })
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
              ctx.setStatus({ ...ctx.getStatus(), running, connected, statusState: next.kind })
              if (runtime.getHealth().state.kind === 'AUTH_FAIL') {
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
    ctx.setStatus({ ...ctx.getStatus(), running: false, connected: false })
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
