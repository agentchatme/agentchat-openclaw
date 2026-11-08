/**
 * `openclaw agentchat release <conversation_id>`: the gateway method lets go
 * of a hung (or still kit-held) turn so its conversation can be gated again;
 * the CLI command is registered as `openclaw agentchat release` and calls
 * that method over the gateway's RPC.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { RELEASE_METHOD, registerReleaseCli, registerReleaseGatewayMethod, releaseTurnFor } from '../../src/binding/release.js'
import { accountTurns, resetRunningTurnsForTest } from '../../src/integration/running.js'

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
    expect(releaseTurnFor({ id: 'conv_b', accountId: 'other' })).toEqual({ ok: true, result: { released: false, reason: 'no turn holds conv_b' } })
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
    const fake = (name: string) => {
      commands.push(name)
      const cmd = { description: () => cmd, option: () => cmd, action: () => cmd, command: (n: string) => fake(n) }
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
    expect(options).toMatchObject({ commands: ['agentchat'], descriptors: [{ name: 'agentchat', hasSubcommands: true }] })
  })
})
