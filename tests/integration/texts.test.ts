import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  TextsStore,
  TEXTS_REFRESH_MS,
  TEXTS_RETRY_MS,
  cachedIdentityLine,
  fetchTexts,
  isTexts,
  loadIdentityLine,
  loadTexts,
  readCachedTexts,
  spellTextsForOpenClaw,
  textsCachePath,
} from '../../src/integration/texts.js'
import { Clock } from '../helpers/clock.js'
import { capturingLogger } from '../helpers/logger.js'
import { SERVED_TEXTS, SPELLED_TEXTS, servedTextsFor, textsClient } from '../helpers/texts.js'

describe('served texts — fetch, spell, cache', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-texts-'))
  })
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  it('isTexts requires the four texts and the manual pointer; extra fields pass through', () => {
    expect(isTexts(SERVED_TEXTS)).toBe(true)
    expect(isTexts({ ...SERVED_TEXTS, newer: 'field' })).toBe(true)
    expect(isTexts({ ...SERVED_TEXTS, wake_instruction: '' })).toBe(false)
    expect(isTexts({ version: '1' })).toBe(false)
    expect(isTexts(null)).toBe(false)
  })

  it('fetchTexts asks for runtime=openclaw and rejects an unusable answer', async () => {
    const seen: unknown[] = []
    const client = { texts: { get: async (opts: unknown) => (seen.push(opts), SERVED_TEXTS) } }
    expect(await fetchTexts(client)).toEqual(SERVED_TEXTS)
    expect(seen[0]).toMatchObject({ runtime: 'openclaw', timeoutMs: expect.any(Number) })
    await expect(fetchTexts({ texts: { get: async () => ({ version: '1' }) as never } })).rejects.toThrow(/not a texts set/)
  })

  it('spellTextsForOpenClaw re-spells the hosted tools in every text and leaves the rest', () => {
    expect(SPELLED_TEXTS.wake_instruction).toContain('agentchat__agentchat_inbox')
    expect(SPELLED_TEXTS.wake_instruction).toContain('agentchat__agentchat_send_message')
    expect(SPELLED_TEXTS.invite_prompt).toContain('agentchat__agentchat_list_group_invites')
    expect(SPELLED_TEXTS.identity_line).toContain('agentchat__agentchat_inbox first')
    expect(SPELLED_TEXTS.identity_line).toContain('api.agentchat.me')
    expect(SPELLED_TEXTS.manual).toEqual(SERVED_TEXTS.manual)
    expect(spellTextsForOpenClaw(SPELLED_TEXTS)).toEqual(SPELLED_TEXTS) // idempotent
  })

  it('loadTexts: the server copy is cached verbatim and returned spelled', async () => {
    const client = textsClient()
    const loaded = await loadTexts({ client, accountId: 'default', stateDir, now: () => 1_700_000_000_000 })
    expect(loaded?.source).toBe('server')
    expect(loaded?.texts).toEqual(SPELLED_TEXTS)
    expect(textsCachePath('default', stateDir)).toBe(path.join(stateDir, 'agentchat', 'default', 'texts.json'))
    const cached = readCachedTexts('default', stateDir)
    expect(cached?.texts).toEqual(SERVED_TEXTS) // verbatim, not spelled
    expect(cached?.fetched_at).toBe(new Date(1_700_000_000_000).toISOString())
    expect(cachedIdentityLine('default', stateDir)).toBe(SPELLED_TEXTS.identity_line)
  })

  it('loadTexts: server unreachable → the cached copy; nothing cached → null (never throws)', async () => {
    const down = textsClient({ error: new Error('ECONNREFUSED') })
    expect(await loadTexts({ client: down, accountId: 'default', stateDir })).toBeNull()
    expect(cachedIdentityLine('default', stateDir)).toBeNull()

    await loadTexts({ client: textsClient(), accountId: 'default', stateDir })
    const log = capturingLogger()
    const fromCache = await loadTexts({ client: down, accountId: 'default', stateDir, log })
    expect(fromCache?.source).toBe('cache')
    expect(fromCache?.texts).toEqual(SPELLED_TEXTS)
    expect(log.at('info').some((l) => /using the cached copy/.test(l.msg ?? ''))).toBe(true)
  })

  it('loadIdentityLine returns the spelled identity line for the key\'s agent, or null', async () => {
    expect(await loadIdentityLine({ client: textsClient({ texts: servedTextsFor('carol') }), accountId: 'c', stateDir })).toBe(
      spellTextsForOpenClaw(servedTextsFor('carol')).identity_line,
    )
    expect(await loadIdentityLine({ client: textsClient({ error: new Error('down') }), accountId: 'nobody', stateDir })).toBeNull()
  })
})

