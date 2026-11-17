/**
 * `setup-client.ts`: the plugin's identity and API base bound to the SDK's
 * `integration.account` helper. The helper's own behaviour (the flow, the
 * waits, the legacy reading) is the SDK's and tested there; these tests pin
 * what this plugin adds: who it says it is, which host it reaches, and that
 * the key check returns the server's verdict as is.
 */

import { describe, it, expect, vi } from 'vitest'

import { accountCallOptions, checkApiKey } from '../src/setup-client.js'
import { PACKAGE_VERSION } from '../src/version.js'
import { testKey } from './helpers/keys.js'

const KEY = testKey('x'.repeat(40))

function server(answer: Response | Error) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
    if (answer instanceof Error) throw answer
    return answer
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('accountCallOptions', () => {
  it('announces the plugin and defaults to the production API', () => {
    const options = accountCallOptions()
    expect(options.clientIdentity).toEqual({ name: 'openclaw', version: PACKAGE_VERSION })
    expect(options.apiBase).toBe('https://api.agentchat.me')
    expect(options.fetch).toBeUndefined()
  })

  it('uses the account’s API base without a trailing slash', () => {
    expect(accountCallOptions({ apiBase: 'https://stage.agentchat.test//' }).apiBase).toBe('https://stage.agentchat.test')
  })
})

describe('checkApiKey', () => {
  it('asks GET /v1/agents/me with the key, as the plugin, and returns the handle the key belongs to', async () => {
    const s = server(json(200, { handle: 'alice', email_masked: 'a****@example.com' }))
    const check = await checkApiKey(KEY, { apiBase: 'https://api.agentchat.test/', fetch: s.fetch })
    expect(check).toEqual({ ok: true, handle: 'alice' })
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]!.method).toBe('GET')
    expect(s.calls[0]!.url).toBe('https://api.agentchat.test/v1/agents/me')
    expect(s.calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(s.calls[0]!.headers.get('x-agentchat-client')).toBe('openclaw')
    expect(s.calls[0]!.headers.get('x-agentchat-client-version')).toBe(PACKAGE_VERSION)
  })

  it('returns the server’s answer to a key it turns away, once, without a retry', async () => {
    const s = server(json(401, { code: 'UNAUTHORIZED', message: 'Invalid API key' }))
    await expect(checkApiKey(KEY, { apiBase: 'https://api.agentchat.test', fetch: s.fetch })).resolves.toEqual({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Invalid API key',
    })
    expect(s.calls).toHaveLength(1)
  })

  it('a suspended account is a verdict too, never a saved key', async () => {
    const s = server(json(403, { code: 'SUSPENDED', message: 'Your account is suspended.' }))
    await expect(checkApiKey(KEY, { apiBase: 'https://api.agentchat.test', fetch: s.fetch })).resolves.toMatchObject({ ok: false, code: 'SUSPENDED' })
  })

  it('rejects when no answer came: nothing is known about the key', async () => {
    const s = server(new TypeError('fetch failed'))
    await expect(checkApiKey(KEY, { apiBase: 'https://api.agentchat.test', fetch: s.fetch })).rejects.toThrow(/fetch failed/)
  })
})
