#!/usr/bin/env node
/**
 * Silent + conditional prepare hook.
 *
 * ## Why this is a wrapper, not just `npm run build`
 *
 * ClawHub's source-linked publish runs `npm pack --json` on the cloned
 * repo to produce its archive artifact. npm honors lifecycle hooks during
 * pack, so our `prepare` fires while npm is collecting stdout to emit as
 * a single JSON document at the end. Any human-readable logs from the
 * build chain (`tsup`, `fix-cjs-extensions`, `emit-manifest-schema`) get
 * interleaved into that captured stream. ClawHub's CLI then tries
 * `JSON.parse()` on the combined output and fails with
 * `npm pack did not return JSON output` — we saw this exact failure on
 * the 0.7.4 publish before this script existed (workflow run
 * 25581801153 / commit 4eba7fc).
 *
 * Two responsibilities:
 *
 * 1. **Silence stdout.** `stdio: ['inherit', 'ignore', 'inherit']` drops
 *    every byte the build prints to stdout. stderr is preserved so a
 *    real build failure still surfaces in the publish log — silent
 *    success, loud failure.
 *
 * 2. **Skip when dist is already built.** In our own CI the test job
 *    runs `pnpm run build` explicitly after install; running build a
 *    second time during prepare just wastes ~30s of DTS-emit time. In
 *    the npm pack flow `prepublishOnly` already built dist before pack
 *    starts. The skip lets prepare be a no-op when there's nothing to
 *    do, while still firing on a fresh source-link clone where dist
 *    doesn't exist.
 *
 * ## Why dist/index.js is the freshness check
 *
 * It's the entrypoint emit-manifest-schema imports — if that file is
 * present, the build chain ran to completion. A partial dist (tsup
 * succeeded but emit-manifest-schema failed) would still leave
 * dist/index.js in place; that's fine, because the next explicit
 * build call surfaces the failure with full logs. We're not trying
 * to be a CI gate, just a no-op fast-path for already-built trees.
 */

import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const builtEntrypoint = resolve(pkgRoot, 'dist', 'index.js')

if (existsSync(builtEntrypoint)) {
  // Already built — nothing to do. Common in CI (after explicit build),
  // in the publish lifecycle (after prepublishOnly), and in local dev
  // where the developer keeps the watch build alive.
  process.exit(0)
}

try {
  execSync('npm run build', {
    cwd: pkgRoot,
    stdio: ['inherit', 'ignore', 'inherit'],
  })
} catch (err) {
  // Bubble up the original exit code so the npm lifecycle aborts
  // cleanly. err.status is set when execSync's child exited non-zero;
  // fall through to 1 if the failure was something more exotic.
  process.exit(err.status ?? 1)
}
