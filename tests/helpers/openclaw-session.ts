/**
 * Runs hosted AgentChat tool calls through the installed OpenClaw's own code
 * and returns the session messages it stores: OpenClaw's MCP materializer
 * (`materializeBundleMcpToolsForRun`), its tool adapter (`toToolDefinitions`)
 * and an agent session (`createAgentSession`, whose `afterToolCall` decides
 * the row's `isError` from 2026.9.3 on) — the pieces the embedded runner
 * composes for a turn. Only the edges are fakes: the MCP server (an
 * in-process runtime that answers, fails or throws) and the model (a stream
 * that asks for the calls, then stops). No network, no gateway.
 *
 * None of these are public plugin-sdk exports, so they are found in the
 * installed `dist` by OpenClaw's own source markers (`//#region <src path>`)
 * and the names its chunks export. A release that moves or renames one fails
 * here, loudly: the row shapes the plugin counts are then unverified.
 */

import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type HostedOutcome = 'ok' | 'server_error' | 'throws'

export interface InstalledOpenClaw {
  readonly dir: string
  readonly version: string
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export function installedOpenClaw(): InstalledOpenClaw {
  const dir = realpathSync(join(repoRoot, 'node_modules', 'openclaw'))
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }
  return { dir, version }
}

/** `a >= b` for OpenClaw's `YYYY.M.N` versions (a prerelease suffix is ignored). */
export function versionAtLeast(a: string, b: string): boolean {
  const parse = (v: string) => (v.split('-')[0] ?? '').split('.').map((part) => Number(part))
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}

class Dist {
  private readonly files: string[]
  private readonly sources = new Map<string, string>()

  constructor(private readonly dir: string) {
    this.files = readdirSync(dir).filter((file) => file.endsWith('.js') || file.endsWith('.mjs'))
  }

  /** The export `name` of the chunk that holds OpenClaw's `src` file `region`. */
  async load<T>(region: string, name: string): Promise<T> {
    const marker = `//#region ${region}\n`
    for (const file of this.files) {
      const source = this.source(file)
      if (!source.includes(marker)) continue
      const alias = exportedAs(source, name)
      if (!alias) continue
      const module = (await import(pathToFileURL(join(this.dir, file)).href)) as Record<string, unknown>
      if (module[alias] !== undefined) return module[alias] as T
    }
    throw new Error(`OpenClaw ${this.dir}: no chunk for ${region} exports ${name} — the release moved it; the transcript row shapes are unverified`)
  }

  private source(file: string): string {
    let source = this.sources.get(file)
    if (source === undefined) {
      source = readFileSync(join(this.dir, file), 'utf8')
      this.sources.set(file, source)
    }
    return source
  }
}

/** The local name a chunk's final `export { local as alias, … }` gives `name`. */
function exportedAs(source: string, name: string): string | undefined {
  const statement = [...source.matchAll(/export\s*\{([^}]*)\}\s*;?\s*$/gm)].pop()
  if (!statement?.[1]) return undefined
  for (const part of statement[1].split(',')) {
    const [local, alias] = part.trim().split(/\s+as\s+/)
    if (local === name) return alias ?? local
  }
  return undefined
}

type Message = Record<string, unknown>

interface Session {
  agent: { streamFn: unknown; prompt(message: Message): Promise<void> }
  sessionManager: { getEntries(): Array<{ type?: string; message?: Message }> }
  dispose?: () => void
}

const model = {
  id: 'fake-model',
  name: 'fake-model',
  api: 'openai-completions',
  provider: 'fake',
  baseUrl: 'http://127.0.0.1:9',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
}

function assistant(content: unknown[], stopReason: string): Message {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  return { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() }
}

/** An assistant message stream that is already complete (what agent-core reads from a provider). */
function finished(message: Message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'done', reason: message.stopReason, message }
    },
    result: async () => message,
  }
}

/**
 * One turn: the model calls each hosted tool once (in one assistant message),
 * the fake server answers each as told, the model stops. Returns every
 * message the session stored, in order.
 */
