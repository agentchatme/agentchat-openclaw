// Runs the plugin's `--token-file` reader (src/credentials/key-input.ts, loaded
// by Node's own type stripping) in a process of its own, with fd 0 as the
// test set it up: a redirected file, a pipe, a terminal. Prints one JSON line:
// `{ ok, sha256 }` or `{ ok: false, reason }` — a digest, never the text —
// and `stdin`, what fd 0 is (file, fifo, socket, tty), so a test proves the
// shape it set up.
//
//   node read-key-input.mjs <source> [drain]
//
// `drain` first does what OpenClaw's CLI does to standard input in a
// terminal: `process.stdin` in flowing mode, read to its end, which moves the
// file offset fd 0 shares to EOF. It also reports whether a plain in-order
// read of fd 0 then finds anything (`offsetDrained`), so the test proves the
// condition it guards against actually held.

import { createHash } from 'node:crypto'
import { fstatSync, readSync } from 'node:fs'
import { isatty } from 'node:tty'

const [source, mode] = process.argv.slice(2)
const fd0 = fstatSync(0)
const stdin = isatty(0) ? 'tty' : fd0.isFile() ? 'file' : fd0.isFIFO() ? 'fifo' : fd0.isSocket() ? 'socket' : 'other'
const { readKeyInput } = await import(new URL('../../src/credentials/key-input.ts', import.meta.url).href)

let offsetDrained
if (mode === 'drain') {
  await new Promise((resolve) => {
    process.stdin.on('data', () => {})
    process.stdin.once('end', resolve)
    process.stdin.once('error', resolve)
    process.stdin.resume()
  })
  process.stdin.pause()
  if (fstatSync(0).isFile()) offsetDrained = readSync(0, Buffer.alloc(16), 0, 16, null) === 0
}

const read = readKeyInput(source)
const out = read.ok ? { ok: true, sha256: createHash('sha256').update(read.text.trim()).digest('hex') } : { ok: false, reason: read.reason }
process.stdout.write(`${JSON.stringify({ ...out, stdin, ...(offsetDrained === undefined ? {} : { offsetDrained }) })}\n`)
