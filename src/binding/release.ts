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
 * Two halves, because the CLI is a separate process from the gateway that
 * holds the turns: a gateway method (`agentchat.release`, operator-admin
 * scope) registered in the gateway, and the CLI command that calls it over
 * the gateway's own RPC (`callGatewayFromCli`, the plugin SDK's helper, which
 * reads the gateway URL and token the same way `openclaw gateway call` does).
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core'

import { accountTurns } from '../integration/running.js'
import { AGENTCHAT_CHANNEL_ID } from '../channel-account.js'

export const RELEASE_METHOD = 'agentchat.release'

type ReleaseParams = { readonly id?: unknown; readonly accountId?: unknown }

/** The gateway half: release the turn holding `id` (a conversation or invite id) for the account. */
export function releaseTurnFor(params: ReleaseParams): { ok: true; result: ReturnType<ReturnType<typeof accountTurns>['release']> } | { ok: false; error: string } {
  const id = typeof params.id === 'string' ? params.id.trim() : ''
  if (!id) return { ok: false, error: 'a conversation (or invite) id is required' }
  const accountId = typeof params.accountId === 'string' && params.accountId.trim() ? params.accountId.trim() : 'default'
  return { ok: true, result: accountTurns(accountId).release(id) }
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
          'Let go of the turn holding a conversation (or invite) whose OpenClaw run never ended. The run is not stopped: if it answers later, the peer can get a second reply.',
        )
        .option('--account <accountId>', 'the AgentChat account', 'default')
        .option('--url <url>', 'gateway URL (default: the configured gateway)')
        .option('--token <token>', 'gateway token (default: the configured one)')
        .option('--json', 'print the raw result')
        .action(async (id: string, opts: { account?: string; url?: string; token?: string; json?: boolean }) => {
          // Loaded only when the command runs: the gateway runtime is OpenClaw's.
          const { callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime')
          const result = (await callGatewayFromCli(
            RELEASE_METHOD,
            { ...(opts.url ? { url: opts.url } : {}), ...(opts.token ? { token: opts.token } : {}), ...(opts.json ? { json: true } : {}) },
            { id, accountId: opts.account ?? 'default' },
          )) as { released?: boolean; what?: string; reason?: string }
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(result)}\n`)
          } else if (result?.released) {
            process.stdout.write(
              `released ${id} (${result.what === 'hung' ? 'a hung turn' : 'a running turn'}) — it may be gated again now; its OpenClaw run was not stopped\n`,
            )
          } else {
            process.stdout.write(`nothing released: ${result?.reason ?? 'unknown'}\n`)
          }
        })
      void release
    },
    {
      commands: [AGENTCHAT_CHANNEL_ID],
      descriptors: [{ name: AGENTCHAT_CHANNEL_ID, description: 'The AgentChat integration (release a hung turn)', hasSubcommands: true }],
    },
  )
}
