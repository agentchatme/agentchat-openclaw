/**
 * The reply gate — a forced reply / no-reply decision before the agent composes.
 *
 * Ported from the Hermes plugin's `reply_gate.py`. This module is the **pure**
 * decision core: it derives compact conversation signals, builds the decision
 * prompt, and parses the model's verdict. It performs no IO and imports nothing
 * from the OpenClaw runtime, so it is fully unit-testable in isolation.
 *
 * The LLM call that consumes `buildDecisionMessages(...)` runs on the agent's
 * OWN configured model (via OpenClaw's simple-completion runtime) and lives in
 * the invoker integration — not here.
 *
 * Why this exists
 * ───────────────
 * An agent woken by an inbound message tends to produce a reply every single
 * time — it is the path of least resistance. Two agents doing that to each
 * other never stop: a loop of acknowledgements that each, in isolation, looks
 * reasonable. The gate removes the default. Before any composing happens, the
 * model is handed the message plus recent context and asked to emit ONE thing:
 * `reply` or `no_reply`. It cannot write a reply here; the only way to act is to
 * choose. The criterion is done-ness — "is there an actual open request, or is
 * this finished?" — never "could I say something" (the answer to that is always
 * yes, which is what feeds the loop).
 */

// ─── Tunables ──────────────────────────────────────────────────────────────

/** Output-token ceiling for the decision. It is a tiny JSON object. */
export const DEFAULT_GATE_MAX_TOKENS = 256

/**
 * How many of the most-recent rehydrated turns to show the gate. Done-ness is a
 * function of the recent shape of the conversation, not its whole history.
 */
export const MAX_HISTORY_TURNS = 12

/**
 * Cadence window (seconds) — "how many messages in the last minute". Tight on
 * purpose: the loop is a rapid-fire phenomenon, so a short window distinguishes
 * a live volley from a normally paced exchange.
 */
export const CADENCE_WINDOW_SECONDS = 60

/**
 * Categories the model may return. Anything else is normalised to `other`. The
 * internal `fallback` source is set by code directly and intentionally not in
 * this set.
 */
export const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  'open_request',
  'new_info',
  'goal_followup',
  'closing',
  'acknowledgement',
  'not_addressed',
  'no_action_needed',
  'spam',
  'other',
])

const REPLY_TOKENS: ReadonlySet<string> = new Set(['reply', 'yes', 'true', 'respond'])
const NO_REPLY_TOKENS: ReadonlySet<string> = new Set([
  'no_reply',
  'no-reply',
  'noreply',
  'no',
  'false',
  'silent',
  'skip',
  'none',
])

// Matches a ```json … ``` (or bare ``` … ```) fenced block; `[\s\S]` stands in
// for the DOTALL flag so the body can span newlines.
const FENCE_RE = /```(?:json)?\s*([\s\S]+?)```/i

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * The gate's verdict for one inbound message. `source` records HOW the verdict
 * was reached so the decision log can be audited and the gate calibrated:
 *   - `"llm"`         — the model decided.
 *   - `"fail_open"`   — the call failed / returned garbage; fail-open applied.
 *   - `"fail_closed"` — same, but fail-closed (stay silent) was configured.
 */
export interface GateDecision {
  readonly reply: boolean
  readonly reason: string
  readonly category: string
  readonly source: 'llm' | 'fail_open' | 'fail_closed'
  readonly latencyMs: number
}

/**
 * Compact, deterministic context derived from the thread already in hand. No
 * network call and no server-side interpretation — every field comes from the
 * recent messages the caller already fetched plus the inbound message's own
 * timestamp. Rendered into short phrases for the prompt (never raw dumps), so
 * the per-message cost stays bounded.
 */
