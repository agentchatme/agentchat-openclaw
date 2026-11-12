/**
 * Real OpenClaw agent turns (tests/helpers/openclaw-agent-turn.ts) and how
 * the plugin counts what they store. These need a release that records
 * nested calls and marks failed rows (2026.9.3 and later) and the Node line
 * it runs on: openclaw-latest.yml runs them against the newest release; on
 * the lockfile's 2026.6.10 (ci.yml) they are skipped — that floor is covered
 * by ./openclaw-transcript.test.ts and the fixtures.
 */

import { describe, expect, it } from 'vitest'
import { integration } from 'agentchatme'

import { countAgentChatCalls, openclawVersionAtLeast, TRANSCRIPT_READ_LIMIT } from '../../src/integration/run.js'
import { card, tray } from '../helpers/fake-client.js'
import { runAgentTurn } from '../helpers/openclaw-agent-turn.js'
import { installedOpenClaw } from '../helpers/openclaw-session.js'

const openclaw = installedOpenClaw()
const supported = openclawVersionAtLeast(openclaw.version, '2026.9.3')
const dispatcher = openclawVersionAtLeast(openclaw.version, '2026.10.10') ? 'dispatch_action' : 'tool_call'

function secondSilentLook(calls: ReturnType<typeof countAgentChatCalls>): string {
  const gateCard = card('conv_a', 'msg_1')
  return integration.turnOutcome({ turn: { status: 'completed', agentchatCalls: calls }, turnStartedAt: 0, gateCard, freshTray: tray([gateCard]), silentBefore: 1 }).action
}

/** The run that wrote the rows (`__openclaw.runId` on assistant rows). */
function runIdOf(rows: Record<string, unknown>[]): string {
  const meta = rows.find((row) => row.role === 'assistant')?.__openclaw as { runId?: string } | undefined
  if (!meta?.runId) throw new Error('no run id on the stored rows')
  return meta.runId
}

const nestedRows = (rows: Record<string, unknown>[]) => rows.filter((row) => row.customType === 'openclaw.nested-tool.v1').map((row) => row.details as Record<string, unknown>)

