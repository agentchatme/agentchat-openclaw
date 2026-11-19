/**
 * The bytes of a key handed to `--token-file`: a path, or `-` for standard
 * input. Self-contained on purpose (`node:fs` and `node:tty` only), so a
 * test can run it in a process of its own with standard input set up the
 * way a shell sets it up.
 *
 * Standard input as a regular file (`--token-file - < ~/agentchat.key`) is
 * read from its first byte at explicit positions, never from the file
 * offset fd 0 shares with the rest of the process: in a terminal OpenClaw's
 * CLI has already put `process.stdin` into flowing mode, and that stream
 * reads the file to its end on its own, which leaves the shared offset at
 * EOF. `/dev/stdin` is read as fd 0 itself (see `STDIN_PATHS`). A pipe,
 * FIFO or socket can only be read in order, so it is; a terminal is
 * refused, since OpenClaw's own stream reads the same keystrokes.
 *
 * Local filesystem I/O only: no SDK, no network, no environment reads.
 * Never throws; never puts the bytes read into a reason.
 */

import * as fs from 'node:fs'
import * as tty from 'node:tty'

/** A key is a few dozen characters; anything larger is not a key file. */
export const MAX_KEY_INPUT_BYTES = 4096

export type KeyInputRead = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }

const CHUNK_BYTES = 1024
const EAGAIN_PAUSE_MS = 5

/** A short synchronous pause, so a non-blocking pipe that has no data yet is not polled in a hot loop. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Up to `MAX_KEY_INPUT_BYTES + 1` bytes. `fromStart`: at explicit positions
 * from 0 (a regular file; the descriptor's offset is neither read nor
 * moved). Otherwise in order from wherever the stream is.
 */
function readCapped(fd: number, fromStart: boolean): Buffer {
  const chunks: Buffer[] = []
  let total = 0
  const buf = Buffer.alloc(CHUNK_BYTES)
  for (;;) {
    let n: number
    try {
      n = fs.readSync(fd, buf, 0, buf.length, fromStart ? total : null)
    } catch (err) {
      // A pipe that `process.stdin` switched to non-blocking mode, before its writer wrote.
      if ((err as NodeJS.ErrnoException)?.code === 'EAGAIN') {
        pause(EAGAIN_PAUSE_MS)
        continue
      }
      throw err
    }
    if (n === 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
    total += n
    if (total > MAX_KEY_INPUT_BYTES) break
  }
  return Buffer.concat(chunks)
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? 'error'
}

/** The text on an open descriptor: a regular file from its start, anything else in order. */
function readDescriptor(fd: number, label: string): KeyInputRead {
  let stat: fs.Stats
  try {
    stat = fs.fstatSync(fd)
  } catch (err) {
    return { ok: false, reason: `${label} cannot be read (${errorCode(err)})` }
  }
  if (stat.isDirectory()) return { ok: false, reason: `${label} is a directory` }
  if (stat.isFile() && stat.size > MAX_KEY_INPUT_BYTES) return { ok: false, reason: `${label} holds more than ${MAX_KEY_INPUT_BYTES} bytes, so it is not a key` }
  if (tty.isatty(fd)) {
    return {
      ok: false,
      reason: `${label} is a terminal, not a file: pass the key file as --token-file <path>`,
    }
  }
  let bytes: Buffer
  try {
    bytes = readCapped(fd, stat.isFile())
  } catch (err) {
    return { ok: false, reason: `${label} cannot be read (${errorCode(err)})` }
  }
  if (bytes.length > MAX_KEY_INPUT_BYTES) return { ok: false, reason: `${label} holds more than ${MAX_KEY_INPUT_BYTES} bytes, so it is not a key` }
  return { ok: true, text: bytes.toString('utf8') }
}

/**
 * The names of this process's standard input as a path. Opened, they are
 * the same open file on macOS (a duplicate, sharing the offset) but a fresh
 * open on Linux (`/proc/self/fd/0`), which a socket refuses (ENXIO) — and a
 * runtime that spawns `openclaw` from Node hands it a socket, not a pipe.
 * So they are read as fd 0 itself, like `-`.
 */
const STDIN_PATHS = new Set(['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'])

/**
 * What `--token-file <source>` holds: `-` (or `/dev/stdin`) is standard
 * input (`stdinFd`, 0 unless a test says otherwise), anything else a path,
 * already resolved (`~` expanded) by the caller. The text is returned as
 * read; whether it is one key is the caller's question.
 */
export function readKeyInput(source: string, options: { readonly stdinFd?: number } = {}): KeyInputRead {
  if (source === '-') return readDescriptor(options.stdinFd ?? 0, 'standard input')
  if (process.platform !== 'win32' && STDIN_PATHS.has(source)) return readDescriptor(options.stdinFd ?? 0, source)
  let fd: number
  try {
    fd = fs.openSync(source, 'r')
  } catch (err) {
    const code = errorCode(err)
    return { ok: false, reason: `${source} ${code === 'ENOENT' ? 'does not exist' : `cannot be read (${code})`}` }
  }
  try {
    return readDescriptor(fd, source)
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // already closed
    }
  }
}
