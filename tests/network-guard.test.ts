import * as http from 'node:http'
import * as net from 'node:net'
import { AgentChatClient, RealtimeClient } from 'agentchatme'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import { connectHost, isLoopbackHost, NetworkBlockedError, takeBlockedAttempts } from './setup/network-guard.js'
import { testKey } from './helpers/keys.js'

// The `ws` package the plugin depends on (no type declarations installed).
const WebSocket = createRequire(import.meta.url)('ws') as typeof globalThis.WebSocket

// The guard itself (tests/setup/network-guard.ts): every test file runs
// under it, so a test that forgets to stub the network fails instead of
// talking to a real server. Each case drains what it provoked, so its own
// afterEach check passes.

describe('network guard', () => {
  it('refuses fetch to a non-loopback host (string, URL and Request forms), and records the attempt', async () => {
    await expect(fetch('https://api.agentchat.me/v1/inbox')).rejects.toBeInstanceOf(NetworkBlockedError)
    await expect(fetch(new URL('https://api.agentchat.me/v1/texts'))).rejects.toBeInstanceOf(NetworkBlockedError)
    await expect(fetch(new Request('https://example.com/'))).rejects.toBeInstanceOf(NetworkBlockedError)
    expect(takeBlockedAttempts()).toEqual(['https://api.agentchat.me/v1/inbox', 'https://api.agentchat.me/v1/texts', 'https://example.com/'])
  })

  it('refuses an SDK client built without its own fetch (it captures the guarded global)', async () => {
    const client = new AgentChatClient({ apiKey: testKey('0123456789abcdef0123456789'), retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } })
    await expect(client.getMe()).rejects.toThrow(/network-guard/)
    expect(takeBlockedAttempts()).toEqual(['https://api.agentchat.me/v1/agents/me'])
  })

  it('refuses the SDK’s static registration calls too (they use the runtime fetch)', async () => {
    await expect(AgentChatClient.register({ email: 'a@example.invalid', handle: 'alice' })).rejects.toThrow(/network-guard/)
    expect(takeBlockedAttempts()).toEqual(['https://api.agentchat.me/v1/register'])
  })

  it('refuses a raw socket to a non-loopback host, in every argument form', () => {
    expect(() => net.connect({ host: 'example.com', port: 443 })).toThrow(NetworkBlockedError)
    expect(() => net.connect(443, 'example.com')).toThrow(NetworkBlockedError)
    expect(() => new net.Socket().connect({ host: '8.8.8.8', port: 53 })).toThrow(NetworkBlockedError)
    expect(takeBlockedAttempts()).toEqual(['socket example.com', 'socket example.com', 'socket 8.8.8.8'])
  })

  it('refuses the SDK socket over the `ws` package (the plugin’s production WebSocket)', async () => {
    const rt = new RealtimeClient({ apiKey: testKey('w'.repeat(24)), baseUrl: 'wss://api.agentchat.me', webSocket: WebSocket, reconnect: false })
    try {
      await rt.connect().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      rt.disconnect()
    }
    expect(takeBlockedAttempts().some((a) => a === 'socket api.agentchat.me')).toBe(true)
  })

  it('leaves loopback open: a local server answers fetch', async () => {
    const server = http.createServer((_req, res) => res.end('ok'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as net.AddressInfo
      const res = await fetch(`http://127.0.0.1:${port}/`)
      expect(await res.text()).toBe('ok')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    expect(takeBlockedAttempts()).toEqual([])
  })

  it('classifies loopback hosts and socket targets', () => {
    for (const host of ['localhost', 'api.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
    for (const host of ['api.agentchat.me', 'api.agentchat.test', '10.0.0.1', '::ffff:8.8.8.8', 'example.com']) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
    expect(connectHost(['/tmp/x.sock'])).toBeNull()
    expect(connectHost([{ path: '/tmp/x.sock' }])).toBeNull()
    expect(connectHost([443, 'example.com'])).toBe('example.com')
    expect(connectHost([443])).toBe('localhost')
    expect(connectHost([[{ host: 'example.com', port: 443 }, () => undefined]])).toBe('example.com')
  })
})
