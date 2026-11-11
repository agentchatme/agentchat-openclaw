#!/usr/bin/env node
/**
 * Publish-time package.json sanitizer — runs as `prepack` and `postpack`.
 *
 * Why:
 *   `openclaw plugins install` extracts our tarball into the user's
 *   `~/.openclaw/extensions/` and runs `npm install --omit=dev --silent
 *   --ignore-scripts` inside it. `--omit=dev` excludes devDependencies, but
 *   `peerDependencies` are NOT stripped — npm will try to resolve them. Our
 *   `peerDependencies.openclaw` causes an ERESOLVE / 404 / runaway peer-tree
 *   install on a stock end-user machine, surfacing as `npm install failed:`
 *   with the stderr swallowed by the `--silent` flag.
 *
 *   `--omit=dev` does not make devDependencies harmless either: npm 10 (Node
 *   22) still builds them into the dependency tree, and our devDependencies
 *   (`openclaw` among them) crash it with `Cannot read properties of null
 *   (reading 'edgesOut')`. That is what broke the 0.10.0 ClawHub artifact,
 *   which was packed with `--ignore-scripts` and so never reached `apply`.
 *   The ClawHub job in publish.yml now packs through this lifecycle too.
 *
 *   `@openclaw/matrix` (the first-party reference plugin) sidesteps this by
 *   stripping `devDependencies`, `peerDependencies`, `peerDependenciesMeta`
 *   from the published tarball at publish time. We mirror that.
 *
 * Modes:
 *   apply    — snapshot package.json, then strip the three fields and
 *              guard against any runtime `dependencies` using `workspace:`,
 *              `file:`, or `link:` specs (npm cannot resolve those at
 *              install time on a user machine).
 *   restore  — restore the snapshot. Idempotent — no-op if no snapshot
 *              exists.
 *
 * Behavior:
 *   - The snapshot is written to `package.json.publish-bak`. Failure to
 *     restore (e.g. snapshot missing during `restore`) is logged but does
 *     not exit non-zero, so a failed pack doesn't leave the working tree
 *     wedged.
 *   - On `apply`, an existing snapshot is treated as a leftover from a
 *     prior failed pack and is overwritten — the current package.json is
 *     authoritative.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(scriptDir, '..')
const packageJsonPath = resolve(pkgRoot, 'package.json')
const backupPath = resolve(pkgRoot, 'package.json.publish-bak')

const mode = process.argv[2]
if (mode !== 'apply' && mode !== 'restore') {
  console.error('[strip-publish-fields] usage: strip-publish-fields.mjs <apply|restore>')
  process.exit(1)
}

function log(msg) {
  console.log(`[strip-publish-fields] ${msg}`)
}

function fail(msg) {
  console.error(`[strip-publish-fields] ${msg}`)
  process.exit(1)
}

if (mode === 'restore') {
  if (!existsSync(backupPath)) {
    log('no snapshot to restore — nothing to do')
    process.exit(0)
  }
  renameSync(backupPath, packageJsonPath)
  log(`restored package.json from ${backupPath}`)
  process.exit(0)
}

// mode === 'apply'

if (!existsSync(packageJsonPath)) {
  fail(`package.json not found at ${packageJsonPath}`)
}

// Always overwrite the snapshot — leftover from a previous failed pack is
// not authoritative, the current package.json is.
copyFileSync(packageJsonPath, backupPath)
log(`snapshotted package.json → ${backupPath}`)

const raw = readFileSync(packageJsonPath, 'utf8')
let pkg
try {
  pkg = JSON.parse(raw)
} catch (err) {
  fail(`could not parse package.json: ${err.message}`)
}

// Guard: runtime dependencies must not use any spec npm doesn't natively
// understand (`workspace:`, `file:`, `link:`, `catalog:`). pnpm rewrites
// `workspace:` to real semver during `pnpm pack` for the npm tarball, but
// ClawHub source-linked builds skip pack entirely — they zip the raw
// source tree and run `npm install` on it. A `workspace:^` that pnpm
// would have rewritten on publish reaches end-user machines unmodified
// and crashes with EUNSUPPORTEDPROTOCOL. This guard catches all four
// non-portable specs at publish time so the source itself stays npm-
// installable. The runtime regression test
// (`scripts/verify-source-installs.mjs`) catches the same class of bug
// pre-publish via `npm install --dry-run`.
const runtimeDeps = pkg.dependencies ?? {}
const unresolvable = []
for (const [name, spec] of Object.entries(runtimeDeps)) {
  if (typeof spec !== 'string') continue
  if (
    spec.startsWith('workspace:') ||
    spec.startsWith('file:') ||
    spec.startsWith('link:') ||
    spec.startsWith('catalog:')
  ) {
    unresolvable.push(`${name}@${spec}`)
  }
}
if (unresolvable.length > 0) {
  // Restore the snapshot so the working tree is left clean.
  if (existsSync(backupPath)) {
    renameSync(backupPath, packageJsonPath)
  }
  fail(
    `runtime dependencies use specs that npm cannot resolve from the registry:\n  ${unresolvable.join(
      '\n  ',
    )}\nThese must be rewritten to real semver ranges before publish.`,
  )
}

const stripped = []
if (pkg.devDependencies !== undefined) {
  delete pkg.devDependencies
  stripped.push('devDependencies')
}
if (pkg.peerDependencies !== undefined) {
  delete pkg.peerDependencies
  stripped.push('peerDependencies')
}
if (pkg.peerDependenciesMeta !== undefined) {
  delete pkg.peerDependenciesMeta
  stripped.push('peerDependenciesMeta')
}

if (stripped.length === 0) {
  log('no fields to strip — package.json already clean')
  // Nothing changed, but the snapshot stays so `restore` is still a no-op
  // happy path. Remove it to avoid leaving a stray file.
  unlinkSync(backupPath)
  process.exit(0)
}

writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
log(`stripped from published package.json: ${stripped.join(', ')}`)
