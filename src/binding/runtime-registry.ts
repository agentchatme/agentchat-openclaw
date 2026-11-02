/**
 * Per-account doorbell registry.
 *
 * OpenClaw's gateway starts one doorbell per `(channelId, accountId)` pair at
 * channel enable and stops it on shutdown. The registry holds the live
 * socket runtime and its invoker so the status adapter can report them, and
 * serializes start/stop per account so a start-during-stop never races.
 *
 * Keying is `accountId`-only; `channelId` is always `"agentchat"` here.
 */

import type { Logger } from '../log.js'
import type { AgentchatChannelConfig } from '../config-schema.js'
import { AgentchatChannelRuntime, type ChannelRuntimeHandlers } from '../runtime.js'
import type { AgentInvoker } from '../doorbell/invoker.js'

export interface DoorbellEntry {
  readonly runtime: AgentchatChannelRuntime
  readonly invoker: AgentInvoker | null
  readonly config: AgentchatChannelConfig
  readonly logger: Logger
}

const registry = new Map<string, DoorbellEntry>()

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

export interface RegisterDoorbellParams {
  readonly accountId: string
  readonly config: AgentchatChannelConfig
  readonly logger: Logger
  /** Builds the invoker and the handlers that feed it, given the runtime that will be started. */
  readonly build: (runtime: AgentchatChannelRuntime) => { invoker: AgentInvoker | null; handlers: ChannelRuntimeHandlers }
  /** Test seam for the runtime constructor. */
  readonly createRuntime?: (params: { config: AgentchatChannelConfig; logger: Logger; handlers: ChannelRuntimeHandlers }) => AgentchatChannelRuntime
}

/**
 * Create and start a doorbell for `accountId`. If one is already registered,
 * stop it first (config change path). Returns the live entry.
 */
export function registerDoorbell(params: RegisterDoorbellParams): Promise<DoorbellEntry> {
  return withAccountLock(params.accountId, async () => {
    const existing = registry.get(params.accountId)
    if (existing) {
      await stopEntry(existing, Date.now() + 2_000)
      registry.delete(params.accountId)
    }

    // The handlers close over the runtime and the runtime over the handlers;
    // a late-bound reference resolves the cycle. The socket cannot deliver a
    // frame before `start()`, so the reference is set before any handler runs.
    let runtimeRef: AgentchatChannelRuntime | null = null
    let built: { invoker: AgentInvoker | null; handlers: ChannelRuntimeHandlers } | null = null
    const handlers: ChannelRuntimeHandlers = {
      onKnock: (source) => built?.handlers.onKnock?.(source),
      onGroupInvite: (invite) => built?.handlers.onGroupInvite?.(invite),
      onStateChanged: (next, prev) => built?.handlers.onStateChanged?.(next, prev),
      onAuthenticated: (at) => built?.handlers.onAuthenticated?.(at),
      onError: (error) => built?.handlers.onError?.(error),
    }
    const create = params.createRuntime ?? ((p) => new AgentchatChannelRuntime(p))
    runtimeRef = create({ config: params.config, logger: params.logger, handlers })
    built = params.build(runtimeRef)

    const entry: DoorbellEntry = { runtime: runtimeRef, invoker: built.invoker, config: params.config, logger: params.logger }
    registry.set(params.accountId, entry)
    try {
      runtimeRef.start()
    } catch (err) {
      registry.delete(params.accountId)
      built.invoker?.stop()
      throw err
    }
    return entry
  })
}

/** Stop and remove the doorbell for `accountId`. No-op if absent. */
export function unregisterDoorbell(accountId: string, deadlineMs = Date.now() + 5_000): Promise<void> {
  return withAccountLock(accountId, async () => {
    const entry = registry.get(accountId)
    if (!entry) return
    registry.delete(accountId)
    await stopEntry(entry, deadlineMs)
  })
}

async function stopEntry(entry: DoorbellEntry, deadlineMs: number): Promise<void> {
  entry.invoker?.stop()
  try {
    await entry.runtime.stop(deadlineMs)
  } catch (err) {
    entry.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'runtime.stop threw during unregister')
  }
}

export function getDoorbell(accountId: string): DoorbellEntry | undefined {
  return registry.get(accountId)
}

export function listActiveAccounts(): string[] {
  return [...registry.keys()]
}

/** Test hook only. */
export async function resetRegistryForTest(): Promise<void> {
  const entries = [...registry.values()]
  registry.clear()
  await Promise.all(entries.map((entry) => stopEntry(entry, Date.now() + 500).catch(() => undefined)))
}
