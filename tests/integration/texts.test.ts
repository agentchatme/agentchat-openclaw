/**
 * The served texts on the kit's TextsCache: the file under the plugin's
 * state dir, the texts used exactly as served (the server spells the hosted
 * tools for runtime=openclaw), the identity line for the placement paths
 * outside the gateway, and the cached line for status without the network.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  TEXTS_RUNTIME,
  cachedIdentityLine,
  createTextsCache,
  isTexts,
  loadIdentityLine,
  textsCachePath,
} from '../../src/integration/texts.js'
import { SERVED_TEXTS, textsClient } from '../helpers/texts.js'

const dirs: string[] = []
function stateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-texts-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the texts shape', () => {
  it('isTexts is the kit’s check', () => {
    expect(isTexts(SERVED_TEXTS)).toBe(true)
    expect(isTexts({ version: '1' })).toBe(false)
  })
})

describe('the kit cache in the plugin state dir', () => {
  it('fetches runtime=openclaw, keeps the server copy verbatim in <state>/agentchat/<account>/texts.json, and hands it out as served', async () => {
    const dir = stateDir()
    const client = textsClient()
    const asked: unknown[] = []
    const get = client.texts.get
    client.texts.get = async (opts: Parameters<typeof get>[0]) => {
      asked.push(opts)
      return get(opts)
    }
    const cache = createTextsCache({ client, accountId: 'default', stateDir: dir })
    const texts = cache
    expect(texts.current()).toBeNull()
    await cache.start()
    cache.stop()
    expect((asked[0] as { runtime: string }).runtime).toBe(TEXTS_RUNTIME)
    expect(texts.current()).toEqual(SERVED_TEXTS)
    expect(texts.source).toBe('server')
    expect(await texts.ensure()).toEqual(SERVED_TEXTS)

    const file = textsCachePath('default', dir)
    expect(file).toBe(path.join(dir, 'agentchat', 'default', 'texts.json'))
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { runtime: string; texts: unknown }
    expect(stored.runtime).toBe('openclaw')
    expect(stored.texts).toEqual(SERVED_TEXTS) // verbatim
  })

  it('offline start: the file copy is used; with neither, nothing', async () => {
    const dir = stateDir()
    const warm = createTextsCache({ client: textsClient(), accountId: 'default', stateDir: dir })
    await warm.start()
    warm.stop()

    const offline = createTextsCache({ client: textsClient({ error: new Error('ECONNREFUSED') }), accountId: 'default', stateDir: dir })
    const texts = offline
    await offline.start()
    offline.stop()
    expect(texts.current()).toEqual(SERVED_TEXTS)
    expect(texts.source).toBe('cache')

    const cold = createTextsCache({ client: textsClient({ error: new Error('ECONNREFUSED') }), accountId: 'other', stateDir: dir })
    const none = cold
    await cold.start()
    cold.stop()
    expect(none.current()).toBeNull()
    expect(none.lastError).toMatch(/ECONNREFUSED/)
  })
})

describe('the identity line outside the gateway', () => {
  it('loadIdentityLine: the server copy; offline the file copy; neither → null', async () => {
    const dir = stateDir()
    expect(await loadIdentityLine({ client: textsClient(), accountId: 'default', stateDir: dir })).toBe(SERVED_TEXTS.identity_line)
    expect(await loadIdentityLine({ client: textsClient({ error: new Error('down') }), accountId: 'default', stateDir: dir })).toBe(SERVED_TEXTS.identity_line)
    expect(await loadIdentityLine({ client: textsClient({ error: new Error('down') }), accountId: 'nobody', stateDir: dir })).toBeNull()
  })

  it('cachedIdentityLine reads the kit file without the network; anything else is null', async () => {
    const dir = stateDir()
    expect(cachedIdentityLine('default', dir)).toBeNull()
    const cache = createTextsCache({ client: textsClient(), accountId: 'default', stateDir: dir })
    await cache.start()
    cache.stop()
    expect(cachedIdentityLine('default', dir)).toBe(SERVED_TEXTS.identity_line)
    fs.writeFileSync(textsCachePath('default', dir), '{"runtime":"hermes","texts":{}}')
    expect(cachedIdentityLine('default', dir)).toBeNull()
    fs.writeFileSync(textsCachePath('default', dir), 'not json')
    expect(cachedIdentityLine('default', dir)).toBeNull()
  })
})
