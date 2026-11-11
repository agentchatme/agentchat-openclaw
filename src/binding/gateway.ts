/**
 * ChannelGatewayAdapter — start/stop the integration per account.
 *
 * OpenClaw calls `startAccount` when a configured account is enabled. The
 * integration then:
 *
 *   socket frame / connect / wake frame ──► one cycle ──► tray ──► gate ──► one turn per reply ──► after-turn rule
 *
 * everything after the wake is the SDK kit's receive loop, with OpenClaw's
 * parts plugged in (`../integration/loop.ts`); this file
 * only wires OpenClaw's context (config, logger, status sink, abort signal,
 * agent routing, the plugin runtime captured by `setRuntime`) to it and
 * keeps the account task pending until OpenClaw aborts it.
 *
 * `AGENTCHAT_WAKE=off` (the old spelling `AGENTCHAT_DOORBELL=off` still
 * works) skips all of it: no socket, no wakes, no turns. The hosted tools
 * and the manual stay placed, so the agent can still use AgentChat when
 * something else wakes it.
 */

import type { Texts } from 'agentchatme'

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
import { createIntegrationLoop } from '../integration/loop.js'
import { OpenClawTexts, createTextsCache, spellTextsForOpenClaw } from '../integration/texts.js'
import { OVERDUE_SLACK_MS, TURN_OVERDUE_MS, accountTurns, hungTurnsReason, isOverdue, overdueTurnLine, restartHoldLines } from '../integration/running.js'
import { createAfterTurnRecorder } from '../integration/after-turn.js'
import { TurnStore } from '../integration/turn-store.js'
import { turnEndOf } from '../integration/turns.js'
import { readAgentChatCalls } from '../integration/run.js'
import { getPluginRuntime } from '../integration/runtime-holder.js'
import { removeOldStateFiles } from '../integration/state.js'
import { refreshIdentityLine } from '../integration/placement.js'
import { NIX_MODE_ERROR_CODE, clientIdentityText, refreshHostedMcpEntry, type ConfigMutator } from '../integration/mcp.js'
import {
  createRuntimeModelCall,
  createRuntimeTurnStarter,
  createRunWatcher,
  resolveIntegrationAgentId,
  resolveGateAgent,
  readLlmAgentOverrideOptIn,
  readLiveConfig,
  turnReadiness,
  LLM_AGENT_OVERRIDE_PATH,
  type ChannelRuntimeLike,
} from '../integration/model.js'
import type { SocketState } from '../integration/socket.js'
import { createInMemoryMetrics } from '../metrics.js'
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
    case 'ready':
      return 'linked'
    case 'blocked':
      return 'not-linked'
    case 'stopped':
    case 'idle':
      return 'configured'
    default:
      // connecting, backoff
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

/** Accounts already told, in this process, that their entry could not be updated (one warning, not one per start). */
const mcpUpdateWarned = new Set<string>()

/**
 * `refreshHostedMcpEntry` for this account, with its log line. The live
 * config decides whether anything is written; the write goes through
 * OpenClaw's `runtime.config.mutateConfigFile`. Never rejects.
 */
