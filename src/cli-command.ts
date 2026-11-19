/**
 * `openclaw …` commands the plugin prints, as the operator must type them
 * to reach this install.
 *
 * `openclaw --profile oc2 …` runs with `OPENCLAW_PROFILE=oc2` (OpenClaw sets
 * it for the process, and a profile's gateway service carries it), and its
 * state lives in `~/.openclaw-oc2`. A next step printed there as a bare
 * `openclaw gateway restart` would, typed as printed, restart the default
 * profile's gateway and leave this one as it was. OpenClaw's own formatter
 * (`formatCliCommand`, the one its own hints use) adds `--profile <name>` —
 * or `--container <name>` for a containerised install — so every command the
 * plugin prints goes through it. Paths are printed resolved (the state dir
 * of this profile), never as `~/.openclaw`.
 */

import { formatCliCommand } from 'openclaw/plugin-sdk/setup'

/** `openclaw <args>` for the profile (or container) this process runs under. */
export function openclawCommand(args: string): string {
  return formatCliCommand(`openclaw ${args}`)
}
