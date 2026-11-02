/**
 * Live smoke tests against a deployed AgentChat API — the doorbell legs.
 *
 * What this exercises end-to-end (server, socket, main line; no OpenClaw):
 *   - `validateApiKey` against `GET /v1/agents/me` for two fixture agents.
 *   - `registerAgentStart` HANDLE_TAKEN path (the seeded handles are bound).
 *   - Bob's `AgentchatChannelRuntime` reaches READY, negotiates `ack`, and
 *     knocks on connect.
 *   - Alice DMs bob over REST (`POST /v1/messages`, plain fetch — the
 *     doorbell has no send path of its own); bob's socket delivers a
 *     `message.new` that becomes a message knock; nothing is acknowledged.
 *   - `GET /v1/inbox` for bob shows the tray with a card for that
 *     conversation and the gate question; a `dismiss` verdict with
 *     `through_message_id` is accepted (201).
 *
 * How it stays out of CI's way: gated on `TEST_ALICE_API_KEY` and
 * `TEST_BOB_API_KEY` from `.env.test-agents` at the repo root (or the
 * environment). Absent the fixture, the suite is skipped — `pnpm test` in a
 * fresh clone stays green. Override the host with `AGENTCHAT_SMOKE_API_BASE`.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { AgentchatChannelRuntime } from '../src/runtime.js'
import { parseChannelConfig } from '../src/config-schema.js'
import { validateApiKey, registerAgentStart } from '../src/setup-client.js'
import { MainLineClient } from '../src/doorbell/main-line.js'
import { cardsOf } from '../src/doorbell/gate.js'

function loadFixtureEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const candidate of [resolve(__dirname, '..', '.env.test-agents'), resolve(__dirname, '..', '..', '..', '.env.test-agents')]) {
    if (!existsSync(candidate)) continue
    for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
    break
  }
  return out
}

const fixture = loadFixtureEnv()
const ALICE_KEY = process.env.TEST_ALICE_API_KEY ?? fixture.TEST_ALICE_API_KEY
const BOB_KEY = process.env.TEST_BOB_API_KEY ?? fixture.TEST_BOB_API_KEY
const ALICE_HANDLE = process.env.TEST_ALICE_HANDLE ?? fixture.TEST_ALICE_HANDLE ?? 'alice'
const BOB_HANDLE = process.env.TEST_BOB_HANDLE ?? fixture.TEST_BOB_HANDLE ?? 'bob'
const API_BASE = process.env.AGENTCHAT_SMOKE_API_BASE ?? process.env.API_BASE ?? fixture.API_BASE ?? 'https://api.agentchat.me'

const enabled = Boolean(ALICE_KEY && BOB_KEY)
const live = enabled ? describe : describe.skip

live('live smoke — doorbell legs against the real API', () => {
  const runtimes: AgentchatChannelRuntime[] = []
  afterAll(async () => {
    await Promise.all(runtimes.map((r) => r.stop(Date.now() + 5_000)))
  })

  it('validateApiKey authenticates both fixture agents', async () => {
    const a = await validateApiKey(ALICE_KEY!, { apiBase: API_BASE })
    const b = await validateApiKey(BOB_KEY!, { apiBase: API_BASE })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (a.ok) expect(a.agent.handle).toBe(ALICE_HANDLE)
    if (b.ok) expect(b.agent.handle).toBe(BOB_HANDLE)
  }, 30_000)

  it('registerAgentStart reports handle-taken for a seeded handle', async () => {
    const r = await registerAgentStart({ email: `smoke-${randomBytes(4).toString('hex')}@example.invalid`, handle: ALICE_HANDLE }, { apiBase: API_BASE })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(['handle-taken', 'rate-limited', 'email-limit-reached', 'email-exhausted']).toContain(r.reason)
  }, 30_000)

  it('bob reaches READY with ack negotiated, knocks on connect and on a DM, and the tray shows the card', async () => {
    const knocks: string[] = []
    let authenticated: (() => void) | null = null
    let knocked: (() => void) | null = null
    const bob = new AgentchatChannelRuntime({
      config: parseChannelConfig({ apiKey: BOB_KEY, apiBase: API_BASE, agentHandle: BOB_HANDLE, observability: { logLevel: 'error' } }),
      handlers: {
        onAuthenticated: () => authenticated?.(),
        onKnock: (source) => {
          knocks.push(source)
          if (source === 'message') knocked?.()
        },
      },
    })
    runtimes.push(bob)
    const ready = new Promise<void>((res) => (authenticated = res))
    bob.start()
    await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('READY timeout')), 25_000))])
    expect(bob.getHealth().state.kind).toBe('READY')
    expect(bob.getHealth().ackNegotiated).toBe(true)
    expect(knocks).toContain('connect')

    const probe = `doorbell smoke ${randomBytes(6).toString('hex')}`
    const knock = new Promise<void>((res) => (knocked = res))
    const sent = await fetch(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ALICE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: BOB_HANDLE, client_msg_id: randomBytes(8).toString('hex'), content: { text: probe } }),
    })
    expect(sent.status).toBeLessThan(300)
    const message = (await sent.json()) as { id: string; conversation_id: string }
    await Promise.race([knock, new Promise((_, rej) => setTimeout(() => rej(new Error('knock timeout')), 25_000))])
    expect(knocks).toContain('message')

    const mainLine = new MainLineClient({ apiKey: BOB_KEY!, apiBase: API_BASE })
    const tray = await mainLine.inbox({ waitMs: 0 })
    expect(typeof tray.question).toBe('string')
    const card = cardsOf(tray).find((c) => c.conversation_id === message.conversation_id)
    expect(card).toBeDefined()
    const preview = card?.preview as { message_id?: string } | undefined
    const recorded = await mainLine.recordDecision(message.conversation_id, { decision: 'dismiss', throughMessageId: preview?.message_id ?? message.id })
    expect(recorded).toBeTypeOf('object')
  }, 90_000)
})
