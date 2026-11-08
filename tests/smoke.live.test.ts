/**
 * Live smoke tests against a deployed AgentChat API — the integration's legs.
 *
 * What this exercises end-to-end (server, the SDK socket, the main line; no
 * OpenClaw):
 *   - `validateApiKey` against `GET /v1/agents/me` for two fixture agents.
 *   - `registerAgentStart` HANDLE_TAKEN path (the seeded handles are bound).
 *   - Bob's `IntegrationSocket` connects and wakes on connect.
 *   - Alice DMs bob over REST (`POST /v1/messages`, plain fetch — the
 *     integration has no send path of its own); bob's socket delivers a
 *     `message.new` that becomes a message wake and is acknowledged on
 *     receipt by the SDK.
 *   - `client.inbox.tray()` for bob shows the card for that conversation and
 *     the gate question; a `dismiss` verdict with the card's anchor is
 *     accepted; `client.texts.get({ runtime: 'openclaw' })` serves the texts.
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
import { gate } from 'agentchatme'

import { IntegrationSocket } from '../src/integration/socket.js'
import { createSdkClient } from '../src/binding/sdk-client.js'
import { parseChannelConfig } from '../src/config-schema.js'
import { validateApiKey, registerAgentStart } from '../src/setup-client.js'
import { TEXTS_RUNTIME } from '../src/integration/texts.js'
import { silentLogger } from './helpers/logger.js'

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

live('live smoke — integration legs against the real API', () => {
  const sockets: IntegrationSocket[] = []
  afterAll(() => {
    for (const s of sockets) {
      s.realtime.disconnect()
      s.stopped()
    }
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

  it('the served texts for openclaw carry the wake instruction, the invite prompt and the identity line', async () => {
    const client = createSdkClient({ apiKey: BOB_KEY!, apiBase: API_BASE })
    const texts = await client.texts.get({ runtime: TEXTS_RUNTIME })
    expect(texts.wake_instruction.length).toBeGreaterThan(50)
    expect(texts.invite_prompt.length).toBeGreaterThan(20)
    expect(texts.identity_line).toContain(`@${BOB_HANDLE}`)
  }, 30_000)

  it('bob connects (HELLO with ack, heartbeat, rewake), a DM arrives on the socket, and the tray shows the card', async () => {
    const wakes: string[] = []
    let connected: (() => void) | null = null
    let woken: (() => void) | null = null
    const client = createSdkClient({ apiKey: BOB_KEY!, apiBase: API_BASE })
    const bob = new IntegrationSocket({
      config: parseChannelConfig({ apiKey: BOB_KEY, apiBase: API_BASE, agentHandle: BOB_HANDLE, observability: { logLevel: 'error' } }),
      logger: silentLogger,
      client,
      handlers: {
        onConnected: () => {
          wakes.push('connect')
          connected?.()
        },
      },
    })
    sockets.push(bob)
    // The receive loop's own handler, standing in: a message frame is a wake.
    bob.realtime.on('message.new', () => {
      wakes.push('message')
      woken?.()
    })
    const ready = new Promise<void>((res) => (connected = res))
    bob.bind()
    await bob.realtime.connect()
    await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 25_000))])
    expect(bob.getHealth().state).toBe('ready')
    expect(wakes).toContain('connect')

    const probe = `integration smoke ${randomBytes(6).toString('hex')}`
    const wake = new Promise<void>((res) => (woken = res))
    const sent = await fetch(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ALICE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: BOB_HANDLE, client_msg_id: randomBytes(8).toString('hex'), content: { text: probe } }),
    })
    expect(sent.status).toBeLessThan(300)
    const message = (await sent.json()) as { id: string; conversation_id: string }
    await Promise.race([wake, new Promise((_, rej) => setTimeout(() => rej(new Error('wake timeout')), 25_000))])
    expect(wakes).toContain('message')

    const tray = await client.inbox.tray({ waitMs: 0 })
    expect(typeof tray.question).toBe('string')
    const card = gate.cardsOf(tray).find((c) => c.conversation_id === message.conversation_id)
    expect(card).toBeDefined()
    const recorded = await client.decisions.record(message.conversation_id, { decision: 'dismiss', throughMessageId: card?.preview?.message_id ?? message.id })
    expect(recorded.decision).toBe('dismiss')
  }, 90_000)
})