export interface ConversationSignals {
  /** No prior messages in this thread (a fresh opener). */
  readonly firstContact: boolean
  /** This agent already replied in the window (established two-way thread). */
  readonly youHaveSpoken: boolean
  /** Messages incl. the new one within {@link CADENCE_WINDOW_SECONDS}; a high count is the loop's tempo. */
  readonly messagesLastWindow: number
  /** Gap from the previous message to this one (seconds), or `null` when no usable prior timestamp. */
  readonly secondsSincePrevious: number | null
}

/** The minimum the gate needs to know about the triggering message. */
export interface GateInboundEvent {
  readonly conversationKind: 'direct' | 'group'
  readonly senderHandle: string
  readonly contentText: string
  /** Group's human-readable name (server-resolved) — names the room instead of
   *  an opaque id. Optional so callers predating the context block still work. */
  readonly groupName?: string | null
  readonly memberCount?: number | null
  /** Handles @-mentioned, parsed server-side. The recipient tests its OWN
   *  handle for membership (never a raw substring of the text). */
  readonly mentions?: readonly string[]
}

/** A rehydrated conversation turn (OpenAI-style). */
export interface HistoryTurn {
  readonly role: string
  readonly content: string
}

/**
 * Raw AgentChat message row (as returned by `getMessages`), read defensively.
 * We only touch the few fields the signals need.
 */
export interface GateRawMessage {
  readonly id?: string
  readonly created_at?: unknown
  readonly is_own?: unknown
  readonly sender?: unknown
  readonly from?: unknown
  readonly sender_handle?: unknown
  readonly [key: string]: unknown
}

export interface DecisionMessage {
  readonly role: 'system' | 'user'
  readonly content: string
}

// ─── Signal derivation ──────────────────────────────────────────────────

/**
 * Derive {@link ConversationSignals} from the recent raw messages. Pure and
 * defensive: tolerates missing/malformed timestamps and non-object rows. The
 * triggering message is excluded so "now" is not double-counted.
 */
export function computeConversationSignals(
  messages: readonly GateRawMessage[],
  params: {
    ownHandle: string
    triggerMessageId: string
    nowMs: number
    windowSeconds?: number
  },
): ConversationSignals {
  const windowSeconds = params.windowSeconds ?? CADENCE_WINDOW_SECONDS
  const own = normalizeHandle(params.ownHandle)

  const prior = messages.filter(
    (m): m is GateRawMessage =>
      isRecord(m) && m.id !== params.triggerMessageId,
  )
  const firstContact = prior.length === 0
  const youHaveSpoken = prior.some((m) => messageIsOwn(m, own))

  const timestamps: number[] = []
  for (const m of prior) {
    const ts = parseTimestamp(m.created_at)
    if (ts !== null) timestamps.push(ts)
  }

  const cutoff = params.nowMs - windowSeconds * 1000
  const recentInWindow = timestamps.filter((ts) => ts >= cutoff).length

  let secondsSincePrevious: number | null = null
  if (timestamps.length > 0) {
    const delta = (params.nowMs - Math.max(...timestamps)) / 1000
    secondsSincePrevious = delta > 0 ? delta : 0 // clamp clock skew
  }

  return {
    firstContact,
    youHaveSpoken,
    messagesLastWindow: recentInWindow + 1, // +1 for the new message
    secondsSincePrevious,
  }
}

function messageIsOwn(msg: GateRawMessage, ownHandleNorm: string): boolean {
  // Trust a server-precomputed `is_own`; otherwise compare sender handles.
  if (typeof msg.is_own === 'boolean') return msg.is_own
  const sender = msg.sender ?? msg.from ?? msg.sender_handle ?? ''
  return normalizeHandle(String(sender)) === ownHandleNorm
}

/** Parse an ISO-8601 `created_at` to epoch millis, or `null` when unusable. */
function parseTimestamp(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) return null
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : t
}

function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, '').toLowerCase()
}

function isRecord(value: unknown): value is GateRawMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ─── Prompt construction ────────────────────────────────────────────────

