/**
 * Single import point for OpenClaw SDK types used across the binding layer.
 *
 * `openclaw/plugin-sdk/channel-core` exports the common types (`ChannelPlugin`,
 * `OpenClawConfig`, `PluginRuntime`, `buildChannelConfigSchema`,
 * `defineChannelPluginEntry`). `openclaw/plugin-sdk/channel-contract`
 * re-exports the adapter interface types that aren't in the core barrel.
 * Anything that is neither in core nor contract is derived here via indexed
 * access on `ChannelPlugin`.
 *
 * Both subpaths are present in the installed 2026.6.10 and in 2026.10.9, and
 * neither is marked deprecated in the SDK subpath catalog
 * (docs.openclaw.ai/plugins/sdk-subpaths).
 */

export type { ChannelPlugin, OpenClawConfig, ChannelConfigUiHint, PluginRuntime } from 'openclaw/plugin-sdk/channel-core'

export type { ChannelGatewayContext, ChannelStatusIssue } from 'openclaw/plugin-sdk/channel-contract'

import type { ChannelPlugin } from 'openclaw/plugin-sdk/channel-core'

export type ChannelGatewayAdapter<T = unknown> = NonNullable<ChannelPlugin<T>['gateway']>
export type ChannelStatusAdapter<T = unknown, P = unknown> = NonNullable<ChannelPlugin<T, P>['status']>
export type ChannelDoctorAdapter = NonNullable<ChannelPlugin<unknown>['doctor']>

/** One line the status adapter can surface to `openclaw channels status`. */
export type ChannelCapabilitiesDisplayLine = {
  text: string
  tone?: 'default' | 'muted' | 'success' | 'warn' | 'error'
}
