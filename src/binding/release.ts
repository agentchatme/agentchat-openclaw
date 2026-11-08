/**
 * `openclaw agentchat release <conversation_id>` — the operator's way to let
 * go of a turn OpenClaw never reports as ended.
 *
 * A turn holds its conversation until its run ends, so a run that hangs keeps
 * that conversation from being answered again (no second reply), and after
 * two hung turns the account stops gating. OpenClaw offers a plugin no abort
 * for a subagent run, so the release does not end the run: it lets the
 * conversation be gated again. If the run is in fact still alive and answers
 * later, the peer can get a second reply — the operator's call, and the
 * command says so.
 *
 * A turn under 30 minutes is most likely still working, so the command
 * refuses it unless `--force` is given: released, its conversation could be
 * gated again while the run can still send its answer — two replies. A hung
 * turn (handed off past 30 minutes) and a conversation held after a gateway
 * restart are released without it.
 *
 * Two halves, because the CLI is a separate process from the gateway that
 * holds the turns: a gateway method (`agentchat.release`, operator-admin
 * scope) registered in the gateway, and the CLI command that calls it over
 * the gateway's own RPC (`callGatewayFromCli`, the plugin SDK's helper, which
 * reads the gateway URL and token the same way `openclaw gateway call` does).
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core'

import { TURN_OVERDUE_MS, findAccountTurns, type ReleaseResult } from '../integration/running.js'
import { AGENTCHAT_CHANNEL_ID } from '../channel-account.js'

export const RELEASE_METHOD = 'agentchat.release'

type ReleaseParams = { readonly id?: unknown; readonly accountId?: unknown; readonly force?: unknown }

/** The gateway half: release the turn holding `id` (a conversation, invite or run id) for the account. Never creates account state. */
export function releaseTurnFor(params: ReleaseParams): { ok: true; result: ReleaseResult } | { ok: false; error: string } {
  const id = typeof params.id === 'string' ? params.id.trim() : ''
  if (!id) return { ok: false, error: 'a conversation (or invite) id is required' }
  const accountId = typeof params.accountId === 'string' && params.accountId.trim() ? params.accountId.trim() : 'default'
  const turns = findAccountTurns(accountId)
  if (!turns) return { ok: true, result: { released: false, reason: `the AgentChat account "${accountId}" has no turns in this gateway` } }
  return { ok: true, result: turns.release(id, { force: params.force === true }) }
}

export function registerReleaseGatewayMethod(api: Pick<OpenClawPluginApi, 'registerGatewayMethod'>): void {
  api.registerGatewayMethod(
    RELEASE_METHOD,
    ({ params, respond }) => {
      const outcome = releaseTurnFor(params as ReleaseParams)
      if (!outcome.ok) {
        respond(false, undefined, { code: 'INVALID_REQUEST', message: outcome.error } as never)
        return
      }
      respond(true, outcome.result)
    },
    { scope: 'operator.admin' },
  )
}

export function registerReleaseCli(api: Pick<OpenClawPluginApi, 'registerCli'>): void {
  api.registerCli(
    ({ program }) => {
      const root = program.command(AGENTCHAT_CHANNEL_ID).description('The AgentChat integration')
      const release = root
        .command('release <id>')
        .description(
          `Let go of the turn holding a conversation (or invite) whose OpenClaw run never ended. The run is not stopped: if it answers later, the peer can get a second reply. A turn under ${TURN_OVERDUE_MS / 60_000} minutes is refused without --force.`,
        )
        .option('--account <accountId>', 'the AgentChat account', 'default')
        .option('--force', `release a turn that has run under ${TURN_OVERDUE_MS / 60_000} minutes (it is most likely still working: two replies are possible)`)
        .option('--url <url>', 'gateway URL (default: the configured gateway)')
        .option('--token <token>', 'gateway token (default: the configured one)')
        .option('--json', 'print the raw result')
        .action(async (id: string, opts: { account?: string; url?: string; token?: string; json?: boolean; force?: boolean }) => {
          // Loaded only when the command runs: the gateway runtime is OpenClaw's.
          const { callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime')
          const result = (await callGatewayFromCli(
            RELEASE_METHOD,
            { ...(opts.url ? { url: opts.url } : {}), ...(opts.token ? { token: opts.token } : {}), ...(opts.json ? { json: true } : {}) },
            { id, accountId: opts.account ?? 'default', ...(opts.force ? { force: true } : {}) },
          )) as { released?: boolean; what?: string; reason?: string }
          process.stdout.write(opts.json ? `${JSON.stringify(result)}\n` : `${releaseLine(id, result)}\n`)
        })
      void release
    },
    {
      commands: [AGENTCHAT_CHANNEL_ID],
      descriptors: [{ name: AGENTCHAT_CHANNEL_ID, description: 'The AgentChat integration (release a hung turn)', hasSubcommands: true }],
    },
  )
}

/** What the command prints. */
export function releaseLine(id: string, result: { released?: boolean; what?: string; reason?: string } | null | undefined): string {
  if (!result?.released) return `nothing released: ${result?.reason ?? 'unknown'}`
  if (result.what === 'restart') return `released ${id} (held after a gateway restart) — it may be gated again now`
  const what = result.what === 'hung' ? 'a hung turn' : 'a running turn'
  return `released ${id} (${what}) — it may be gated again now; its OpenClaw run was not stopped, and if it still sends an answer the peer gets two replies`
}
