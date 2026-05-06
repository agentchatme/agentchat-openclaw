# Upstream-readiness notes

This package is published standalone as `@agentchatme/openclaw` (community
plugin path) AND structured so it can be PR'd into [openclaw/openclaw][1] as
a first-party built-in channel with minimal restructuring. This file is the
checklist of what's intentionally aligned with OpenClaw's core conventions
and what must change at PR time.

[1]: https://github.com/openclaw/openclaw

If you're touching this package and you're about to break one of the
"pre-aligned" items below, stop and ask whether the change is worth the
re-alignment work at upstream PR time.

---

## Pre-aligned today (do NOT silently break)

### 1. License — MIT
OpenClaw is MIT-licensed. We are too. Zero relicensing work needed.

### 2. Test runner — vitest
OpenClaw uses vitest. We use vitest. Test files use the same `describe` / `it`
/ `expect` surface. No jest, no mocha.

### 3. ESM with `.js` extensions on relative imports
OpenClaw is ESM (`"type": "module"`). Relative imports inside our `src/`
already use `.js` extensions (Node ESM convention) — DO NOT switch to
extensionless imports or to `.ts` extensions. tsdown (their bundler) and
tsup (ours) both expect `.js`-extension ESM source.

### 4. Plugin SDK import path — `openclaw/plugin-sdk/...`
We import from `openclaw/plugin-sdk/channel-entry-contract` and similar
public subpaths, NOT from `openclaw/internals/...` or undocumented paths.
The public `openclaw` npm package exports these subpaths officially. If
you find yourself reaching for an internal path, file a `needs upstream
blessing` issue instead.

### 5. Peer dependency on `openclaw`, not direct dependency
`peerDependencies.openclaw: ">=2026.4.0"` — this matches OpenClaw's own
built-in extension shape (e.g., `@openclaw/discord` uses
`peerDependencies.openclaw: ">=2026.5.6"` with `optional: true`). Built-in
extensions resolve openclaw via workspace; standalone installs resolve via
the user's installed openclaw. Either path works from one source.

### 6. Channel id — `agentchat`
Lowercase, brand-only, single token. Matches OpenClaw's pattern (`discord`,
`slack`, `imessage`, `matrix`, etc.). At upstream PR time the directory
becomes `extensions/agentchat/` — keep the channel id in sync with that.

### 7. Skill is self-contained Markdown + frontmatter
`skills/agentchat/SKILL.md` has no imports, no compile-time substitution,
no externalized blocks. Pure Markdown + YAML frontmatter. At upstream PR
time the entire `skills/agentchat/` directory moves to
`<openclaw-root>/skills/agentchat/` verbatim — it must remain self-contained.

### 8. Manifest is a single JSON file at the package root
`openclaw.plugin.json` lives at the repo root. All path references inside
it are relative to the manifest itself — never absolute, never reaching
outside the package directory.

### 9. Setup wizard is data + small code
`setup-entry.ts` is the wizard entry point. The wizard's user-facing
strings, validation, and flow live in source we can hand off; no
plugin-private OpenClaw API usage.

### 10. No reach into the old monorepo
The plugin depends on `agentchatme` from public npm, not on a workspace
sibling. Verified after the 2026-05 split — DO NOT add a workspace alias
or re-introduce a monorepo dep.

---

## What WILL change at upstream PR time

These cannot be pre-solved; they're inherent to moving from a standalone
npm package to a built-in extension.

### A. Package name
- Standalone: `@agentchatme/openclaw`
- Upstream: `@openclaw/agentchat`

OpenClaw's built-in extensions follow `@openclaw/<channel-id>` (e.g.,
`@openclaw/slack`, `@openclaw/discord`).

### B. Versioning
- Standalone: SemVer (`0.7.0`, `1.0.0`, etc.)
- Upstream: CalVer pinned to OpenClaw's release (`2026.5.6` etc.)

When PR'd, the version locks to the OpenClaw release it ships in.

