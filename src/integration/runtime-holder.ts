/**
 * The OpenClaw `PluginRuntime` handed to this plugin at registration.
 *
 * `defineChannelPluginEntry({ setRuntime })` (openclaw/plugin-sdk/channel-core)
 * calls `setRuntime(runtime)` in every registration mode except
 * `cli-metadata` and `tool-discovery` (docs.openclaw.ai/plugins/sdk-entrypoints/define-channel-plugin-entry).
 * The integration needs two of its helpers:
 *
 * - `runtime.llm.complete(...)` — the gate call on the agent's own model (tool-free).
 * - `runtime.subagent.run({ deliver: false, ... })` — one agent turn whose
 *   final text is not routed anywhere; the agent's send is its own hosted
 *   tool call.
 *
 * Stored here, read by `./model.ts`. Tests inject a fake through
 * `setPluginRuntime` and clear it with `resetPluginRuntimeForTest`.
 */

import type { PluginRuntime } from 'openclaw/plugin-sdk/channel-core'

let current: PluginRuntime | null = null

/**
 * OpenClaw 2026.10.9 loads a channel plugin for `channels add` in a
 * "setup-only" registration mode whose `api.runtime` is a Proxy that throws
 * on ANY property access — and still calls `setRuntime(api.runtime)`. A
 * guarded probe tells the real runtime from that proxy; the proxy is not
 * stored, so `getPluginRuntime()` is `null` in setup and nothing downstream
 * believes it has a runtime it cannot use.
 */
export function isUsablePluginRuntime(runtime: unknown): runtime is PluginRuntime {
  if (!runtime || (typeof runtime !== 'object' && typeof runtime !== 'function')) return false
  try {
    const probe = (runtime as { config?: unknown }).config
    return probe !== undefined || 'llm' in (runtime as object)
  } catch {
    return false
  }
}

export function setPluginRuntime(runtime: PluginRuntime): void {
  current = isUsablePluginRuntime(runtime) ? runtime : null
}

export function getPluginRuntime(): PluginRuntime | null {
  return current
}

export function resetPluginRuntimeForTest(): void {
  current = null
}
