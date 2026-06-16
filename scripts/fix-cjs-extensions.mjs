#!/usr/bin/env node
/**
 * Post-build import-path fixer for emitted bundles.
 *
 * tsup emits both ESM (`.js`) and CJS (`.cjs`) outputs and leaves
 * external imports untouched. Two path problems then show up:
 *
 * 1. CJS bundles still point at `.js` helpers, which fails inside a
 *    `"type": "module"` package (`ERR_REQUIRE_ESM`).
 * 2. Root bundles (`dist/index.*`, `dist/setup-entry.*`) preserve the
 *    parent-relative import literal from `src/binding/agents-anchor.ts`:
 *    `../credentials/read-env.*`. Once bundled into the dist root that
 *    path is wrong — it escapes `dist/` entirely instead of resolving to
 *    `dist/credentials/read-env.*`.
 *
 * This script walks the known emitted bundles after `tsup` finishes and
 * rewrites those known-bad specifiers to the paths that actually exist in
 * `dist/`. Sourcemaps are untouched because they reference source
 * positions, not module paths.
 *
 * The replacement is exact-string and scoped to the known external
 * paths — it will not rewrite test fixtures, docs, or the ESM bundles.
 * Wired into `pnpm run build` so the swap happens on every release
 * without an extra step. CI does not run this; tests load source
 * TypeScript directly and never the CJS dist.
 *
 * See SECURITY.md ("Defensive separation of credential lookup from
 * outbound I/O") for why these helpers are separate dist files in
 * the first place.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(__dirname, '..', 'dist')

const bundleReplacements = new Map([
  [
    'index.js',
    [
      ["'../credentials/read-env.js'", "'./credentials/read-env.js'"],
      ['"../credentials/read-env.js"', '"./credentials/read-env.js"'],
    ],
  ],
  [
    'setup-entry.js',
    [
      ["'../credentials/read-env.js'", "'./credentials/read-env.js'"],
      ['"../credentials/read-env.js"', '"./credentials/read-env.js"'],
    ],
  ],
  [
    'index.cjs',
    [
      ["'./credentials/read-env.js'", "'./credentials/read-env.cjs'"],
      ['"./credentials/read-env.js"', '"./credentials/read-env.cjs"'],
      ["'../credentials/read-env.js'", "'./credentials/read-env.cjs'"],
      ['"../credentials/read-env.js"', '"./credentials/read-env.cjs"'],
      ["'./binding/agents-anchor.js'", "'./binding/agents-anchor.cjs'"],
      ['"./binding/agents-anchor.js"', '"./binding/agents-anchor.cjs"'],
    ],
  ],
  [
    'setup-entry.cjs',
    [
      ["'./credentials/read-env.js'", "'./credentials/read-env.cjs'"],
      ['"./credentials/read-env.js"', '"./credentials/read-env.cjs"'],
      ["'../credentials/read-env.js'", "'./credentials/read-env.cjs'"],
      ['"../credentials/read-env.js"', '"./credentials/read-env.cjs"'],
      ["'./binding/agents-anchor.js'", "'./binding/agents-anchor.cjs'"],
      ['"./binding/agents-anchor.js"', '"./binding/agents-anchor.cjs"'],
    ],
  ],
  [
    'binding/agents-anchor.cjs',
    [
      ["'../credentials/read-env.js'", "'../credentials/read-env.cjs'"],
      ['"../credentials/read-env.js"', '"../credentials/read-env.cjs"'],
    ],
  ],
])

let touched = 0
let totalReplacements = 0

for (const [file, replacements] of bundleReplacements.entries()) {
  const path = resolve(distDir, file)
  if (!existsSync(path)) {
    continue
  }
  const before = readFileSync(path, 'utf8')
  let after = before
  let fileReplacements = 0
  for (const [from, to] of replacements) {
    const split = after.split(from)
    if (split.length > 1) {
      fileReplacements += split.length - 1
      after = split.join(to)
    }
  }
  if (fileReplacements === 0) continue
  writeFileSync(path, after, 'utf8')
  touched++
  totalReplacements += fileReplacements
  console.log(
    `[fix-cjs-extensions] ${file}: rewrote ${fileReplacements} external require` +
      (fileReplacements === 1 ? '' : 's') +
      ' from .js to .cjs',
  )
}

if (touched === 0) {
  console.warn(
    '[fix-cjs-extensions] No emitted bundles needed rewriting. Verify ' +
      'the known dist entrypoints exist and the `external` list in tsup.config.ts ' +
      'still matches the fixup rules here.',
  )
} else {
  console.log(
    `[fix-cjs-extensions] done — ${touched} file(s) updated, ${totalReplacements} import path(s) rewritten`,
  )
}
