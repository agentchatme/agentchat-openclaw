/**
 * `--token-file` in every shape a shell hands it over: `- < file`, a pipe,
 * `/dev/stdin`, a path — each in a process of its own, with fd 0 set up the
 * way the shell sets it up (./helpers/read-key-input.mjs).
 *
 * The case that broke: `openclaw channels add --channel agentchat --token-file - <
 * ~/agentchat.key` typed in a terminal answered "standard input is not one
 * API key: it is empty". In a terminal OpenClaw's CLI puts `process.stdin`
 * into flowing mode; for a redirected file that stream reads the file to its
 * end and leaves the offset fd 0 shares at EOF, so an in-order read finds
 * nothing. A regular file is now read from its first byte at explicit
 * positions; `/dev/stdin` (on macOS a duplicate of fd 0, same offset) is the
 * same file and is read the same way; a pipe is read in order, as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readKeyInput } from '../src/credentials/key-input.js'
import { testKey } from './helpers/keys.js'

const KEY = testKey('t'.repeat(43))
const KEY_SHA = createHash('sha256').update(KEY).digest('hex')
const HARNESS = fileURLToPath(new URL('./helpers/read-key-input.mjs', import.meta.url))
// Node ≥ 22.18 strips TypeScript types by default; older 22.x needs the flag.
const NODE_ARGS = [...((process.features as { typescript?: unknown }).typescript ? [] : ['--experimental-strip-types']), '--no-warnings']

let scratch: string
let keyFile: string

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-key-input-'))
  keyFile = path.join(scratch, 'agentchat.key')
  fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 })
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

interface HarnessResult {
  readonly ok: boolean
  readonly sha256?: string
  readonly reason?: string
  readonly offsetDrained?: boolean
  /** What fd 0 was in the child. */
  readonly stdin?: 'file' | 'fifo' | 'socket' | 'tty' | 'other'
}

/** The child's environment: nothing of the developer's or runner's OpenClaw / AgentChat / Node settings. */
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCLAW_|AGENTCHAT_|NODE_OPTIONS$|VITEST)/.test(key)))
}

function parse(stdout: string, stderr: string): HarnessResult {
  const line = stdout
    .replace(/\r/g, '')
    .split('\n')
    .find((candidate) => candidate.includes('{"ok":'))
  if (!line) throw new Error(`the harness printed no result: ${stdout.slice(-500)} ${stderr.slice(-500)}`)
  // Through a pty the line can follow what `script` echoed (a ^D on macOS).
  return JSON.parse(line.slice(line.indexOf('{"ok":'))) as HarnessResult
}

const shellQuote = (parts: readonly string[]): string => parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ')

/**
 * Runs the harness with fd 0 = `stdin`: an open descriptor; `input` written
 * to what Node's `spawn` gives a child, a UNIX socket (what an agent's exec
 * tool or any Node runtime hands `openclaw`); or `shellPipe`, the key file
 * through a real shell pipe (`cat file | …`, a FIFO).
 */
