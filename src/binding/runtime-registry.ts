/**
 * Per-account integration registry.
 *
 * OpenClaw's gateway starts one integration per `(channelId, accountId)` pair
 * at channel enable and stops it on shutdown. The registry holds the live
 * socket, its invoker and the texts store so the status adapter can report
 * them, and serializes start/stop per account so a start-during-stop never
 * races.
 *
 * Keying is `accountId`-only; `channelId` is always `"agentchat"` here.
 */

import type { Logger } from '../log.js'
import type { AgentchatChannelConfig } from '../config-schema.js'
import { IntegrationSocket, type IntegrationSocketOptions, type SocketHandlers } from '../integration/socket.js'
import type { AgentInvoker } from '../integration/invoker.js'
import type { TextsStore } from '../integration/texts.js'
import type { MetricsRecorder } from '../metrics.js'

export interface IntegrationEntry {
  readonly socket: IntegrationSocket
  readonly invoker: AgentInvoker | null
  readonly texts: TextsStore | null
  /** The recorder the socket (and the invoker) count into; the status probe reads its snapshot when it keeps one. */
  readonly metrics: MetricsRecorder | null
  readonly config: AgentchatChannelConfig
  readonly logger: Logger
}

const registry = new Map<string, IntegrationEntry>()

/** Per-account mutex: every register/unregister for the same account runs through this queue. */
const accountLocks = new Map<string, Promise<unknown>>()

function withAccountLock<T>(accountId: string, op: () => Promise<T>): Promise<T> {
  const prev = accountLocks.get(accountId) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(op)
  accountLocks.set(accountId, next)
  next.then(
    () => {
      if (accountLocks.get(accountId) === next) accountLocks.delete(accountId)
    },
    () => {
      if (accountLocks.get(accountId) === next) accountLocks.delete(accountId)
    },
  )
  return next
}

export interface RegisterIntegrationParams {
  readonly accountId: string
  readonly config: AgentchatChannelConfig
  readonly logger: Logger
  /** Builds the invoker and the handlers that feed it, given the socket that will be started. */
  readonly build: (socket: IntegrationSocket) => { invoker: AgentInvoker | null; texts?: TextsStore | null; handlers: SocketHandlers }
  /** Extra socket options (the SDK client for the reconnect drain, a WebSocket seam). */
  readonly socketOptions?: Pick<IntegrationSocketOptions, 'client' | 'webSocket' | 'metrics' | 'createRealtime'>
  /** Test seam for the socket constructor. */
  readonly createSocket?: (options: IntegrationSocketOptions) => IntegrationSocket
}

/**
 * Create and start an integration for `accountId`. If one is already
 * registered, stop it first (config change path). Returns the live entry.
 */
export function registerIntegration(params: RegisterIntegrationParams): Promise<IntegrationEntry> {
  return withAccountLock(params.accountId, async () => {
    const existing = registry.get(params.accountId)
    if (existing) {
      await stopEntry(existing)
      registry.delete(params.accountId)
    }

    // The handlers close over the socket and the socket over the handlers;
    // a late-bound reference resolves the cycle. The socket cannot deliver a
    // frame before `start()`, so the reference is set before any handler runs.
    let built: { invoker: AgentInvoker | null; texts?: TextsStore | null; handlers: SocketHandlers } | null = null
    const handlers: SocketHandlers = {
      onWake: (source, detail) => built?.handlers.onWake?.(source, detail),
      onConnected: (at) => built?.handlers.onConnected?.(at),
      onDisconnected: (info) => built?.handlers.onDisconnected?.(info),
      onBlocked: (info) => built?.handlers.onBlocked?.(info),
      onError: (error) => built?.handlers.onError?.(error),
      onStateChanged: (next, prev) => built?.handlers.onStateChanged?.(next, prev),
    }
    const create = params.createSocket ?? ((options) => new IntegrationSocket(options))
    const socket = create({ config: params.config, logger: params.logger, handlers, ...(params.socketOptions ?? {}) })
    built = params.build(socket)

    const entry: IntegrationEntry = {
      socket,
      invoker: built.invoker,
      texts: built.texts ?? null,
      metrics: params.socketOptions?.metrics ?? null,
      config: params.config,
      logger: params.logger,
    }
    registry.set(params.accountId, entry)
    try {
      await socket.start()
    } catch (err) {
      registry.delete(params.accountId)
      built.invoker?.stop()
      built.texts?.stop()
      throw err
    }
    return entry
  })
}

/** Stop and remove the integration for `accountId`. No-op if absent. */
export function unregisterIntegration(accountId: string): Promise<void> {
  return withAccountLock(accountId, async () => {
    const entry = registry.get(accountId)
    if (!entry) return
    registry.delete(accountId)
    await stopEntry(entry)
  })
}

async function stopEntry(entry: IntegrationEntry): Promise<void> {
  entry.invoker?.stop()
  entry.texts?.stop()
  try {
    await entry.socket.stop()
  } catch (err) {
    entry.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'socket.stop threw during unregister')
  }
}

export function getIntegration(accountId: string): IntegrationEntry | undefined {
  return registry.get(accountId)
}

export function listActiveAccounts(): string[] {
  return [...registry.keys()]
}

/** Test hook only. */
export async function resetRegistryForTest(): Promise<void> {
  const entries = [...registry.values()]
  registry.clear()
  await Promise.all(entries.map((entry) => stopEntry(entry).catch(() => undefined)))
}
