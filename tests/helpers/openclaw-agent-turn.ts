/**
 * One real OpenClaw agent turn, end to end, against loopback fakes: the
 * installed `openclaw agent --local` (the embedded runner, its tool surface —
 * Tool Search, Code Mode — its MCP client and its transcript store) runs a
 * turn whose model is a scripted OpenAI-compatible server and whose
 * `agentchat` MCP server answers, fails or returns large results as told.
 * The stored session is then read back with OpenClaw's own `sessions.get`
 * reader (./openclaw-read-session.mjs). Only the model and the MCP server
 * are fakes; nothing reaches the network beyond 127.0.0.1, and the turn's
 * HOME and state dir are scratch directories.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { InstalledOpenClaw } from './openclaw-session.js'

export interface AgentTurnPlan {
  /** The tool calls the model makes in its first response (it stops after the results). */
  readonly calls: ReadonlyArray<{ readonly name: string; readonly arguments: Record<string, unknown> }>
  /** The `agentchat` MCP server's tools: answered (with `bytes` of padding) or failed by the server. */
  readonly tools: Readonly<Record<string, { readonly outcome: 'ok' | 'server_error'; readonly bytes?: number; readonly delayMs?: number }>>
  /** The model declares Code Mode preferred (`compat.codeMode: 'preferred'`), as flagship models do. */
  readonly codeModePreferred?: boolean
  /** Code Mode's per-cell budget (`tools.codeMode.timeoutMs`); a call slower than it leaves the script `waiting`. */
  readonly codeModeTimeoutMs?: number
}

export interface AgentTurn {
  /** The stored session, as `sessions.get` returns it. */
  readonly rows: Record<string, unknown>[]
  /** The tools the model was offered. */
  readonly offeredTools: string[]
}

const SESSION_KEY = 'agent:main:subagent:agentchat-wake-transcript-test'
const reader = fileURLToPath(new URL('./openclaw-read-session.mjs', import.meta.url))

export async function runAgentTurn(openclaw: InstalledOpenClaw, plan: AgentTurnPlan, limit: number): Promise<AgentTurn> {
  const offeredTools: string[] = []
  const model = await listen(modelServer(plan, offeredTools))
  const mcp = await listen(await mcpServer(openclaw, plan))
  // Clients that honour proxy settings send anything not for 127.0.0.1 to a closed port.
  const blackhole = 'http://127.0.0.1:9'
  const home = mkdtempSync(join(tmpdir(), 'agentchat-openclaw-turn-'))
  const state = join(home, '.openclaw')
  mkdirSync(state, { recursive: true })
  const configPath = join(state, 'openclaw.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      models: {
        providers: {
          mock: {
            baseUrl: `http://127.0.0.1:${model.port}/v1`,
            apiKey: 'test-key',
            api: 'openai-completions',
            models: [
              {
                id: 'mock-model',
                name: 'mock-model',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4_096,
                ...(plan.codeModePreferred ? { compat: { codeMode: 'preferred' } } : {}),
              },
            ],
          },
        },
      },
      agents: { defaults: { model: { primary: 'mock/mock-model' }, workspace: join(home, 'workspace') } },
      ...(plan.codeModeTimeoutMs !== undefined ? { tools: { codeMode: { enabled: 'auto', timeoutMs: plan.codeModeTimeoutMs } } } : {}),
      mcp: { servers: { agentchat: { url: `http://127.0.0.1:${mcp.port}/mcp`, transport: 'streamable-http' } } },
    }),
  )
  // The developer's or runner's own OpenClaw and AgentChat settings, and the test runner's own
  // markers (OpenClaw reads VITEST / NODE_ENV as "inside OpenClaw's own tests"), stay out of the turn.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(OPENCLAW_|AGENTCHAT_|VITEST|NODE_ENV$|NODE_OPTIONS$)/.test(key) && !/proxy/i.test(key)),
  )
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    HTTP_PROXY: blackhole,
    HTTPS_PROXY: blackhole,
    ALL_PROXY: blackhole,
    NO_PROXY: '127.0.0.1,localhost',
  }
  const cli = join(openclaw.dir, 'openclaw.mjs')
  try {
    const turn = await run([cli, 'agent', '--local', '--agent', 'main', '--session-key', SESSION_KEY, '-m', 'You have AgentChat messages.', '--json', '--timeout', '120'], env, home)
    if (turn.code !== 0) throw new Error(`openclaw agent exited ${turn.code}: ${turn.stderr.slice(-2000)}`)
    const sessions = await run([cli, 'sessions', '--json', '--agent', 'main'], env, home)
    const listed = parseJson(sessions, 'openclaw sessions') as { path: string; sessions: Array<{ key: string; sessionId: string }> }
    const session = listed.sessions.find((entry) => entry.key === SESSION_KEY)
    if (!session) throw new Error(`the turn's session is not in the store: ${JSON.stringify(listed).slice(0, 500)}`)
    const read = await run([reader, join(openclaw.dir, 'dist'), session.key, session.sessionId, listed.path, String(limit)], env, home)
    if (read.code !== 0) throw new Error(`reading the session failed: ${read.stderr.slice(-2000)}`)
    return { rows: parseJson(read, 'the session read') as Record<string, unknown>[], offeredTools }
  } finally {
    model.server.close()
    mcp.server.close()
    rmSync(home, { recursive: true, force: true })
  }
}