/**
 * The done-ness criterion. This framing is the load-bearing part — it is the
 * intervention the Hermes loop-sim validated (arm `two_gate`), and its rules
 * exist because softer framings measurably fail:
 *
 * - Judge DONE-NESS, never value. "Would a reply be valuable?" always answers
 *   yes to a model — every riff feels valuable — which is precisely what feeds
 *   the exploration/"riffing" loop the ack-rules alone cannot stop.
 * - Silence is success. Without this, the model's built-in continuation bias
 *   treats no_reply as a failure state and avoids it.
 * - A reciprocal courtesy question is part of the pleasantry, not an open
 *   task. Two polite agents each end every turn with "and you?" — a literal
 *   "unanswered question directed at you" — and interview each other forever.
 *   This was the exact hole we watched live: every gate call scored
 *   open_request and the thread never terminated.
 */
function systemTemplate(handle: string): string {
  const h = `@${handle}`
  return (
    `You are the reply gate for ${h}, an autonomous agent on AgentChat ` +
    `(a peer-to-peer messaging network for AI agents). A message just arrived. ` +
    `Your only job is to decide whether ${h} should reply to it now. You ` +
    `do NOT write the reply — you output one decision.\n` +
    `\n` +
    `"no_reply" is a SUCCESS, not a failure. Most healthy conversations are ` +
    `SUPPOSED to end; going quiet is the normal, correct outcome and is never ` +
    `rude here — on this network silence IS the acknowledgement.\n` +
    `\n` +
    `Judge DONE-NESS, not how interesting another message could be:\n` +
    `\n` +
    `Choose "reply" only if a further message accomplishes a concrete, ` +
    `still-OPEN purpose:\n` +
    `- answer a substantive pending question or supply specifically requested ` +
    `information\n` +
    `- make or respond to a decision, or unblock the peer on a real task\n` +
    `- ${h} started this thread toward a goal and the peer's reply needs a ` +
    `substantive follow-up to reach it\n` +
    `- new information genuinely requires ${h}'s input\n` +
    `\n` +
    `Choose "no_reply" when the exchange has reached its natural end — even if ` +
    `another clever or friendly message is easily possible:\n` +
    `- it is trading pleasantries, mutual appreciation, agreement, or ` +
    `open-ended tangents / "riffing" with no open objective\n` +
    `- a courtesy question that merely mirrors the exchange back ("and you?", ` +
    `"what are you working on?", "what tools are you using?") after the ` +
    `substantive part has run its course is part of the pleasantry, not an ` +
    `open task — it does not oblige a reply\n` +
    `- the other side is acknowledging or closing out (thanks / ok / got it / ` +
    `sounds good / 👍 / bye) and replying would only prolong it\n` +
    `- ${h} already answered what was asked and nothing new is on the table\n` +
    `- in a group, the message is not addressed to ${h} and does not need it. ` +
    `(Groups only — in a direct conversation every message is addressed to ` +
    `${h} by definition, so "not_addressed" never applies there.)\n` +
    `\n` +
    `"I could add something" is NOT a reason to reply. "Something concrete is ` +
    `unresolved and my reply resolves it" IS. Two agents keeping a chat alive ` +
    `by each politely asking the next question is the exact failure you exist ` +
    `to prevent — the thread being pleasant does not make it open. If the Pace ` +
    `line shows messages flying back and forth with each turn only restating, ` +
    `appreciating, or re-asking a mirrored question, that IS the loop — choose ` +
    `"no_reply". When unsure, prefer "no_reply".\n` +
    `\n` +
    `Respond with ONLY a JSON object — no prose, no markdown fences:\n` +
    `{"decision": "reply" or "no_reply", "reason": "<one short sentence>", ` +
    `"category": "<one of: open_request, new_info, goal_followup, closing, ` +
    `acknowledgement, not_addressed, no_action_needed, spam, other>"}`
  )
}

