// Reads one stored session back the way the gateway's `sessions.get` does
// (`readRecentSessionMessagesWithStatsAsync`, src/gateway/session-transcript-readers.ts),
// from the installed OpenClaw's dist. Run as its own process, with the turn's
// HOME / OPENCLAW_STATE_DIR. Prints the messages as one JSON array.
//
//   node openclaw-read-session.mjs <openclaw dist> <session key> <session id> <store path> <limit>

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [dist, sessionKey, sessionId, storePath, limit] = process.argv.slice(2)

function exportedAs(source, name) {
  const statement = [...source.matchAll(/export\s*\{([^}]*)\}\s*;?\s*$/gm)].pop()
  for (const part of (statement?.[1] ?? '').split(',')) {
    const [local, alias] = part.trim().split(/\s+as\s+/)
    if (local === name) return alias ?? local
  }
  return undefined
}

async function load(region, name) {
  for (const file of readdirSync(dist).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
    const source = readFileSync(join(dist, file), 'utf8')
    if (!source.includes(`//#region ${region}\n`)) continue
    const alias = exportedAs(source, name)
    if (!alias) continue
    const module = await import(pathToFileURL(join(dist, file)).href)
    if (module[alias] !== undefined) return module[alias]
  }
  throw new Error(`OpenClaw ${dist}: no chunk for ${region} exports ${name}`)
}

// The reader runs on the gateway's runtime config; this process has none, so it is given the file's.
const setRuntimeConfigSnapshot = await load('src/config/runtime-snapshot.ts', 'setRuntimeConfigSnapshot')
const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'))
setRuntimeConfigSnapshot(config, config)
const read = await load('src/gateway/session-transcript-readers.ts', 'readRecentSessionMessagesWithStatsAsync')
const max = Number(limit)
const { messages } = await read(
  { agentId: 'main', sessionEntry: { sessionId }, sessionId, sessionKey, storePath },
  // The limits `sessions.get` applies (src/gateway/server-methods/sessions-read.ts).
  { maxMessages: max, maxLines: max * 20 + 20, allowResetArchiveFallback: true },
)
process.stdout.write(JSON.stringify(messages))
process.exit(0)
