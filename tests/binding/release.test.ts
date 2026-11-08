/**
 * `openclaw agentchat release <conversation_id>`: the gateway method lets go
 * of a hung (or still kit-held) turn so its conversation can be gated again;
 * the CLI command is registered as `openclaw agentchat release` and calls
 * that method over the gateway's RPC.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { RELEASE_METHOD, registerReleaseCli, registerReleaseGatewayMethod, releaseLine, releaseTurnFor } from '../../src/binding/release.js'
import { accountTurns, findAccountTurns, resetRunningTurnsForTest } from '../../src/integration/running.js'

afterEach(() => resetRunningTurnsForTest())

describe('the gateway half', () => {
  it('releases a hung hold for the named conversation; refuses an empty id; says when nothing holds it', () => {
    const turns = accountTurns('default')
    turns.tracker.begin({ kind: 'reply', conversationId: 'conv_a', anchor: 'msg_1' })
    turns.started({ runId: 'run_1', kind: 'reply', id: 'conv_a', anchor: 'msg_1', sessionKey: 's', startedAt: 0, owner: 'loop#1' })
    turns.handOff('run_1')
    expect(releaseTurnFor({ id: 'conv_a' })).toEqual({ ok: true, result: { released: true, what: 'hung', key: 'conversation:conv_a', runId: 'run_1' } })
    expect(turns.tracker.conversationRunning('conv_a')).toBe(false)
    expect(releaseTurnFor({ id: ' ' })).toEqual({ ok: false, error: 'a conversation (or invite) id is required' })
    expect(releaseTurnFor({ id: 'conv_b' })).toEqual({ ok: true, result: { released: false, reason: 'no turn holds conv_b' } })
    // An account with no turns here is looked up, never created.
    expect(releaseTurnFor({ id: 'conv_b', accountId: 'other' })).toEqual({ ok: true, result: { released: false, reason: 'the AgentChat account "other" has no turns in this gateway' } })
    expect(findAccountTurns('other')).toBeUndefined()
  })

  it('a turn under 30 minutes is refused unless force is passed (the CLI’s --force)', () => {
    const turns = accountTurns('default')
    turns.tracker.begin({ kind: 'reply', conversationId: 'conv_a', anchor: 'msg_1' })
    turns.started({ runId: 'run_1', kind: 'reply', id: 'conv_a', anchor: 'msg_1', sessionKey: 's', startedAt: Date.now() - 4 * 60_000, owner: 'loop#1' })
    const refused = releaseTurnFor({ id: 'conv_a' })
    expect(refused).toMatchObject({ ok: true, result: { released: false } })
    expect(releaseLine('conv_a', (refused as unknown as { result: never }).result)).toMatch(/^nothing released: the turn for conversation conv_a has run 4 min — .*two replies.*--force$/)
    expect(releaseTurnFor({ id: 'conv_a', force: 'yes' })).toMatchObject({ result: { released: false } }) // only a real true
    const forced = releaseTurnFor({ id: 'conv_a', force: true })
    expect(forced).toMatchObject({ ok: true, result: { released: true, what: 'running', runId: 'run_1' } })
    expect(releaseLine('conv_a', (forced as unknown as { result: never }).result)).toBe(
      'released conv_a (a running turn) — it may be gated again now; its OpenClaw run was not stopped, and if it still sends an answer the peer gets two replies',
    )
  })

  it('is registered as agentchat.release with the operator-admin scope and answers through respond', () => {
    let registered: { method: string; handler: (o: never) => void; opts: unknown } | null = null
    registerReleaseGatewayMethod({ registerGatewayMethod: ((method: string, handler: never, opts: unknown) => (registered = { method, handler, opts })) as never })
    expect(registered!.method).toBe(RELEASE_METHOD)
    expect(registered!.opts).toEqual({ scope: 'operator.admin' })
    const answers: unknown[][] = []
    registered!.handler({ params: { id: '' }, respond: (...args: unknown[]) => answers.push(args) } as never)
    expect(answers[0]![0]).toBe(false)
  })
})

describe('the CLI half', () => {
  it('registers `openclaw agentchat release <id>` with a parse-time descriptor', () => {
    const commands: string[] = []
    const flags: string[] = []
    const fake = (name: string) => {
      commands.push(name)
      const cmd = { description: () => cmd, option: (flag: string) => (flags.push(flag), cmd), action: () => cmd, command: (n: string) => fake(n) }
      return cmd
    }
    let options: unknown = null
    registerReleaseCli({
      registerCli: ((registrar: (ctx: never) => void, opts: unknown) => {
        options = opts
        registrar({ program: { command: (n: string) => fake(n) } } as never)
      }) as never,
    })
    expect(commands).toEqual(['agentchat', 'release <id>'])
    expect(flags).toContain('--force')
    expect(options).toMatchObject({ commands: ['agentchat'], descriptors: [{ name: 'agentchat', hasSubcommands: true }] })
  })
})