describe.skipIf(!supported)(`OpenClaw ${openclaw.version} (installed) — a real agent turn`, () => {
  it(
    'a Tool Search call with a large result: its nested row is the call — counted exactly, dismissed',
    async () => {
      const { rows, offeredTools } = await runAgentTurn(
        openclaw,
        { calls: [{ name: dispatcher, arguments: { id: 'agentchat__agentchat_inbox', args: {} } }], tools: { agentchat_inbox: { outcome: 'ok', bytes: 9_000 } } },
        TRANSCRIPT_READ_LIMIT,
      )
      expect(offeredTools).toContain(dispatcher)
      expect(nestedRows(rows)).toMatchObject([{ toolName: 'agentchat__agentchat_inbox', isError: false, parentToolCallId: 'call_0' }])
      const dispatched = rows.find((row) => row.role === 'toolResult' && row.toolName === dispatcher)
      expect(dispatched).toMatchObject({ isError: false })
      const counted = countAgentChatCalls(rows, runIdOf(rows), { openclawVersion: openclaw.version })
      expect(counted).toEqual({ made: 1, failed: 0 })
      // The rows alone say enough: no version needed.
      expect(countAgentChatCalls(rows, runIdOf(rows))).toEqual({ made: 1, failed: 0 })
      expect(secondSilentLook(counted)).toBe('record_dismiss')
    },
    120_000,
  )

  it(
    'a Code Mode turn on a model that prefers it: the script’s calls are counted exactly',
    async () => {
      const { rows, offeredTools } = await runAgentTurn(
        openclaw,
        {
          codeModePreferred: true,
          calls: [{ name: 'exec', arguments: { title: 'Read the inbox', code: 'const [inbox] = await catalog.search("agentchat_inbox"); return await inbox({});' } }],
          tools: { agentchat_inbox: { outcome: 'ok', bytes: 9_000 }, agentchat_send_message: { outcome: 'ok' } },
        },
        TRANSCRIPT_READ_LIMIT,
      )
      expect(offeredTools).toEqual(expect.arrayContaining(['exec', 'wait']))
      expect(nestedRows(rows)).toMatchObject([{ toolName: 'agentchat__agentchat_inbox', isError: false, parentToolCallId: 'call_0' }])
      const counted = countAgentChatCalls(rows, runIdOf(rows), { openclawVersion: openclaw.version })
      expect(counted).toEqual({ made: 1, failed: 0 })
      expect(secondSilentLook(counted)).toBe('record_dismiss')
    },
    120_000,
  )

  it(
    'a Code Mode script whose send the server failed: the nested call is failed — not dismissed',
    async () => {
      const code = [
        'const [inbox] = await catalog.search("agentchat_inbox"); await inbox({});',
        'const [send] = await catalog.search("agentchat_send_message");',
        'try { await send({}); } catch (error) { return String(error); }',
        'return null;',
      ].join(' ')
      const { rows } = await runAgentTurn(
        openclaw,
        { codeModePreferred: true, calls: [{ name: 'exec', arguments: { title: 'Answer', code } }], tools: { agentchat_inbox: { outcome: 'ok' }, agentchat_send_message: { outcome: 'server_error' } } },
        TRANSCRIPT_READ_LIMIT,
      )
      expect(nestedRows(rows)).toMatchObject([
        { toolName: 'agentchat__agentchat_inbox', isError: false },
        { toolName: 'agentchat__agentchat_send_message', isError: true },
      ])
      const counted = countAgentChatCalls(rows, runIdOf(rows), { openclawVersion: openclaw.version })
      expect(counted).toEqual({ made: 2, failed: 1 })
      expect(secondSilentLook(counted)).toBe('record_defer')
    },
    120_000,
  )

  it(
    'a Code Mode script that reads the inbox, then throws before its send: unknown — not dismissed',
    async () => {
      const { rows } = await runAgentTurn(
        openclaw,
        {
          codeModePreferred: true,
          calls: [{ name: 'exec', arguments: { title: 'Answer', code: 'const [inbox] = await catalog.search("agentchat_inbox"); await inbox({}); await sendMessage({ to: "@bob", text: "hi" }); return null;' } }],
          tools: { agentchat_inbox: { outcome: 'ok' }, agentchat_send_message: { outcome: 'ok' } },
        },
        TRANSCRIPT_READ_LIMIT,
      )
      expect(nestedRows(rows)).toMatchObject([{ toolName: 'agentchat__agentchat_inbox', isError: false }])
      expect(rows.find((row) => row.role === 'toolResult' && row.toolName === 'exec')).toMatchObject({ isError: true, details: { status: 'failed' } })
      const counted = countAgentChatCalls(rows, runIdOf(rows), { openclawVersion: openclaw.version })
      expect(counted).toBeNull()
      expect(secondSilentLook(counted)).toBe('record_defer')
    },
    120_000,
  )

  it(
    'a Code Mode script left waiting on a slow send: unknown — not dismissed',
    async () => {
      const { rows } = await runAgentTurn(
        openclaw,
        {
          codeModePreferred: true,
          codeModeTimeoutMs: 500,
          calls: [{ name: 'exec', arguments: { title: 'Answer', code: 'const [inbox] = await catalog.search("agentchat_inbox"); await inbox({}); const [send] = await catalog.search("agentchat_send_message"); return await send({});' } }],
          tools: { agentchat_inbox: { outcome: 'ok' }, agentchat_send_message: { outcome: 'ok', delayMs: 2_500 } },
        },
        TRANSCRIPT_READ_LIMIT,
      )
      expect(nestedRows(rows)).toMatchObject([{ toolName: 'agentchat__agentchat_inbox', isError: false }])
      expect(rows.find((row) => row.role === 'toolResult' && row.toolName === 'exec')).toMatchObject({ isError: false, details: { status: 'waiting' } })
      const counted = countAgentChatCalls(rows, runIdOf(rows), { openclawVersion: openclaw.version })
      expect(counted).toBeNull()
      expect(secondSilentLook(counted)).toBe('record_defer')
    },
    120_000,
  )
})
