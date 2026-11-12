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

export interface HostedCallsOptions {
  /**
   * Call through Tool Search: the hosted tools go into its catalog and the
   * model calls the dispatcher (`tool_call`, `dispatch_action` from 2026.10.10)
   * — set up as the embedded runner does (`applyToolSearchCatalog`, and
   * `createToolSearchTools` where the release exports it).
   */
  readonly toolSearch?: boolean
  /** Store through OpenClaw's tool-result persistence guard (`guardSessionManager`), which caps stored details at 8 KiB. */
  readonly guard?: boolean
  /** Padding on each successful or failed server answer. */
  readonly textBytes?: number
}

/**
 * One turn: the model calls each hosted tool once (in one assistant message),
 * the fake server answers each as told, the model stops. Returns every
 * message the session stored, in order.
 */
export async function runHostedCalls(openclaw: InstalledOpenClaw, calls: ReadonlyArray<{ tool: string; outcome: HostedOutcome }>, options: HostedCallsOptions = {}): Promise<Message[]> {
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
          return { content: [{ type: 'text', text: `{"conversations":[]}${' '.repeat(options.textBytes ?? 0)}` }] }
        case 'server_error':
          return { content: [{ type: 'text', text: `AWAITING_REPLY${' '.repeat(options.textBytes ?? 0)}` }], isError: true }
        default:
          throw new Error('MCP error -32001: Request timed out')
      }
    },
  }

  const dir = mkdtempSync(join(tmpdir(), 'agentchat-openclaw-session-'))
  const materialized = await materialize({ runtime: server })
  const dispatcher = versionAtLeast(openclaw.version, '2026.10.10') ? 'dispatch_action' : 'tool_call'
  let tools: Array<{ name: string }> = materialized.tools
  if (options.toolSearch) tools = await withToolSearch(dist, openclaw, tools)
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), extensionFactories: [] })
  await resourceLoader.reload()
  let sessionManager = SessionManager.inMemory(dir)
  if (options.guard) {
    const guardSessionManager = await dist.load<(manager: unknown, options: unknown) => unknown>('src/agents/session-tool-result-guard-wrapper.ts', 'guardSessionManager')
    sessionManager = guardSessionManager(sessionManager, { runId: RUN_ID, sessionKey: 'agent:main:subagent:agentchat-wake-transcript-test', agentId: 'main' })
  }
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model,
    // Only the hosted tools: `noTools` on 2026.6.10, `tools` (the allowed names) on both.
    noTools: 'builtin',
    tools: tools.map((tool) => tool.name),
    customTools: toToolDefinitions(tools),
    resourceLoader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
  })
  let turn = 0
  session.agent.streamFn = () => {
    turn += 1
    if (turn === 1) {
      return finished(
        assistant(
          calls.map(({ tool }, index) =>
            options.toolSearch
              ? { type: 'toolCall', id: `call_${index}`, name: dispatcher, arguments: { id: `agentchat__${tool}`, args: {} } }
              : { type: 'toolCall', id: `call_${index}`, name: `agentchat__${tool}`, arguments: {} },
          ),
          'toolUse',
        ),
      )
    }
    return finished(assistant([{ type: 'text', text: 'done' }], 'stop'))
  }
  try {
    await session.agent.prompt({ role: 'user', content: 'You have AgentChat messages.', timestamp: Date.now() })
    await (sessionManager as { flushPendingToolResultsAsync?: () => Promise<void> }).flushPendingToolResultsAsync?.()
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

/** The run id the guard is given (it tags the rows it stores from 2026.8 on). */
export const RUN_ID = 'run_transcript_test'

/** The hosted tools behind Tool Search, as `src/agents/tool-search.ts` sets it up on the installed release. */
async function withToolSearch(dist: Dist, openclaw: InstalledOpenClaw, tools: Array<{ name: string }>): Promise<Array<{ name: string }>> {
  const createToolSearchCatalogRef = await dist.load<() => unknown>('src/agents/tool-search.ts', 'createToolSearchCatalogRef')
  const applyToolSearchCatalog = await dist.load<(params: unknown) => { tools: Array<{ name: string }> }>('src/agents/tool-search.ts', 'applyToolSearchCatalog')
  const catalogRef = createToolSearchCatalogRef()
  const sessionKey = 'agent:main:subagent:agentchat-wake-transcript-test'
  // 2026.10.10 and later build the controls separately (and take `toolSearch: true`); earlier ones add them in `applyToolSearchCatalog`.
  if (versionAtLeast(openclaw.version, '2026.10.10')) {
    const config = { tools: { toolSearch: true } }
    const createToolSearchTools = await dist.load<(params: unknown) => Array<{ name: string }>>('src/agents/tool-search.ts', 'createToolSearchTools')
    const controls = createToolSearchTools({ config, runtimeConfig: config, catalogRef, runId: RUN_ID, sessionKey })
    return applyToolSearchCatalog({ tools: [...controls, ...tools], config, catalogRef, directToolNames: ['message'] }).tools
  }
  // Before 2026.10.10 the controls are made inside `createToolSearchTools`, which the release does not
  // export: the dispatcher is rebuilt here exactly as that function builds it (2026.6.10
  // `src/agents/tool-search.ts`: `jsonResult(await runtime.call(id, input, { parentToolCallId, signal, onUpdate }))`)
  // around OpenClaw's own `ToolSearchRuntime`.
  const config = { tools: { toolSearch: { enabled: true, mode: 'tools' } } }
  const ToolSearchRuntime = await dist.load<new (ctx: unknown, config: unknown) => { call(id: string, input: unknown, options: unknown): Promise<unknown> }>('src/agents/tool-search.ts', 'ToolSearchRuntime')
  const resolveToolSearchConfig = await dist.load<(config: unknown) => unknown>('src/agents/tool-search.ts', 'resolveToolSearchConfig')
  const runtime = new ToolSearchRuntime({ config, catalogRef, runId: RUN_ID, sessionKey }, resolveToolSearchConfig(config))
  const parameters = { type: 'object', properties: { id: { type: 'string' }, args: { type: 'object' } }, required: ['id'] }
  const dispatcher = {
    name: 'tool_call',
    label: 'Tool Call',
    description: 'Call a selected Tool Search catalog entry through OpenClaw.',
    parameters,
    execute: async (toolCallId: string, args: { id: string; args?: unknown; input?: unknown }, signal?: AbortSignal, onUpdate?: unknown) => {
      const payload = await runtime.call(args.id, args.args ?? args.input ?? {}, { parentToolCallId: toolCallId, signal, onUpdate })
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload }
    },
  }
  const search = { ...dispatcher, name: 'tool_search', execute: async () => ({ content: [{ type: 'text', text: '[]' }], details: {} }) }
  return applyToolSearchCatalog({ tools: [search, dispatcher, ...tools], config, catalogRef, runId: RUN_ID, sessionKey }).tools
}
