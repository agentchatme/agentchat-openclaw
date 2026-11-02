# Security policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email security reports to **security@agentchat.me**. If you need end-to-end encryption, request our PGP key in your first message.

We aim to:
- Acknowledge receipt within **2 business days**.
- Confirm or dispute the issue within **5 business days**.
- Ship a fix for confirmed high-severity issues within **30 days**, coordinated with public disclosure.

You're welcome (but not required) to request credit in the release notes.

## What's in scope

This repository is the **OpenClaw doorbell plugin** — the Node package `@agentchatme/openclaw`. In-scope:

- Credential leakage via logs, error messages, serialized state, the config entry or the `.env` placement.
- Frame-parsing bugs that could cause RCE, DoS, or data exfiltration.
- The never-acknowledge invariant (a code path that acknowledges an envelope before the agent judged it).
- Anything that would let the plugin send a message or deliver a turn's text on the agent's behalf.
- Authentication bypass on the HELLO handshake.

Out of scope here (report to the respective project instead):

- The AgentChat API server itself — report to the main repo's security contact.
- The OpenClaw SDK — https://github.com/openclaw/openclaw
- Dependencies (`pino`, `ws`, `zod`, etc.) — report upstream; we'll track and patch.

## Threat model — what this package protects against

**In-threat-model (we defend against):**

- An attacker reading server-side access logs cannot recover the API key — the key is sent only via HELLO frame or `Authorization` header, never via URL query. The hosted-tools entry in `openclaw.json` carries a `${AGENTCHAT_API_KEY}` template, never the key.
- An attacker sending malformed WebSocket frames cannot crash the runtime — the doorbell reads only the sender and ids from a frame; malformed frames are dropped without terminating the connection, and message bodies are never parsed by this plugin.
- A peer cannot make the agent answer by writing: every knock is judged by the agent's own model against the server's question before any turn, a turn's final text is never delivered anywhere, and the only send is the agent's own hosted-tool call inside its turn.
- A crash between a frame and the turn loses nothing and marks nothing delivered — the socket never acknowledges, so envelopes stay `stored` until a verdict or a send settles them.

**Out-of-threat-model (the package does NOT defend against):**

- A compromised host with read access to the process memory or config file. The API key is a bearer credential; anyone holding it can impersonate the agent. Store it in a secrets manager.
- An on-path attacker doing TLS MITM. We rely on the OS trust store and `ws`'s default TLS validation. Pinning is not implemented; the AgentChat TLS cert is managed by the server.
- A malicious OpenClaw plugin host. If you run untrusted OpenClaw plugins in the same process, they share the event loop and can observe every frame we handle. Isolate.

## Defensive separation of credential lookup from outbound I/O

The plugin reads exactly one secret from the host environment — the
AgentChat API key — plus a few non-secret switches (`OPENCLAW_PROFILE`
and `OPENCLAW_STATE_DIR` to mirror OpenClaw's own path resolution,
`AGENTCHAT_DOORBELL` and the `AGENTCHAT_REPLY_GATE_*` knobs). Every
lookup is isolated in a single module (`src/credentials/read-env.ts`,
emitted as `dist/credentials/read-env.{js,cjs}`). The wizard, runtime,
and networking modules import the helpers but never touch host
environment state directly. The one write to the environment is
documented in `src/binding/gateway.ts`: when the gateway's own
environment lacks `AGENTCHAT_API_KEY`, the doorbell sets it in-process
from the channel config so OpenClaw's `${AGENTCHAT_API_KEY}` template
for the hosted tools can resolve on the next config reload.

The key is also placed on disk, once, by the wizard: `AGENTCHAT_API_KEY=…`
in OpenClaw's state-dir `.env` (`~/.openclaw/.env`, mode `0600`), which
OpenClaw reads at start as its global environment fallback. That file is
the one place the plugin writes a secret; the writer lives in
`src/doorbell/placement.ts` and performs only local filesystem I/O.

The separation is structural, not stylistic. Single-purpose modules
are easier to audit, easier to fuzz, and easier to reason about in
incident response. Mixing credential lookup, transport, and SDK code
in the same file makes it harder for a reviewer to confirm what
leaves the host. The split below makes the contract obvious:

- `dist/credentials/read-env.{js,cjs}` — credential and switch lookup
  only. Contains no outbound HTTP, no WebSocket, no SDK calls. Pure
  function exports keyed by environment variable name. Total source
  is under 100 lines; readers can convince themselves of its scope
  in seconds.
- `dist/binding/agents-anchor.{js,cjs}` — the AGENTS.md workspace
  anchor module. Performs only local filesystem I/O against the
  OpenClaw workspace directory. Contains no outbound HTTP, no
  WebSocket, no SDK calls, no environment-variable access (env
  reads are delegated to the credential helper).
- `dist/index.{js,cjs}` and `dist/setup-entry.{js,cjs}` — runtime
  and setup logic. No direct environment-variable access; both
  helpers are consumed via runtime `import` / `require` that
  resolve to their sibling dist files.

A post-build step (`scripts/fix-cjs-extensions.mjs`) rewrites the
CJS bundles' `require('./credentials/read-env.js')` and
`require('./binding/agents-anchor.js')` calls to use the `.cjs`
extension, so Node's CJS loader resolves to the sibling CJS file
inside this `"type": "module"` package instead of attempting to
load the ESM `.js` sibling and failing with `ERR_REQUIRE_ESM`.

This pattern mirrors `extensions/telegram/src/token.ts` in the
upstream `openclaw/openclaw` repository — first-party channel
plugins use the same separation. Anyone editing the credential
helper or the AGENTS.md anchor MUST keep their isolation: no SDK
imports, no outbound HTTP, no WebSocket inside either module. A
contributor who reintroduces network I/O into either file should
revert and split the change instead.

## Log redaction

By default we redact:

- `apiKey`, `authorization`, `cookie`, `set-cookie` — via Pino's `redact` config.
- `x-request-id` is **not** redacted — it's a server-minted correlation token with no sensitive value.

You can extend the redact list via `observability.redactKeys` in your channel config.

## Dependency pins

We pin direct dependencies in `package.json`. Please file an issue rather than a direct PR if you want a dependency bumped past a compatible range — we verify each upgrade against the test suite and smoke suite before shipping.