describe('TextsStore — at start, then every 24 h', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-texts-store-'))
  })
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  function make(client = textsClient()) {
    const clock = new Clock()
    const logger = capturingLogger()
    const store = new TextsStore({
      client,
      accountId: 'default',
      stateDir,
      logger,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    return { clock, logger, store, client }
  }

  it('fetches at start, serves the spelled copy, and refreshes after 24 h', async () => {
    const { clock, store, client } = make()
    const served: string[] = []
    store.onServerCopy((texts, source) => served.push(`${source}:${texts.version}`))
    expect(await store.start()).toEqual(SPELLED_TEXTS)
    expect(store.current).toEqual(SPELLED_TEXTS)
    expect(store.source).toBe('server')
    expect(client.calls).toBe(1)
    expect(served).toEqual(['server:1'])
    clock.advance(TEXTS_REFRESH_MS - 1)
    await Promise.resolve()
    expect(client.calls).toBe(1)
    clock.advance(1)
    await new Promise((r) => setImmediate(r))
    expect(client.calls).toBe(2)
    store.stop()
  })

  it('unreachable with nothing cached: starts anyway, says so once, retries every 5 min, and `ensure()` tries again', async () => {
    const client = textsClient({ error: new Error('ECONNREFUSED') })
    const { clock, logger, store } = make(client)
    expect(await store.start()).toBeNull()
    expect(store.current).toBeNull()
    const warned = logger.at('warn').filter((l) => /unreachable and nothing cached/.test(l.msg ?? ''))
    expect(warned).toHaveLength(1)

    // ensure() is one more attempt, still down.
    expect(await store.ensure()).toBeNull()
    expect(client.calls).toBe(2)

    // The timer retries on the short cadence; the server comes back.
    client.answer({ texts: SERVED_TEXTS })
    clock.advance(TEXTS_RETRY_MS)
    await new Promise((r) => setImmediate(r))
    expect(store.current).toEqual(SPELLED_TEXTS)
    expect(client.calls).toBe(3)
    // Said once, not per retry.
    expect(logger.at('warn').filter((l) => /unreachable and nothing cached/.test(l.msg ?? ''))).toHaveLength(1)
    store.stop()
  })

  it('unreachable with a cached copy: serves the cache, keeps asking the server, and never reports a server copy for it', async () => {
    await loadTexts({ client: textsClient(), accountId: 'default', stateDir })
    const client = textsClient({ error: new Error('ECONNREFUSED') })
    const { clock, logger, store } = make(client)
    const served: string[] = []
    store.onServerCopy((_t, source) => served.push(source))
    expect(await store.start()).toEqual(SPELLED_TEXTS)
    expect(store.source).toBe('cache')
    expect(served).toEqual([])
    expect(logger.at('warn')).toHaveLength(0)
    client.answer({ texts: SERVED_TEXTS })
    clock.advance(TEXTS_RETRY_MS)
    await new Promise((r) => setImmediate(r))
    expect(store.source).toBe('server')
    expect(served).toEqual(['server'])
    store.stop()
  })

  it('ensure() returns the current copy without a fetch, and stop() ends the timer', async () => {
    const { clock, store, client } = make()
    await store.start()
    expect(await store.ensure()).toEqual(SPELLED_TEXTS)
    expect(client.calls).toBe(1)
    store.stop()
    clock.advance(TEXTS_REFRESH_MS * 3)
    await new Promise((r) => setImmediate(r))
    expect(client.calls).toBe(1)
    expect(clock.pending).toHaveLength(0)
  })
})
