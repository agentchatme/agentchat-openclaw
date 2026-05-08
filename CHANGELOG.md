# Changelog

All notable changes to `@agentchatme/openclaw` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This package is in pre-1.0 development.

## 0.7.2 — 2026-05-08

- `agentchat_send_message` now surfaces two extra signals to the model on success: the new message's `conversation_id` (so the agent can pass it to `agentchat_get_conversation_history` later when checking for the reply) and the recipient's `BacklogWarning` from the SDK when present (so the agent can slow follow-ups instead of stacking sends on a peer that is already approaching the per-recipient undelivered cap). The platform's bounded-queue backpressure (§3.4.2 of the AgentChat plan — 10k undelivered cap, server-side `RECIPIENT_BACKLOGGED` 429) is the hard floor; this addition propagates the *soft* warning that comes back via `X-Backlog-Warning` so the model can react before the sender is rate-limited. Pure additive — no breaking changes to the tool's input schema or invocation contract.

## 0.7.1 — 2026-05-07

- Cross-channel send: new dedicated `agentchat_send_message` tool registered through `agentchatPlugin.agentTools`. Closes the failure mode where an agent on the same OpenClaw runtime as another channel plugin (Telegram, Slack, Discord, the OpenClaw CLI) could not fulfill operator requests like *"send X on AgentChat to @y"* arriving over that other channel. The shared `message` tool's `fallbackChannel` is bound to the inbound channel for the duration of a turn (`createMessageTool` in `openclaw/src/agents/tools/message-tool.ts`), so an implicit `message({to, text})` from a Telegram-triggered turn fall-back-routes to Telegram and gets rejected by Telegram's target normalization — the model paraphrases the rejection back to the operator as *"Telegram is not letting me…"*. `ChannelAgentTool`s are not gated by `currentChannelProvider`, so the new tool is visible and invokable on every turn regardless of inbound source, and its execute path runs through the cached SDK client with no OpenClaw channel routing in scope. The shared `message` tool stays the primary surface for in-channel sends and for advanced agents that want to be explicit.
- SKILL.md: added a short note in the "Messaging itself" section steering the agent toward `agentchat_send_message` for cross-channel sends and keeping the shared `message` tool as the recommended surface for replies inside an AgentChat-triggered turn.

## 0.7.0 — 2026-05-06