function runHarness(args: readonly string[], stdin: { fd: number } | { input: string } | { shellPipe: string }): Promise<HarnessResult> {
  return new Promise((resolve, reject) => {
    const command = [process.execPath, ...NODE_ARGS, HARNESS, ...args]
    const child =
      'shellPipe' in stdin
        ? spawn('/bin/sh', ['-c', `cat ${shellQuote([stdin.shellPipe])} | ${shellQuote(command)}`], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(command[0]!, command.slice(1), { env: childEnv(), stdio: ['fd' in stdin ? stdin.fd : 'pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr!.on('data', (chunk) => (stderr += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      try {
        if (code !== 0) throw new Error(`the harness exited ${code}: ${stderr.slice(-1000)}`)
        resolve(parse(stdout, stderr))
      } catch (err) {
        reject(err)
      }
    })
    if ('input' in stdin) child.stdin!.end(stdin.input)
  })
}

/** `node harness … < keyFile`: fd 0 is the regular file itself. */
async function withRedirectedFile(args: readonly string[]): Promise<HarnessResult> {
  const fd = fs.openSync(keyFile, 'r')
  try {
    return await runHarness(args, { fd })
  } finally {
    fs.closeSync(fd)
  }
}

describe('--token-file -: standard input redirected from the key file (- < ~/agentchat.key)', () => {
  it('in a terminal: OpenClaw’s stdin stream has already read the file and left the shared offset at EOF — the key is still read in full', async () => {
    const result = await withRedirectedFile(['-', 'drain'])
    expect(result.offsetDrained).toBe(true)
    expect(result).toMatchObject({ ok: true, sha256: KEY_SHA, stdin: 'file' })
  })

  it('outside a terminal (nothing read the file first)', async () => {
    expect(await withRedirectedFile(['-'])).toMatchObject({ ok: true, sha256: KEY_SHA, stdin: 'file' })
  })
})

describe.skipIf(process.platform === 'win32')('--token-file -: standard input from a pipe (cat ~/agentchat.key | …)', () => {
  it('a shell pipe (a FIFO) is read in order, as before', async () => {
    expect(await runHarness(['-'], { shellPipe: keyFile })).toMatchObject({ ok: true, sha256: KEY_SHA, stdin: 'fifo' })
  })

  it('a socket (what a Node runtime spawning openclaw hands it) is read in order too', async () => {
    expect(await runHarness(['-'], { input: `${KEY}\n` })).toMatchObject({ ok: true, sha256: KEY_SHA, stdin: 'socket' })
  })

  it('an empty pipe is read as empty (the caller then says the key is missing)', async () => {
    const empty = path.join(scratch, 'empty.key')
    fs.writeFileSync(empty, '')
    expect(await runHarness(['-'], { shellPipe: empty })).toMatchObject({ ok: true, sha256: createHash('sha256').update('').digest('hex') })
  })
})

describe('--token-file /dev/stdin', () => {
  it('with the key file redirected, after OpenClaw’s stdin stream read it (macOS: /dev/stdin is fd 0 again, same offset)', async () => {
    const result = await withRedirectedFile(['/dev/stdin', 'drain'])
    expect(result.offsetDrained).toBe(true)
    expect(result).toMatchObject({ ok: true, sha256: KEY_SHA, stdin: 'file' })
  })

  it.skipIf(process.platform === 'win32')('with the key piped in through the shell', async () => {
    expect(await runHarness(['/dev/stdin'], { shellPipe: keyFile })).toMatchObject({ ok: true, sha256: KEY_SHA, stdin: 'fifo' })
  })

  it('with a socket as standard input (Linux refuses to open /proc/self/fd/0 for a socket: ENXIO) — read as fd 0 itself', async () => {
    expect(await runHarness(['/dev/stdin'], { input: `${KEY}\n` })).toMatchObject({ ok: true, sha256: KEY_SHA, stdin: 'socket' })
    expect(await runHarness(['/dev/fd/0'], { input: `${KEY}\n` })).toMatchObject({ ok: true, sha256: KEY_SHA, stdin: 'socket' })
  })
})

describe('--token-file <path>', () => {
  it('reads the file, whatever standard input is', async () => {
    expect(await runHarness([keyFile], { input: '' })).toMatchObject({ ok: true, sha256: KEY_SHA })
  })

  it('a directory or a missing file is refused, naming the path', () => {
    expect(readKeyInput(scratch)).toEqual({ ok: false, reason: `${scratch} is a directory` })
    expect(readKeyInput(path.join(scratch, 'nope'))).toEqual({ ok: false, reason: `${path.join(scratch, 'nope')} does not exist` })
  })

  it('more than 4 KiB is not a key file', () => {
    const big = path.join(scratch, 'big.key')
    fs.writeFileSync(big, 'x'.repeat(5000))
    expect(readKeyInput(big)).toEqual({ ok: false, reason: `${big} holds more than 4096 bytes, so it is not a key` })
  })
})

describe('the descriptor’s own offset', () => {
  it('a regular file is read at explicit positions: an offset already at EOF does not matter, and is left where it was', () => {
    const fd = fs.openSync(keyFile, 'r')
    try {
      const drained = Buffer.alloc(256)
      while (fs.readSync(fd, drained, 0, drained.length, null) > 0) {
        // what a flowing stdin stream does to the shared offset
      }
      const read = readKeyInput('-', { stdinFd: fd })
      expect(read).toEqual({ ok: true, text: `${KEY}\n` })
      expect(fs.readSync(fd, drained, 0, drained.length, null)).toBe(0)
    } finally {
      fs.closeSync(fd)
    }
  })
})

// A terminal as standard input, through a pty: `script` (util-linux on Linux, BSD on macOS).
const scriptArgs = (command: readonly string[]): readonly string[] | null => {
  if (process.platform === 'darwin') return ['-q', '/dev/null', ...command]
  if (process.platform === 'linux') return ['-q', '-e', '-c', shellQuote(command), '/dev/null']
  return null
}
const hasScript = process.platform !== 'win32' && spawnSync('script', ['-q', '/dev/null', 'true'], { stdio: 'ignore' }).error === undefined

describe.runIf(hasScript && scriptArgs([]) !== null)('--token-file - with standard input a terminal', () => {
  it('is refused in plain words instead of reading the keystrokes OpenClaw’s own stream also reads', async () => {
    const args = scriptArgs([process.execPath, ...NODE_ARGS, HARNESS, '-'])!
    const result = await new Promise<HarnessResult>((resolve, reject) => {
      // `script`'s own stdin is /dev/null (macOS `script` refuses a socket there); the child's is the pty.
      const devNull = fs.openSync('/dev/null', 'r')
      const child = spawn('script', [...args], { env: childEnv(), stdio: [devNull, 'pipe', 'pipe'] })
      fs.closeSync(devNull)
      let stdout = ''
      let stderr = ''
      child.stdout!.on('data', (chunk) => (stdout += String(chunk)))
      child.stderr!.on('data', (chunk) => (stderr += String(chunk)))
      child.on('error', reject)
      child.on('close', () => {
        try {
          resolve(parse(stdout, stderr))
        } catch (err) {
          reject(err)
        }
      })
    })
    expect(result).toEqual({ ok: false, reason: 'standard input is a terminal, not a file: pass the key file as --token-file <path>', stdin: 'tty' })
  })
})