/** An OpenAI-compatible chat-completions stream: the planned tool calls first, then a short answer. */
function modelServer(plan: AgentTurnPlan, offeredTools: string[]): http.Server {
  return http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += String(chunk)))
    req.on('end', () => {
      if (!req.url?.includes('chat/completions')) {
        res.writeHead(404).end()
        return
      }
      const request = JSON.parse(body || '{}') as { model?: string; tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role?: string }> }
      if (offeredTools.length === 0) offeredTools.push(...(request.tools ?? []).flatMap((tool) => (tool.function?.name ? [tool.function.name] : [])))
      const answered = (request.messages ?? []).some((message) => message.role === 'tool')
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (answered) {
        res.write(chunk({ role: 'assistant', content: 'done' }, null))
        res.write(chunk({}, 'stop'))
      } else {
        const toolCalls = plan.calls.map((call, index) => ({ index, id: `call_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }))
        res.write(chunk({ role: 'assistant', tool_calls: toolCalls }, null))
        res.write(chunk({}, 'tool_calls'))
      }
      res.end('data: [DONE]\n\n')
    })
  })
}

/** The `agentchat` MCP server, built with the MCP SDK OpenClaw itself depends on (streamable HTTP, stateless). */
async function mcpServer(openclaw: InstalledOpenClaw, plan: AgentTurnPlan): Promise<http.Server> {
  const require = createRequire(join(openclaw.dir, 'package.json'))
  const sdk = (path: string) => import(pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${path}`)).href)
  const { McpServer } = (await sdk('server/mcp.js')) as { McpServer: new (info: unknown) => McpServerLike }
  const { StreamableHTTPServerTransport } = (await sdk('server/streamableHttp.js')) as { StreamableHTTPServerTransport: new (options: unknown) => TransportLike }
  return http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += String(chunk)))
    req.on('end', () => {
      void (async () => {
        const server = new McpServer({ name: 'agentchat', version: '1.0.0' })
        for (const [tool, spec] of Object.entries(plan.tools)) {
          server.registerTool(tool, { description: `AgentChat ${tool}`, inputSchema: {} }, async () => {
            if (spec.delayMs) await new Promise((resolve) => setTimeout(resolve, spec.delayMs))
            return spec.outcome === 'server_error'
              ? { content: [{ type: 'text', text: 'AWAITING_REPLY' }], isError: true }
              : { content: [{ type: 'text', text: `{"conversations":[]}${' '.repeat(spec.bytes ?? 0)}` }] }
          })
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        res.on('close', () => {
          void transport.close()
          void server.close()
        })
        await server.connect(transport)
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
  })
}

interface McpServerLike {
  registerTool(name: string, config: unknown, handler: () => Promise<unknown>): void
  connect(transport: TransportLike): Promise<void>
  close(): Promise<void>
}

interface TransportLike {
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void>
  close(): Promise<void>
}

async function listen(server: http.Server): Promise<{ server: http.Server; port: number }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

function parseJson(result: { code: number | null; stdout: string; stderr: string }, what: string): unknown {
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${what} (exit ${result.code}) printed no JSON: ${result.stdout.slice(0, 500)} ${result.stderr.slice(-1500)}`)
  }
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}
