/**
 * Which API key an account runs with, and from where.
 *
 * `channels.agentchat.apiKeyFile` names a `0600` key file only this plugin
 * reads (`./credentials/key-file.ts`); the config holds that path, never the
 * key. An install from before the key file still has the key in plain text
 * as `channels.agentchat.apiKey`: it is read as before (the old location is
 * the fallback), and setup and `openclaw doctor --fix` move it into a key
 * file. Every reader — the gateway, status, doctor, the wizard, the setup
 * hooks — goes through `resolveConfiguredApiKey`, so they never disagree.
 *
 * Both set: the file wins only when it holds the same key (a migration
 * that has not removed `apiKey` yet). Two different keys are refused with
 * a plain reason — never one picked silently over the other.
 */

import * as path from 'node:path'

import { isApiKeyPresent, readAccountRaw, readChannelSection } from './channel-account.js'
import { openclawCommand } from './cli-command.js'
import { readApiKeyFile } from './credentials/key-file.js'
import { resolveOpenClawStateDir } from './openclaw-layout.js'

export type ApiKeySource = 'file' | 'config'

export type ConfiguredKey =
  | {
      readonly ok: true
      readonly apiKey: string
      readonly source: ApiKeySource
      /** The key file in use (`source: 'file'`), or the one that could not be read while `apiKey` stood in. */
      readonly file?: string
      /** The key file is group- or world-readable. */
      readonly loosePermissions?: boolean
      /** `apiKeyFile` is set but unusable; the plain-text `apiKey` was used instead. */
      readonly fileProblem?: string
      /** The key file is used, and the same key is still in plain text as `apiKey` (a move that has not removed it yet). */
      readonly plainTextCopy?: boolean
    }
  | { readonly ok: false; readonly reason: string; readonly missing: boolean }

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** The key an account record (`channels.agentchat` or `accounts.<id>`) names. Reads the key file; never throws. */
export function resolveConfiguredApiKey(record: { readonly apiKey?: unknown; readonly apiKeyFile?: unknown } | undefined): ConfiguredKey {
  const file = nonEmptyString(record?.apiKeyFile)
  const inline = nonEmptyString(record?.apiKey)
  if (file) {
    const read = readApiKeyFile(file)
    if (read.ok) {
      if (inline && inline !== read.apiKey) {
        return {
          ok: false,
          missing: false,
          reason:
            `channels.agentchat.apiKey and the key in channels.agentchat.apiKeyFile (${read.path}) are different keys — keep one: ` +
            `run \`${openclawCommand('channels add --channel agentchat')}\` with the key you mean (it stores it in a key file and removes apiKey)`,
        }
      }
      return { ok: true, apiKey: read.apiKey, source: 'file', file: read.path, loosePermissions: read.loosePermissions, ...(inline ? { plainTextCopy: true } : {}) }
    }
    if (inline && isApiKeyPresent(inline)) return { ok: true, apiKey: inline, source: 'config', file: read.path, fileProblem: read.reason }
    return {
      ok: false,
      missing: false,
      reason: `channels.agentchat.apiKeyFile (${read.path}) cannot be used: ${read.reason} — run \`${openclawCommand('channels add --channel agentchat')}\` to store the key again`,
    }
  }
  if (inline) {
    if (isApiKeyPresent(inline)) return { ok: true, apiKey: inline, source: 'config' }
    return { ok: false, missing: false, reason: 'channels.agentchat.apiKey looks too short for an AgentChat API key' }
  }
  return { ok: false, missing: true, reason: `no API key configured (channels.agentchat.apiKeyFile) — run \`${openclawCommand('channels add --channel agentchat')}\`` }
}

/** `resolveConfiguredApiKey` for an account in an OpenClaw config. */
export function resolveAgentchatApiKey(cfg: Parameters<typeof readChannelSection>[0], accountId: string): ConfiguredKey {
  return resolveConfiguredApiKey(readAccountRaw(readChannelSection(cfg), accountId))
}

/** The account's key, or undefined when none can be used. */
export function readAgentchatApiKey(cfg: Parameters<typeof readChannelSection>[0], accountId: string): string | undefined {
  const key = resolveAgentchatApiKey(cfg, accountId)
  return key.ok ? key.apiKey : undefined
}

/**
 * The gateway's `AGENTCHAT_API_KEY` against the account's key. OpenClaw's
 * MCP client sends `${AGENTCHAT_API_KEY}` from the gateway's environment as
 * the hosted tools' bearer, while the socket and the gate use the
 * account's key: two different keys mean the turns would act as another
 * agent (or, after a key change, on the old key, so they have no tools).
 * An exported variable must never silently win over the configured
 * identity, so this is a refusal, in plain words; null when the variable
 * is unset (the readiness check reports that case) or the same key.
 * Whether the tools entry reads that variable at all is the caller's
 * question (`toolsUseOtherKey` in `./integration/mcp.ts`).
 */
export function gatewayKeyMismatch(apiKey: string, envKey: string | undefined, stateDir: string = resolveOpenClawStateDir()): string | null {
  if (envKey === undefined || envKey === apiKey.trim()) return null
  const restart = openclawCommand('gateway restart')
  return (
    "AGENTCHAT_API_KEY in the gateway's environment is not the key channels.agentchat is configured with, so the hosted " +
    'AgentChat tools in its turns would act as another agent (or on an old key). Not started. Where it comes from: an export ' +
    'in the shell that started the gateway — unset it there (`unset AGENTCHAT_API_KEY`); or the key changed since the gateway ' +
    `started — OpenClaw reads ${path.join(stateDir, '.env')} only when the gateway starts, and \`${openclawCommand('doctor --fix')}\` places the account's ` +
    `key there; or a gateway installed as a service keeps its own copy of .env — if \`${restart}\` warns that the ` +
    `daemon will use the old environment, reinstall it (\`${openclawCommand('gateway install --force')}\`). Then restart the gateway (\`${restart}\`).`
  )
}

/**
 * `gatewayKeyMismatch` in one sentence, for `openclaw channels status`
 * (`lastError`, which OpenClaw 2026.11.x prints both on the account line
 * and under Warnings); the gateway log has the full text.
 */
export function gatewayKeyMismatchStatus(): string {
  return (
    "AGENTCHAT_API_KEY in the gateway's environment is not the account's key, so the integration did not start (its turns would act as another agent): " +
    `unset it in the shell that started the gateway, or after a key change run \`${openclawCommand('doctor --fix')}\`; then restart the gateway (\`${openclawCommand('gateway restart')}\`). The gateway log says more.`
  )
}

/**
 * Whether a record names a key, without touching the filesystem: a key
 * file path, or a plausible plain-text key. For OpenClaw's cheap
 * "is anything configured" questions; the gateway and status resolve the
 * key itself and say when the file cannot be read.
 */
export function namesApiKey(record: { readonly apiKey?: unknown; readonly apiKeyFile?: unknown } | undefined): boolean {
  return nonEmptyString(record?.apiKeyFile) !== undefined || isApiKeyPresent(record?.apiKey)
}