/**
 * Build the OpenAI-style messages for the decision call. Pure — no SDK, no
 * runtime, no IO. The system message carries the done-ness criterion; the user
 * message carries the signals (relationship, pace, turn depth, group-addressing)
 * plus the recent conversation and the new message.
 */
export function buildDecisionMessages(params: {
  handle: string
  event: GateInboundEvent
  history: readonly HistoryTurn[]
  signals?: ConversationSignals | null
  maxHistory?: number
}): DecisionMessage[] {
  return [
    { role: 'system', content: systemTemplate(params.handle) },
    {
      role: 'user',
      content: buildUserContent({
        handle: params.handle,
        event: params.event,
        history: params.history,
        signals: params.signals ?? null,
        maxHistory: params.maxHistory ?? MAX_HISTORY_TURNS,
      }),
    },
  ]
}

/**
 * Render a message's arrival time as an unambiguous absolute UTC stamp,
 * e.g. `2026-07-24 14:57 UTC`.
 *
 * Agents have no clock of their own. The gate reasons in *relative* pace
 * (`formatGap`), but the composing turn also needs the *absolute* time to judge
 * staleness and business-hours context, so it is surfaced alongside the pace
 * signal in the compose turn. `ms` is epoch milliseconds (the inbound's
 * `createdAt`/`receivedAt`).
 */
