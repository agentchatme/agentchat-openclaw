/**
 * `ws` must resolve from the plugin's own dependency tree.
 *
 * The SDK's realtime client prefers the `ws` package on Node: it shows the
 * server's ping frames, which the 100 s idle watchdog counts, so a half-open
 * pipe is caught within two missed pings. Node's native `WebSocket` cannot
 * see pings, and the SDK falls back to it silently when `ws` is not
 * resolvable — idle detection would be off and nobody would know. The
 * resolver does `import('ws')` from the SDK's own location, so the package
 * has to be reachable from where the plugin is installed, not borrowed from
 * whatever the host happens to hoist.
 */

import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const pluginRequire = createRequire(path.join(pluginRoot, 'src', 'index.ts'))

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** `>=a.b.c` (the SDK's peer range shape) → [a, b, c]. */
function floorOf(range: string): [number, number, number] {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(range)
  if (!match) throw new Error(`unexpected peer range for ws: ${range}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function atLeast(version: string, floor: [number, number, number]): boolean {
  const parts = version.split('.').map(Number) as [number, number, number]
  for (let i = 0; i < 3; i++) {
    if (parts[i]! > floor[i]!) return true
    if (parts[i]! < floor[i]!) return false
  }
  return true
}

describe('ws — the SDK realtime client resolves it from the plugin', () => {
  it('is a regular dependency, resolves from the plugin tree, is ping-capable, and satisfies the SDK peer range', async () => {
    const pkg = readJson(path.join(pluginRoot, 'package.json'))
    const deps = pkg.dependencies as Record<string, string>
    expect(deps.ws).toMatch(/^\^8\./)

    const resolved = pluginRequire.resolve('ws')
    expect(resolved.startsWith(path.join(pluginRoot, 'node_modules') + path.sep)).toBe(true)

    // The constructor the SDK will get, with the EventEmitter surface its liveness watchdog keys on (`on('ping')`).
    const mod = (await import(pathToFileURL(resolved).href)) as { default?: unknown; WebSocket?: unknown }
    const ctor = (mod.default ?? mod.WebSocket) as { prototype?: Record<string, unknown> } | undefined
    expect(typeof ctor).toBe('function')
    expect(typeof ctor?.prototype?.on).toBe('function')
    expect(typeof ctor?.prototype?.terminate).toBe('function')

    const wsPkg = readJson(pluginRequire.resolve('ws/package.json'))
    const sdkPkg = readJson(pluginRequire.resolve('agentchatme/package.json'))
    const peer = (sdkPkg.peerDependencies as Record<string, string | undefined>).ws
    if (peer === undefined) throw new Error('agentchatme no longer declares ws as a peer dependency — re-check how its resolver finds ws')
    expect(atLeast(wsPkg.version as string, floorOf(peer))).toBe(true)
  })
})