export async function updateHostedMcpEntry(
  ctx: Pick<ChannelGatewayContext, 'accountId' | 'cfg' | 'log'>,
  apiBase: string,
  apiKey: string,
  runtime: () => ReturnType<typeof getPluginRuntime> = getPluginRuntime,
): Promise<void> {
  const prefix = `[agentchat:${ctx.accountId}]`
  const warnOnce = (line: string) => {
    if (mcpUpdateWarned.has(ctx.accountId)) return
    mcpUpdateWarned.add(ctx.accountId)
    ctx.log?.warn?.(`${prefix} ${line}`)
  }
  try {
    const { cfg: liveCfg } = readLiveConfig(ctx.cfg, runtime)
    const config = (runtime() as { config?: ConfigMutator } | null)?.config
    const result = await refreshHostedMcpEntry({ liveCfg, config, apiBase, apiKey })
    if (result.outcome === 'updated') {
      mcpUpdateWarned.delete(ctx.accountId)
      ctx.log?.info?.(`${prefix} mcp.servers.agentchat now names this client to the hosted tools (${clientIdentityText()}); under the default reload mode OpenClaw applies it without a restart`)
    } else if (result.outcome === 'unsupported') {
      warnOnce(`mcp.servers.agentchat does not name this client (${clientIdentityText()}) and this OpenClaw cannot update its config from a plugin — run \`openclaw doctor --fix\``)
    } else if (result.outcome === 'failed') {
      warnOnce(
        result.code === NIX_MODE_ERROR_CODE
          ? `mcp.servers.agentchat does not name this client and OpenClaw's config is read-only here (Nix mode) — add ${clientIdentityText()} to its headers in the Nix-managed config`
          : `mcp.servers.agentchat could not be updated to name this client (${result.error ?? 'unknown error'}) — run \`openclaw doctor --fix\``,
      )
    }
  } catch (err) {
    warnOnce(`mcp.servers.agentchat check failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Test seam: forget which accounts were warned. */
export function resetHostedMcpUpdateWarningsForTest(): void {
  mcpUpdateWarned.clear()
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

    // Our hosted-tools entry from a release before 0.10.1 names no client:
    // add the header once, so AgentChat knows the agent runs on OpenClaw and
    // does not list the wake-webhook tools. Off the start path, whatever the
    // wake mode (the tools stay in use either way).
    void updateHostedMcpEntry(ctx, config.apiBase, config.apiKey)

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
        `[agentchat:${ctx.accountId}] ${LEGACY_REPLY_GATE_FAIL_OPEN_ENV} is set but no longer honoured — a gate that cannot run fails closed (nothing recorded, no turn); the server re-wakes the cards`,
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
    /** Which 30-minute mark each long run was last reported at. */
    const overdueWarned = new Map<string, number>()
    /** The account's turns for this process (shared with any later loop for the account). */
    const turns = accountTurns(ctx.accountId)
    /** The "still running" report for a run, past 30 minutes: a warn line at each 30-minute mark. */
    const reportOverdue = (runId: string, kind: 'reply' | 'invite' | 'run', id: string, elapsedMs: number, handed: boolean) => {
      const mark = Math.floor((elapsedMs + OVERDUE_SLACK_MS) / TURN_OVERDUE_MS)
      if (!handed && overdueWarned.get(runId) === mark) return
      overdueWarned.set(runId, mark)
      ctx.log?.warn?.(`[agentchat:${ctx.accountId}] ${overdueTurnLine({ kind, id, elapsedMs }, readLiveConfig(ctx.cfg).cfg)}`)
    }
    // A turn that ends outside the kit's watch (handed off, or after a
    // restart) gets the after-turn rule here; the turns in flight are
    // written to disk for the next start (`integration/turn-store.ts`).
    /**
     * A wait elapsed with the run still going — a turn's run, or one OpenClaw
     * continued after a restart. Past 30 minutes it is handed off, once (a
     * released run never again): the account gets its turn slot back, the
     * conversation stays held until the run ends. Reported then, and every
     * further 30 minutes.
     */
    const onStillRunning = ({ runId, sessionKey, elapsedMs }: { runId: string; sessionKey: string; elapsedMs: number }) => {
      const run = turns.run(runId)
      if (turns.stateOf(runId) === 'released') {
        // Let go of by the operator: it holds nothing, and is never handed off again.
        logger.debug({ runId, sessionKey, elapsedMin: Math.round(elapsedMs / 60_000) }, 'released turn still running in OpenClaw — it holds nothing')
        return
      }
      logger.info(
        { runId, sessionKey, elapsedMin: Math.round(elapsedMs / 60_000), ...(run ? { [run.kind === 'reply' ? 'conversationId' : run.kind === 'invite' ? 'inviteId' : 'run']: run.id } : {}) },
        'turn still running — its conversation stays in flight until OpenClaw reports the run ended',
      )
      if (!run || !isOverdue(elapsedMs)) return
      const handed = turns.handOff(runId) !== null
      reportOverdue(runId, run.kind, run.id, elapsedMs, handed)
    }
    const watchRun = createRunWatcher({ onStillRunning })
    turns.configure({
      recorder: createAfterTurnRecorder({ client, logger }),
      store: new TurnStore(ctx.accountId),
      watch: async (record) => {
        const outcome = await watchRun(record)
        return outcome ? turnEndOf(outcome) : null
      },
      readCalls: (sessionKey, runId) => readAgentChatCalls(getPluginRuntime(), sessionKey, runId),
      logger,
    })
    // Turns the last process left in flight (a gateway restart): held before
    // the first gate, in case OpenClaw continues their sessions.
    turns.adopt()
    for (const line of restartHoldLines(turns)) ctx.log?.warn?.(`[agentchat:${ctx.accountId}] ${line}`)

    // The served texts: the kit's cache — the file copy at once, one fetch,
    // then daily (backing off after a failure). Unreachable with nothing
    // cached → the integration starts anyway; nothing is gated until the
    // first copy arrives.
    // Upgrade cleanup: the invite ledger and an old-shape texts cache.
    for (const file of removeOldStateFiles(ctx.accountId)) logger.info({ file }, 'removed a file an earlier release kept (no longer used)')
    const textsCache = createTextsCache({ client, accountId: ctx.accountId, logger })
    const texts = new OpenClawTexts(textsCache)
    const first = await textsCache.start()
    if (first) logger.info({ version: first.version, manual: first.manual?.version, source: textsCache.source }, 'served texts in hand')
    else logger.warn({ err: textsCache.lastError }, 'served texts not available yet (AgentChat unreachable, nothing cached) — nothing is gated until the first copy arrives')
    const handle = config.agentHandle
    if (handle) {
      // The served identity line replaces a placed one that differs (an
      // install upgraded from a release that bundled the line gets the
      // served one on its first start): once from the copy in hand, then on
      // every copy that changes. An absent line is the wizard's / doctor's
      // to place.
      const refresh = (copy: Texts) => {
        const refreshed = refreshIdentityLine(ctx.cfg, ctx.accountId, handle, spellTextsForOpenClaw(copy).identity_line)
        if (refreshed.outcome === 'updated') ctx.log?.info?.(`[agentchat:${ctx.accountId}] identity line refreshed from the served texts in ${refreshed.path}`)
        else if (refreshed.outcome === 'failed') ctx.log?.warn?.(`[agentchat:${ctx.accountId}] identity line could not be refreshed in ${refreshed.path}: ${refreshed.detail ?? 'unknown error'}`)
      }
      if (first) refresh(first)
      textsCache.onChange((copy) => refresh(copy))
    }

    // One recorder per account for the socket's counters. OpenClaw offers a plugin no Prometheus registry (see
    // `metrics.ts`), so the counters live here and the status probe reads
    // them: `openclaw channels capabilities --channel agentchat`.
    const metrics = createInMemoryMetrics()

    await registerIntegration({
      accountId: ctx.accountId,
      config,
      logger,
      socketOptions: { client, metrics },
      build: (socket) => {
        const loop = createIntegrationLoop({
          accountId: ctx.accountId,
          agentId,
          client,
          texts,
          socket: socket.realtime,
          handle: config.agentHandle,
          callModel: createRuntimeModelCall({ agentIdOverride, ...(gateTimeoutMs !== undefined ? { timeoutMs: gateTimeoutMs } : {}) }),
          // A turn holds its conversation until OpenClaw confirms its run
          // ended; a wait that elapses is asked again (`integration/run.ts`).
          startRun: createRuntimeTurnStarter({
            onStillRunning,
            onWaitError: ({ runId, sessionKey, error, attempt, retryInMs }) =>
              logger[attempt === 1 ? 'warn' : 'debug']({ runId, sessionKey, error, attempt, retryInMs }, 'waiting for the turn to end failed — asking OpenClaw again'),
          }),
          // Gating waits until a turn can have the hosted tools (the MCP
          // entry in the LIVE config — OpenClaw hot-applies `mcp.*` — and
          // its key in this process): a connect wake on a cold gateway
          // otherwise spends a gate call and runs a turn that cannot look.
          readiness: () => {
            const live = readLiveConfig(ctx.cfg)
            // Too many hung turns: stop gating (each would only add a turn
            // that waits behind them); status and doctor say why.
            const hung = hungTurnsReason(turns, live.cfg)
            if (hung) return { ready: false, reason: hung }
            return turnReadiness({ cfg: live.cfg, apiBase: config.apiBase, apiKey: config.apiKey, live: live.live })
          },
          // The account's runs outlive this loop: a config change restarts
          // the account while its runs go on in OpenClaw, so every loop for
          // the account shares the same turns (and the kit tracker in them).
          turns,
          logger,
          metrics,
          gateEnabled: readReplyGateEnabledFromEnv(),
        })
        // True from the first rejected key until a HELLO is accepted again
        // (or the account stops). The SDK retries a rejected key with a fresh
        // HELLO every 10–15 min and reports each rejection as `blocked`; a
        // network failure in between takes it through `backoff`. For the
        // operator that is one situation, so it is one error line and one
        // steady `blocked` status at the first `blocked`, cleared at the next
        // accepted HELLO; every signal in between is a debug line, never a
        // health flap.
        let blocked = false
        return {
          loop,
          texts,
          textsCache,
          handlers: {
            onConnected: (at) => {
              if (blocked) {
                blocked = false
                ctx.log?.info?.(`[agentchat:${ctx.accountId}] key accepted again — blocked cleared`)
              }
              ctx.log?.info?.(`[agentchat:${ctx.accountId}] connected at ${new Date(at).toISOString()} (agent ${agentId})`)
              ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: true, connected: true, linked: true, statusState: 'linked', lastConnectedAt: at }, 'ready'))
            },
            onBlocked: (info) => {
              const close = `close ${info.code}${info.reason ? ` ${info.reason}` : ''}`
              const next = info.retryInMs === null ? 'no retry scheduled' : `next HELLO in about ${Math.max(1, Math.round(info.retryInMs / 60_000))} min`
              if (blocked) {
                ctx.log?.debug?.(`[agentchat:${ctx.accountId}] still blocked (${close}; ${next})`)
                return
              }
              blocked = true
              ctx.log?.error?.(
                `[agentchat:${ctx.accountId}] key rejected (${close}) — the server refused the key; the SDK retries a fresh HELLO every 10–15 min until it is accepted (${next}); rotate the key with openclaw channels add agentchat or openclaw config set channels.agentchat.apiKey …`,
              )
              ctx.setStatus(
                withLifecycle(
                  { ...ctx.getStatus(), running: false, connected: false, statusState: 'not-linked', lastDisconnect: { at: Date.now(), error: `key rejected: ${close}` } },
                  'blocked',
                ),
              )
            },
            onError: (err) => {
              // While blocked the one error line already said it.
              ctx.log?.[blocked ? 'debug' : 'warn']?.(`[agentchat:${ctx.accountId}] socket error: ${err.message}`)
            },
            onStateChanged: (next, prev) => {
              // The status follows the SDK's state. `ready` is reported by
              // onConnected (it has the time); `connecting` keeps whatever
              // came before (`starting` on the first attempt, `recovering`
              // after a backoff, `blocked` during a blocked retry).
              switch (next) {
                case 'backoff':
                  if (blocked) {
                    ctx.log?.debug?.(`[agentchat:${ctx.accountId}] socket in backoff while blocked (from ${prev})`)
                    return
                  }
                  ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: true, connected: false, statusState: 'unstable' }, 'recovering'))
                  return
                case 'stopped':
                  ctx.setStatus(withLifecycle({ ...ctx.getStatus(), running: false, connected: false, statusState: 'configured' }, 'stopped'))
                  return
                default:
                  return
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

export { getIntegration }