export function formatReceivedAt(ms: number): string {
  if (!Number.isFinite(ms)) return 'an unknown time'
  const iso = new Date(ms).toISOString() // e.g. 2026-07-24T14:57:10.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/**
 * The compact conversation-context header — type, relationship, pace, turn
 * depth, and group-addressing — derived purely from signals already in hand.
 *
 * Shared VERBATIM by the reply-gate's decision prompt (`buildUserContent`) and
 * the compose turn (`inbound-bridge`), so the model that WRITES the reply sees
 * the same signals the gate judged on instead of a decontextualised one-liner.
 * Pure. The absolute arrival time is added by the compose turn on top of these
 * lines (via `formatReceivedAt`) — it is not part of the gate's tuned prompt.
 */
export function formatConversationContext(params: {
  handle: string
  event: GateInboundEvent
  signals: ConversationSignals | null
  priorCount: number
}): string[] {
  const { handle, event, signals, priorCount } = params
  const lines: string[] = [`Conversation type: ${formatConversationLabel(event)}`]

  if (signals) {
    lines.push(`Relationship: ${relationshipPhrase(signals)}`)
    if (signals.secondsSincePrevious !== null) {
      lines.push(
        `Pace: ${signals.messagesLastWindow} message(s) in the last ` +
          `${CADENCE_WINDOW_SECONDS}s; ` +
          `${formatGap(signals.secondsSincePrevious)} since the previous message`,
      )
    }
  }

  lines.push(`Prior messages in this thread: ${priorCount}`)

  // Mention: state the positive fact ONLY when true. A "not mentioned" line is
  // deliberately omitted — negative framing biases some models toward silence
  // and others toward noise, so we drop the confusion entirely (a DM, where you
  // are always the addressee, carries no such line either). Membership is
  // tested against the server's word-boundary-parsed list, never a raw substring.
  if (
    event.conversationKind === 'group' &&
    handle &&
    (event.mentions ?? []).includes(handle.toLowerCase())
  ) {
    lines.push('You were @-mentioned in this message.')
  }

  return lines
}

/** The room label: "direct", or a named group ("group \"Ops\" (5 members)"),
 *  falling back to a bare "group" when the server supplied no name. Shared by
 *  the gate header and the compose turn's gate-disabled fallback. */
export function formatConversationLabel(event: GateInboundEvent): string {
  if (event.conversationKind !== 'group') return 'direct'
  let label = event.groupName ? `group "${event.groupName}"` : 'group'
  if (event.memberCount != null) {
    label += ` (${event.memberCount} member${event.memberCount === 1 ? '' : 's'})`
  }
  return label
}

function buildUserContent(params: {
  handle: string
  event: GateInboundEvent
  history: readonly HistoryTurn[]
  signals: ConversationSignals | null
  maxHistory: number
}): string {
  const { handle, event, history, signals, maxHistory } = params
  const lines: string[] = formatConversationContext({
    handle,
    event,
    signals,
    priorCount: history.length,
  })

  lines.push('')
  const rendered = renderHistory(history, maxHistory)
  if (rendered.length > 0) {
    lines.push('Recent conversation (oldest first):')
    lines.push(...rendered)
  } else {
    lines.push('Recent conversation: (none — this is first contact)')
  }

  let newText = collapseWhitespace(event.contentText || '')
  if (newText.length > 2000) newText = `${newText.slice(0, 2000)}…`
  lines.push('')
  lines.push(`New message from @${event.senderHandle}: ${newText}`)
  lines.push('')
  lines.push('Decide now: reply or no_reply?')
  return lines.join('\n')
}

function renderHistory(
  history: readonly HistoryTurn[],
  maxHistory: number,
): string[] {
  const recent =
    history.length > maxHistory ? history.slice(history.length - maxHistory) : history
  const out: string[] = []
  for (const turn of recent) {
    if (typeof turn.content !== 'string' || !turn.content.trim()) continue
    const speaker = turn.role === 'assistant' ? 'you' : 'peer'
    let text = collapseWhitespace(turn.content)
    if (text.length > 400) text = `${text.slice(0, 400)}…`
    out.push(`${speaker}: ${text}`)
  }
  return out
}

function relationshipPhrase(signals: ConversationSignals): string {
  if (signals.firstContact) return 'first contact — no prior messages in this thread'
  if (signals.youHaveSpoken) return 'established — you have already replied in this thread'
  return 'this peer is messaging you, but you have not replied yet'
}

/** Humanise a seconds gap into a compact token (`8s` / `3m` / `2h`). */
function formatGap(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

function collapseWhitespace(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ')
}

// ─── Response parsing ───────────────────────────────────────────────────

/**
 * Parse the model's JSON decision. Returns `null` when unusable — the caller
 * then applies its fail-open / fail-closed policy. Tolerant of the usual model
 * noise: surrounding prose, ```json fences, case, and reply/no_reply synonyms.
 */
export function parseDecision(
  text: string | null | undefined,
  opts: { source?: GateDecision['source']; latencyMs?: number } = {},
): GateDecision | null {
  const raw = extractJson(text)
  if (raw === null) return null

  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(obj)) return null

  const decisionRaw = obj.decision
  if (typeof decisionRaw !== 'string') return null
  const token = decisionRaw.trim().toLowerCase()
  let reply: boolean
  if (REPLY_TOKENS.has(token)) reply = true
  else if (NO_REPLY_TOKENS.has(token)) reply = false
  else return null

  const reasonRaw = obj.reason
  let reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : ''
  if (reason.length > 280) reason = reason.slice(0, 280)

  const categoryRaw = obj.category
  let category =
    typeof categoryRaw === 'string' ? categoryRaw.trim().toLowerCase() : 'other'
  if (!VALID_CATEGORIES.has(category)) category = 'other'

  return {
    reply,
    reason,
    category,
    source: opts.source ?? 'llm',
    latencyMs: opts.latencyMs ?? 0,
  }
}

/** Pull the outermost JSON object out of model output. `null` if none. */
function extractJson(text: string | null | undefined): string | null {
  if (!text || !text.trim()) return null
  let s = text.trim()
  const fence = FENCE_RE.exec(s)
  if (fence?.[1]) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return s.slice(start, end + 1)
}

/** Build the fallback verdict applied when the decision call cannot be used. */
export function gateFallback(
  failOpen: boolean,
  reason: string,
  latencyMs: number,
): GateDecision {
  return {
    reply: failOpen,
    reason,
    category: 'fallback',
    source: failOpen ? 'fail_open' : 'fail_closed',
    latencyMs,
  }
}
