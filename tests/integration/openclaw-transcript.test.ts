/**
 * The rows the installed OpenClaw itself writes for hosted AgentChat calls,
 * and how the plugin counts them. ci.yml runs this against the lockfile's
 * OpenClaw (2026.6.10, the oldest supported release); openclaw-latest.yml
 * against the newest. If a release changes how a failed call is stored, or
 * moves the code that stores it, this fails (tests/helpers/openclaw-session.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { integration } from 'agentchatme'

import { countAgentChatCalls } from '../../src/integration/run.js'
import { card, tray } from '../helpers/fake-client.js'
import { dispatchOkLarge, dispatchServerErrorLarge, mcpOk, mcpServerError, mcpThrew, withSeq, type OpenClawLine } from '../helpers/openclaw-rows.js'
import { installedOpenClaw, RUN_ID, runHostedCalls, versionAtLeast } from '../helpers/openclaw-session.js'

const openclaw = installedOpenClaw()
/** From 2026.9.3 OpenClaw sets `isError` from the result details (openclaw/openclaw#139758). */
const marksFailures = versionAtLeast(openclaw.version, '2026.9.3')
const line: OpenClawLine = marksFailures ? '2026.11.3' : '2026.6.10'

/** The fields the count reads (a release may add others, such as `__openclaw` tags). */
const shape = (row: Record<string, unknown> | undefined) => ({
  role: row?.role,
  toolCallId: row?.toolCallId,
  toolName: row?.toolName,
  content: row?.content,
  details: row?.details,
  isError: row?.isError,
})

function secondSilentLook(calls: ReturnType<typeof countAgentChatCalls>): string {
  const gateCard = card('conv_a', 'msg_1')
  return integration.turnOutcome({ turn: { status: 'completed', agentchatCalls: calls }, turnStartedAt: 0, gateCard, freshTray: tray([gateCard]), silentBefore: 1 }).action
}

// Whatever the session code reads by default stays in a scratch home.
let home: string
const saved = process.env.HOME
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agentchat-openclaw-home-'))
  process.env.HOME = home
})
afterAll(() => {
  process.env.HOME = saved
  rmSync(home, { recursive: true, force: true })
})

describe(`OpenClaw ${openclaw.version} (installed) — hosted-call rows`, () => {
  it('a failed call: the server failed it, or it threw — stored as the fixtures say, counted as failed, not dismissed', async () => {
    const messages = await runHostedCalls(openclaw, [
      { tool: 'agentchat_inbox', outcome: 'ok' },
      { tool: 'agentchat_send_message', outcome: 'server_error' },
      { tool: 'agentchat_get_conversation', outcome: 'throws' },
    ])
    const results = messages.filter((message) => message.role === 'toolResult')
    expect(results.map(shape)).toEqual([
      shape(mcpOk(line, 'call_0', 'agentchat_inbox')),
      shape(mcpServerError(line, 'call_1', 'agentchat_send_message')),
      shape(mcpThrew(line, 'call_2', 'agentchat_get_conversation')),
    ])
    // The defect this guards: before 2026.9.3 only the details say the calls failed.
    expect(results.map((row) => row.isError)).toEqual([false, marksFailures, marksFailures])

    const counted = countAgentChatCalls(withSeq(messages))
    expect(counted).toEqual({ made: 3, failed: 2 })
    expect(secondSilentLook(counted)).toBe('record_defer')
  })

  it('a clean turn: counted exactly, and the second silent look dismisses', async () => {
    const messages = await runHostedCalls(openclaw, [
      { tool: 'agentchat_inbox', outcome: 'ok' },
      { tool: 'agentchat_get_conversation', outcome: 'ok' },
    ])
    const counted = countAgentChatCalls(withSeq(messages))
    expect(counted).toEqual({ made: 2, failed: 0 })
    expect(secondSilentLook(counted)).toBe('record_dismiss')
  })
})

describe(`OpenClaw ${openclaw.version} (installed) — Tool Search results over 8 KiB, stored through the persistence guard`, () => {
  const stored = (row: Record<string, unknown> | undefined) => ({ toolName: row?.toolName, details: row?.details, isError: row?.isError })

  it(`a success: ${marksFailures ? 'ok — the dispatcher row says failure at its top level' : 'unknown — a failure would have been nested and lost'}`, async () => {
    const messages = await runHostedCalls(openclaw, [{ tool: 'agentchat_get_conversation', outcome: 'ok' }], { toolSearch: true, guard: true, textBytes: 9_000 })
    const dispatched = messages.find((message) => message.role === 'toolResult')
    expect(stored(dispatched)).toEqual(stored(dispatchOkLarge(line, 'call_0')))
    const counted = countAgentChatCalls(withSeq(messages), RUN_ID, { openclawVersion: openclaw.version })
    expect(counted).toEqual(marksFailures ? { made: 1, failed: 0 } : null)
  })

  it(`a server failure: ${marksFailures ? 'failed' : 'unknown'} — never ok`, async () => {
    const messages = await runHostedCalls(openclaw, [{ tool: 'agentchat_get_conversation', outcome: 'server_error' }], { toolSearch: true, guard: true, textBytes: 9_000 })
    const dispatched = messages.find((message) => message.role === 'toolResult')
    expect(stored(dispatched)).toEqual(stored(dispatchServerErrorLarge(line, 'call_0')))
    const counted = countAgentChatCalls(withSeq(messages), RUN_ID, { openclawVersion: openclaw.version })
    expect(counted).toEqual(marksFailures ? { made: 1, failed: 1 } : null)
    expect(secondSilentLook(counted)).not.toBe('record_dismiss')
  })
})