export async function runHostedCalls(openclaw: InstalledOpenClaw, calls: ReadonlyArray<{ tool: string; outcome: HostedOutcome }>): Promise<Message[]> {
  const dist = new Dist(join(openclaw.dir, 'dist'))
  const materialize = await dist.load<(params: unknown) => Promise<{ tools: Array<{ name: string }>; dispose?: () => Promise<void> }>>(
    'src/agents/agent-bundle-mcp-materialize.ts',
    'materializeBundleMcpToolsForRun',
  )
  const toToolDefinitions = await dist.load<(tools: unknown[]) => unknown[]>('src/agents/agent-tool-definition-adapter.ts', 'toToolDefinitions')
  const createAgentSession = await dist.load<(options: unknown) => Promise<{ session: Session }>>('src/agents/sessions/sdk.ts', 'createAgentSession')
  const SessionManager = await dist.load<{ inMemory(cwd: string): unknown }>('src/agents/sessions/session-manager.ts', 'SessionManager')
  const SettingsManager = await dist.load<{ inMemory(settings: unknown): unknown }>('src/agents/sessions/settings-manager.ts', 'SettingsManager')
  const ModelRegistry = await dist.load<{ inMemory(auth: unknown): unknown }>('src/agents/sessions/model-registry.ts', 'ModelRegistry')
  const AuthStorage = await dist.load<{ inMemory(): unknown }>('src/agents/sessions/auth-storage.ts', 'AuthStorage')
  const DefaultResourceLoader = await dist.load<new (options: unknown) => { reload(): Promise<void> }>('src/agents/sessions/resource-loader.ts', 'DefaultResourceLoader')

  const outcomes = new Map(calls.map((call) => [call.tool, call.outcome]))
  const catalog = {
    version: 1,
    generatedAt: 0,
    servers: { agentchat: { serverName: 'agentchat', safeServerName: 'agentchat', launchSummary: 'agentchat', toolCount: calls.length, supportsParallelToolCalls: false } },
    tools: calls.map(({ tool }) => ({ serverName: 'agentchat', safeServerName: 'agentchat', toolName: tool, title: tool, description: tool, fallbackDescription: tool, inputSchema: { type: 'object', properties: {} } })),
  }
  const server = {
    sessionId: 'agentchat-transcript-test',
    workspaceDir: tmpdir(),
    configFingerprint: 'test',
    markUsed() {},
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    callTool: async (_server: string, tool: string) => {
      switch (outcomes.get(tool)) {
        case 'ok':
          return { content: [{ type: 'text', text: '{"conversations":[]}' }] }
        case 'server_error':
          return { content: [{ type: 'text', text: 'AWAITING_REPLY' }], isError: true }
        default:
          throw new Error('MCP error -32001: Request timed out')
      }
    },
  }

  const dir = mkdtempSync(join(tmpdir(), 'agentchat-openclaw-session-'))
  const materialized = await materialize({ runtime: server })
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), extensionFactories: [] })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model,
    // Only the hosted tools: `noTools` on 2026.6.10, `tools` (the allowed names) on both.
    noTools: 'builtin',
    tools: materialized.tools.map((tool) => tool.name),
    customTools: toToolDefinitions(materialized.tools),
    resourceLoader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
  })
  let turn = 0
  session.agent.streamFn = () => {
    turn += 1
    if (turn === 1) {
      return finished(assistant(calls.map(({ tool }, index) => ({ type: 'toolCall', id: `call_${index}`, name: `agentchat__${tool}`, arguments: {} })), 'toolUse'))
    }
    return finished(assistant([{ type: 'text', text: 'done' }], 'stop'))
  }
  try {
    await session.agent.prompt({ role: 'user', content: 'You have AgentChat messages.', timestamp: Date.now() })
    return session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === 'message' && entry.message)
      .map((entry) => entry.message as Message)
  } finally {
    session.dispose?.()
    await materialized.dispose?.()
    rmSync(dir, { recursive: true, force: true })
  }
}
