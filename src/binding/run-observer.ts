/**
 * Seeing runs the plugin did not start: OpenClaw's `model_call_started`
 * hook (each model call names its run and session). The one use: after a
 * gateway restart, OpenClaw may continue a turn's session on its own (the
 * restart resume asks the agent's main session to "send a fresh instruction
 * to the same retained child session"); a run seen in the session of a turn
 * adopted from the last process keeps that conversation held until it ends
 * (`AccountTurns.observeRun`). A third-party plugin has no API that lists
 * live runs, and this hook needs no grant (it is not a conversation-access
 * or prompt hook). An OpenClaw release without the hook ignores it.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core'

import { observeRunStarted } from '../integration/running.js'

export function registerRunObserver(api: Pick<OpenClawPluginApi, 'on'>): void {
  api.on('model_call_started', (event, ctx) => {
    observeRunStarted(event.runId, event.sessionKey ?? ctx?.sessionKey)
  })
}
