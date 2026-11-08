/**
 * Per-account integration registry.
 *
 * OpenClaw's gateway starts one integration per `(channelId, accountId)` pair
 * at channel enable and stops it on shutdown. The registry holds the live
 * socket binding, the receive loop and the served texts so the status
 * adapter can report them, and serializes start/stop per account so a
 * start-during-stop never races.
 *
 * Keying is `accountId`-only; `channelId` is always `"agentchat"` here.
 */

import type { integration } from 'agentchatme'

import type { Logger } from '../log.js'
import type { AgentchatChannelConfig } from '../config-schema.js'
import { IntegrationSocket, type IntegrationSocketOptions, type SocketHandlers } from '../integration/socket.js'
import type { IntegrationLoop } from '../integration/loop.js'
import type { MetricsRecorder } from '../metrics.js'

export interface IntegrationEntry {
  readonly socket: IntegrationSocket
  readonly loop: IntegrationLoop | null
  /** The served texts as the loop reads them. */
  readonly texts: integration.TextsSource | null
  /** The recorder the socket binding and the loop count into; the status probe reads its snapshot when it keeps one. */
  readonly metrics: MetricsRecorder | null
  readonly config: AgentchatChannelConfig
  readonly logger: Logger
}

export interface BuiltIntegration {
  readonly loop: IntegrationLoop | null
  readonly texts?: integration.TextsSource | null
  /** Stopped after the loop (the texts refresh timer). */
  readonly textsCache?: integration.TextsCache | null
  readonly handlers: SocketHandlers
}

interface LiveEntry extends IntegrationEntry {
  readonly textsCache: integration.TextsCache | null
}

const registry = new Map<string, LiveEntry>()

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
  /** Builds the loop over the socket's SDK client, and the lifecycle handlers for the gateway. */
  readonly build: (socket: IntegrationSocket) => BuiltIntegration
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

    // The handlers close over what `build` returns and the loop over the
    // socket; a late-bound reference resolves the cycle. Nothing fires
    // before `bind()`.
    let built: BuiltIntegration | null = null
    const handlers: SocketHandlers = {
      onConnected: (at) => built?.handlers.onConnected?.(at),
      onDisconnected: (info) => built?.handlers.onDisconnected?.(info),
      onBlocked: (info) => built?.handlers.onBlocked?.(info),
      onError: (error) => built?.handlers.onError?.(error),
      onStateChanged: (next, prev) => built?.handlers.onStateChanged?.(next, prev),
    }
    const create = params.createSocket ?? ((options) => new IntegrationSocket(options))
    const socket = create({ config: params.config, logger: params.logger, handlers, ...(params.socketOptions ?? {}) })
    built = params.build(socket)

    const entry: LiveEntry = {
      socket,
      loop: built.loop,
      texts: built.texts ?? null,
      textsCache: built.textsCache ?? null,
      metrics: params.socketOptions?.metrics ?? null,
      config: params.config,
      logger: params.logger,
    }
    registry.set(params.accountId, entry)
    socket.bind()
    try {
      // The loop attaches to the socket's client and connects it.
      await built.loop?.loop.start()
    } catch (err) {
      registry.delete(params.accountId)
      await stopEntry(entry)
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

async function stopEntry(entry: LiveEntry): Promise<void> {
  try {
    // Stops the cycles and disconnects the socket. Runs already admitted
    // are OpenClaw's; they stay registered for the account until they end.
    await entry.loop?.stop()
  } catch (err) {
    entry.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'receive loop stop threw during unregister')
  }
  if (!entry.loop) {
    try {
      entry.socket.realtime.disconnect()
    } catch {
      // never connected
    }
  }
  entry.socket.stopped()
  entry.textsCache?.stop()
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
