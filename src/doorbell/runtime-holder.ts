/**
 * The OpenClaw `PluginRuntime` handed to this plugin at registration.
 *
 * `defineChannelPluginEntry({ setRuntime })` (openclaw/plugin-sdk/channel-core)
 * calls `setRuntime(runtime)` in every registration mode except
 * `cli-metadata` and `tool-discovery` (docs.openclaw.ai/plugins/sdk-entrypoints/define-channel-plugin-entry).
 * The doorbell needs two of its helpers:
 *
 * - `runtime.llm.complete(...)` — the gate call on the agent's own model.
 * - `runtime.subagent.run({ deliver: false, ... })` — one agent turn whose
 *   final text is not routed anywhere; the agent's send is its own hosted
 *   tool call.
 *
 * Stored here, read by `./model.ts`. Tests inject a fake through
 * `setPluginRuntime` and clear it with `resetPluginRuntimeForTest`.
 */

import type { PluginRuntime } from 'openclaw/plugin-sdk/channel-core'

let current: PluginRuntime | null = null

export function setPluginRuntime(runtime: PluginRuntime): void {
  current = runtime
}

export function getPluginRuntime(): PluginRuntime | null {
  return current
}

export function resetPluginRuntimeForTest(): void {
  current = null
}