### C. Dependency on `agentchatme` SDK
- Standalone: regular dependency, npm-resolved
- Upstream: same regular dependency. OpenClaw's monorepo will resolve it
  from npm too (their workspace doesn't vendor `agentchatme`).

### D. `package.json` repository field
- Standalone: `git+https://github.com/agentchatme/agentchat-openclaw.git`
- Upstream: `https://github.com/openclaw/openclaw` (root)

### E. Manifest `setupEntry`, `extensions`, `configuredState.specifier`
- Standalone: `./dist/setup-entry.js`, `./dist/index.js`, `./dist/configured-state.js`
- Upstream: `./setup-entry.ts`, `./index.ts`, `./configured-state` (TypeScript source,
  JIT-compiled by tsdown)

OpenClaw's built-in extensions ship `.ts` source and tsdown handles
compilation. Standalone npm installs ship `dist/` because npm consumers
can't run TS source directly.

### F. Build tooling
- Standalone: tsup
- Upstream: tsdown (Rolldown-based)

Source must compile under both. The `tsc-only` portability check in CI
(`pnpm run build:tsc`) is our guard against drift — if `tsc` alone can
emit working JS, tsdown can too.

### G. Lint/format
- Standalone: oxlint config (placeholder, light rules — see `.oxlintrc.json`)
- Upstream: OpenClaw's `oxlintrc.json` and `oxfmtrc.jsonc` apply

We pre-align by using oxc (oxlint + oxfmt) so the move costs nothing.

### H. Files that DO NOT travel upstream
- `tsup.config.ts` — replaced by their tsdown config
- `scripts/strip-publish-fields.mjs`, `scripts/fix-cjs-extensions.mjs`,
  `scripts/emit-manifest-schema.mjs` — needed for our standalone npm
  publishing flow, not for built-in extensions
- `tests/smoke.live.test.ts` — our QA harness; OpenClaw maintains their own
- `.github/workflows/*.yml` — OpenClaw's CI takes over
- `RUNBOOK.md`, `SECURITY.md` — replaced by their root-level equivalents
- `README.md` — replaced by their docs site entry at `<openclaw-root>/docs/channels/agentchat.mdx`
- This `UPSTREAM_NOTES.md` — its purpose ends at the moment of the PR

### I. Files that DO travel upstream
- `src/**` (entire directory)
- `index.ts`, `setup-entry.ts`, `configured-state.ts` (if hoisted to package
  root in a future flat-layout change — currently inside `src/`)
- `openclaw.plugin.json`
- `icon.svg`
- `package.json` (with name/version/repository/scripts adjusted by OpenClaw)
- `tsconfig.json` (probably replaced; theirs is layered: `tsconfig.json`
  extends `tsconfig.extensions.json`)
- `LICENSE` (no-op — same MIT)
- `skills/agentchat/SKILL.md` → moves to `<openclaw-root>/skills/agentchat/`

---

## The PR shape, when the time comes

Roughly this sequence:

1. Open an issue on `openclaw/openclaw` proposing AgentChat as a first-party
   channel. Link to ClawHub install metrics, this repo, the docs.
2. Wait for maintainer interest signal. Frank Yang triages channels per
   their CONTRIBUTING.md.
3. Branch from `openclaw/openclaw` `main`.
4. Create `extensions/agentchat/` and copy our `src/` contents (or hoisted
   root files if we've done the flat-layout pass) plus `openclaw.plugin.json`
   and `icon.svg`.
5. Adapt `package.json` to OpenClaw's built-in conventions: `@openclaw/agentchat`,
   CalVer, `"private": true` (or not — Discord isn't private), workspace
   resolution for `@openclaw/plugin-sdk`.
6. Move `skills/agentchat/` to OpenClaw's root-level `skills/` dir.
7. Update OpenClaw's docs (`docs/channels/agentchat.mdx`) — content lifts
   mostly from this repo's README.
8. Adapt manifest paths to point at `.ts` source instead of `dist/*.js`.
9. Strip our publish-flow scripts and CI workflows.
10. Run their `pnpm install`, `pnpm build`, `pnpm test` — verify our extension
    builds inside their workspace.
11. Open the PR.

Estimated time at PR moment: half a day to a day of focused work, assuming
the upstream-readiness items above stay aligned. Without these notes, the
same PR would take a week of unwinding accumulated drift.

---

## Maintenance

When OpenClaw's plugin SDK ships a breaking change, three things happen:

1. We bump our `peerDependencies.openclaw` minimum to the new floor.
2. We test against the new version via the `peer-deps-matrix` CI job.
3. If the change affects our `*-api.ts` contracts, we update them and ship
   a new standalone version.

When OpenClaw's conventions evolve (new bundler, new lint rules, new
manifest fields), update this file in the same commit that adopts the
change. The list of "pre-aligned" items above is load-bearing — let it
go stale and the upstream PR gets harder.
