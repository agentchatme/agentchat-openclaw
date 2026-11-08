/**
 * The served texts on the kit's TextsCache: the file under the plugin's
 * state dir, the OpenClaw spelling applied on the way out (never to the
 * stored copy), the identity line for the placement paths outside the
 * gateway, and the cached line for status without the network.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  OpenClawTexts,
  TEXTS_RUNTIME,
  cachedIdentityLine,
  createTextsCache,
  isTexts,
  loadIdentityLine,
  spellTextsForOpenClaw,
  textsCachePath,
} from '../../src/integration/texts.js'
import { SERVED_TEXTS, SPELLED_TEXTS, textsClient } from '../helpers/texts.js'

const dirs: string[] = []
function stateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-texts-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('spelling for OpenClaw', () => {
  it('re-spells the hosted tool names in every agent-facing text, the gate-call ones included; nothing else changes', () => {
    const spelled = spellTextsForOpenClaw(SERVED_TEXTS)
    expect(spelled.wake_instruction).toContain('agentchat__agentchat_inbox')
    expect(spelled.wake_instruction).not.toMatch(/(?<!_)agentchat_inbox/)
    expect(spelled.gate_call_preamble).toContain('agentchat__agentchat_decide')
    expect(spelled.invite_prompt).toContain('agentchat__agentchat_list_group_invites')
    expect(spelled.manual).toEqual(SERVED_TEXTS.manual)
    expect(spellTextsForOpenClaw(spelled)).toEqual(spelled) // idempotent
  })

  it('texts without the gate-call fields stay without them', () => {
    const { gate_call_preamble: _p, gate_call_answer_format: _f, ...old } = SERVED_TEXTS
    const spelled = spellTextsForOpenClaw(old)
    expect('gate_call_preamble' in spelled).toBe(false)
    expect('gate_call_answer_format' in spelled).toBe(false)
  })

  it('isTexts is the kit’s check', () => {
    expect(isTexts(SERVED_TEXTS)).toBe(true)
    expect(isTexts({ version: '1' })).toBe(false)
  })
})

describe('the kit cache in the plugin state dir', () => {
  it('fetches runtime=openclaw, keeps the server copy verbatim in <state>/agentchat/<account>/texts.json, hands it out spelled', async () => {
    const dir = stateDir()
    const client = textsClient()
    const asked: unknown[] = []
    const get = client.texts.get
    client.texts.get = async (opts: Parameters<typeof get>[0]) => {
      asked.push(opts)
      return get(opts)
    }
    const cache = createTextsCache({ client, accountId: 'default', stateDir: dir })
    const texts = new OpenClawTexts(cache)
    expect(texts.current()).toBeNull()
    await cache.start()
    cache.stop()
    expect((asked[0] as { runtime: string }).runtime).toBe(TEXTS_RUNTIME)
    expect(texts.current()).toEqual(SPELLED_TEXTS)
    expect(texts.source).toBe('server')
    // Same object until the served copy changes: no re-spelling per cycle.
    expect(texts.current()).toBe(texts.current())
    expect(await texts.ensure()).toEqual(SPELLED_TEXTS)

    const file = textsCachePath('default', dir)
    expect(file).toBe(path.join(dir, 'agentchat', 'default', 'texts.json'))
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { runtime: string; texts: unknown }
    expect(stored.runtime).toBe('openclaw')
    expect(stored.texts).toEqual(SERVED_TEXTS) // verbatim, not spelled
  })

  it('offline start: the file copy is used; with neither, nothing', async () => {
    const dir = stateDir()
    const warm = createTextsCache({ client: textsClient(), accountId: 'default', stateDir: dir })
    await warm.start()
    warm.stop()

    const offline = createTextsCache({ client: textsClient({ error: new Error('ECONNREFUSED') }), accountId: 'default', stateDir: dir })
    const texts = new OpenClawTexts(offline)
    await offline.start()
    offline.stop()
    expect(texts.current()).toEqual(SPELLED_TEXTS)
    expect(texts.source).toBe('cache')

    const cold = createTextsCache({ client: textsClient({ error: new Error('ECONNREFUSED') }), accountId: 'other', stateDir: dir })
    const none = new OpenClawTexts(cold)
    await cold.start()
    cold.stop()
    expect(none.current()).toBeNull()
    expect(none.lastError).toMatch(/ECONNREFUSED/)
  })
})

describe('the identity line outside the gateway', () => {
  it('loadIdentityLine: the server copy spelled; offline the file copy; neither → null', async () => {
    const dir = stateDir()
    expect(await loadIdentityLine({ client: textsClient(), accountId: 'default', stateDir: dir })).toBe(SPELLED_TEXTS.identity_line)
    expect(await loadIdentityLine({ client: textsClient({ error: new Error('down') }), accountId: 'default', stateDir: dir })).toBe(SPELLED_TEXTS.identity_line)
    expect(await loadIdentityLine({ client: textsClient({ error: new Error('down') }), accountId: 'nobody', stateDir: dir })).toBeNull()
  })

  it('cachedIdentityLine reads the kit file without the network; anything else is null', async () => {
    const dir = stateDir()
    expect(cachedIdentityLine('default', dir)).toBeNull()
    const cache = createTextsCache({ client: textsClient(), accountId: 'default', stateDir: dir })
    await cache.start()
    cache.stop()
    expect(cachedIdentityLine('default', dir)).toBe(SPELLED_TEXTS.identity_line)
    fs.writeFileSync(textsCachePath('default', dir), '{"runtime":"hermes","texts":{}}')
    expect(cachedIdentityLine('default', dir)).toBeNull()
    fs.writeFileSync(textsCachePath('default', dir), 'not json')
    expect(cachedIdentityLine('default', dir)).toBeNull()
  })
})