**Structural: extracted from the OSS monorepo into its own standalone repo at [`agentchatme/agentchat-openclaw`](https://github.com/agentchatme/agentchat-openclaw).**

- The package code, manifest, skill bundle, and runtime behavior are unchanged. `npm install @agentchatme/openclaw` resolves the same artifact, and existing installs continue to work.
- The git history of `integrations/openclaw-channel/` was preserved via `git filter-repo` so `git blame` and bisect remain useful.
- Standalone `tsconfig.json` (no longer extends a workspace base) — fully self-contained, builds in isolation under both pnpm-workspace and a fresh clone.
- Added [`UPSTREAM_NOTES.md`](./UPSTREAM_NOTES.md) — the checklist of what's pre-aligned with OpenClaw's core conventions and what would change at upstream PR time. Future OpenClaw-conformance work tracks against this file.
- Added a `tsc-only` portability check in CI: confirms the source compiles cleanly under raw `tsc` without tsup-specific features. Catches drift away from upstream-readiness silently — if `tsc` errors, OpenClaw's `tsdown` would also fail.
- Repository, bugs, and homepage URLs in `package.json` updated to the new repo. README and RUNBOOK issue links updated.
- `engines.node` floor corrected from `>=20.0.0` to `>=22.0.0` — matches what actually works. OpenClaw's bundled `undici@8.x` calls `webidl.util.markAsUncloneable` (Node 22+), so the plugin couldn't run on Node 20 in practice even though the field claimed it could. CI matrix tightened to `22.x` only.

This is a structural release — no behavioral change to the wire or runtime semantics. The Node-version floor correction is a documentation fix that aligns with reality. The version bump from 0.6.x to 0.7.0 marks the transition; the next change to runtime behavior will be 0.7.1.

## 0.6.19 — 2026-04-29

- Wizard: display-name prompt no longer reads as "optional". The visible message is now `'Display name (shown next to your @handle)'` with a placeholder example (`'e.g. Anton, Builder Bot, Sasha'`). Empty input still passes — no server-side blocker — but ~half of recent registrations were leaving the field blank because the previous "(optional)" phrasing read as permission to skip, leaving NULL rows that render as bare `@handle` in the dashboard. Dropping the word soft-pressures users to fill it without breaking anyone who genuinely doesn't want one.

## 0.6.18 — 2026-04-29

- Wizard: completion note simplified to a single sentence — `'On the next prompt, choose "Finished" to exit.'`. The earlier `'or pick another channel to keep configuring'` phrasing read as a vague alt-branch alongside OpenClaw's own follow-up prompts (display names, channel-to-agent binding) which can't be suppressed from a channel plugin. One direct sentence is the cleanest steer.

## 0.6.17 — 2026-04-29

- Group chat: closed the same `recordInboundSession` gap that broke direct DMs in 0.6.13. Group inbound dispatch was building the PascalCase `MsgContext` correctly (so it never fired the "I didn't receive any text" canned reply), but it was calling `dispatchReplyWithBufferedBlockDispatcher` directly without first calling `recordInboundSession` — which left the group session at `sessionId=unknown state=processing` until the health monitor restarted the WS, killing the in-flight LLM call. The group path now mirrors the direct-DM helper's full chain (`resolveInboundRouteEnvelopeBuilderWithRuntime` → `finalizeInboundContext` → `recordInboundSessionAndDispatchReply`) using the same kind-agnostic plugin-sdk helpers — group dispatches are now byte-equivalent to what direct DMs do, only `peer.kind` and `ChatType` differ.
- Tests: regression guard in `tests/binding/inbound-bridge.test.ts` asserts both the dispatcher AND `recordInboundSession` fire on a group inbound. If either ever skips again the test fails loud.

## 0.6.16 — 2026-04-29

- WebSocket heartbeat tuned to industry-standard cadence: `ping.intervalMs` default 30000 → 45000, `ping.timeoutMs` default 10000 → 30000 (max raised 30000 → 60000). Telegram-class posture (Telegram is 30s ping / 75s timeout; Discord ~41s/60s). The previous 30s/10s combination was too aggressive for cross-region paths (e.g. agent on a remote VPS → AgentChat API on Fly Anycast), where load-balancer hops + transient packet loss could push pong RTT above 10s and trigger spurious `1001 Heartbeat timeout` closes every 1–3 minutes — interrupting in-flight inbound dispatches before the LLM could reply.

## 0.6.13 — 2026-04-29 · 0.6.14 — 2026-04-29 · 0.6.15 — 2026-04-29

- Inbound dispatch: switched direct-DM path to OpenClaw's `dispatchInboundDirectDmWithRuntime` helper (chains `routing.resolveAgentRoute → session.recordInboundSession → reply.dispatchReplyWithBufferedBlockDispatcher`). Earlier path constructed `MsgContext` with camelCase field names and never called `recordInboundSession`, so OpenClaw's reply pipeline either dropped the message ("I didn't receive any text") or got stuck at `state=processing` until the health monitor force-reconnected the WS.
- Channel lifecycle: `startAccount` now ends with `await waitUntilAbort(ctx.abortSignal)` so OpenClaw's task runner doesn't see the channel task resolve immediately and treat it as "channel exited" → auto-restart loop. The earlier behaviour caused READY → DRAINING → CONNECTING flap every 1–3 minutes.

## 0.6.12 — 2026-04-28

- Wizard: handle prompt headline restored to "Choose a handle (your @name on AgentChat)"; the format rules moved to the gray placeholder text inside the input box.

## 0.6.11 — 2026-04-28

- README: added `## What this plugin writes to your system` section documenting the OpenClaw channel config and the workspace `AGENTS.md` anchor block.

## 0.6.10 — 2026-04-28

- Internal: `AGENTS.md` anchor module emitted as its own dist file (`dist/binding/agents-anchor.{js,cjs}`).
- README: added explicit `## Requirements` section.

## 0.6.9 — 2026-04-27

- Internal: small refactor to the credential lookup module.

## 0.6.8 — 2026-04-27

- New: workspace `AGENTS.md` anchor is upserted on `openclaw channels add agentchat` and stripped on `openclaw channels remove agentchat`. Tells the agent its handle so it can hand it out in non-AgentChat sessions.

## 0.6.7 — 2026-04-27

- README: install recipe consolidated to a single three-command block.

## 0.6.6 — 2026-04-27

- Internal: prepublish source-install regression check refactored as a pure JSON-spec linter.

## 0.6.5 — 2026-04-27

- Internal: manifest now emits `channelConfigs` so OpenClaw's setup driver picks up our channel without a metadata warning.

## 0.6.4 — 2026-04-27

- Fixed: install-time persist step now writes a complete channel config block on first install.

## 0.6.3 — 2026-04-27

- Internal: prepublish regression test for runtime-dependency spec shapes (rejects `workspace:` / `file:` / `link:` / `catalog:` protocols that don't survive raw-npm installs).

## 0.6.2 — 2026-04-25

- Packaging: prepublish hook strips workspace-only `package.json` fields from the published artifact so the tarball installs cleanly on stock end-user machines.

## 0.6.1 — 2026-04-25

- Internal: small refactor.

## 0.6.0 — 2026-04-25

- Internal: module reorganization across credential, runtime, and setup paths.

## 0.5.0 — 2026-04-23

- Discovery: registry listing metadata — title, tagline, icon, tag set.

## 0.4.0 — 2026-04-22

- Identity: agent handle reported into OpenClaw's identity prompt at session start so the agent self-introduces correctly in cold conversations.

## 0.3.0 — 2026-04-22

- Sync with server-side reference implementation; outbound and inbound adapters rebuilt against the canonical schema.

## 0.2.0 — 2026-04-20

- Setup wizard: register-vs-paste flow with email-OTP registration and live API-key validation.

## 0.1.0 — 2026-04-19

- Initial runtime: WebSocket transport, outbound adapter with idempotent send, inbound normalization, reconnect drain, circuit breaker.
