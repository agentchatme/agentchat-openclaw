/**
 * The gate step: the agent's own model answers the server's question about the server's cards.
 *
 * Code we keep, brain we don't
 * ────────────────────────────
 * Every word the model reads here comes from the main line: the gate question
 * (`tray.question`) and the briefing cards (`tray.conversations`) are passed
 * through exactly as `GET /v1/inbox` returned them. This module adds a
 * two-line wrapper asking for strict JSON, parses the answer, and records the
 * verdicts with `POST /v1/conversations/{id}/decisions`. No wording of its
 * own, no category list of its own (categories are offered only when the
 * tray carries them), no pace or relationship arithmetic — the server
 * computes, the agent's model judges, the doorbell carries.
 *
 * What gets recorded
 * ──────────────────
 * `dismiss` and `defer` are posted; a recorded verdict settles delivery for
 * what it covers, so the sender's tick is honest and the conversation leaves
 * the tray. `reply` is deliberately *not* posted: the send is the reply
 * verdict, and posting it would settle the envelopes and take the card off
 * the tray before the agent's turn has read it. Cards decided `reply` stay
 * on the tray; the turn that follows reads exactly those with the hosted
 * `agentchat_inbox` tool. A model that still answers the legacy spelling
 * `no_reply` is understood and posted as `dismiss`.
 *
 * Failure policy
 * ──────────────
 * Fail closed by default: when the model cannot be reached or answers nothing
 * usable, nothing is posted and no turn starts. The envelopes stay `stored`,
 * the tray keeps the cards, and the invoker re-knocks on its own ladder. With
 * `AGENTCHAT_REPLY_GATE_FAIL_OPEN=1` a failed gate starts the turn anyway and
 * the agent judges from the tray inside the turn.
 */

import { MainLineClient, MainLineError, type Decision, type Tray } from './main-line.js'

/** Output ceiling for the verdict JSON: a few dozen tokens per card. The tray is capped at 50 cards server-side. */
export const DEFAULT_GATE_MAX_TOKENS = 2048

export const REPLY: Decision = 'reply'
export const DISMISS: Decision = 'dismiss'
export const DEFER: Decision = 'defer'
export const DECISIONS: readonly Decision[] = [REPLY, DISMISS, DEFER]

// Tolerated spellings. Anything else leaves the card undecided.
const REPLY_TOKENS = new Set(['reply', 'respond', 'answer', 'yes', 'true'])
const DISMISS_TOKENS = new Set([
  'dismiss',
  'dismissed',
  'no_reply',
  'no-reply',
  'noreply',
  'silent',
  'silence',
  'skip',
  'ignore',
  'no',
  'false',
])
const DEFER_TOKENS = new Set(['defer', 'deferred', 'later', 'wait', 'postpone'])

const FENCE_RE = /```(?:json)?\s*([\s\S]+?)```/i

export interface Verdict {
  readonly conversationId: string
  readonly decision: Decision
  readonly category?: string | undefined
  readonly deferSeconds?: number | undefined
}

export interface GateMessages {
  readonly systemPrompt: string
  readonly userContent: string
}

/** Returns the model's raw text. Injectable so tests never reach a provider. */
export type GateCaller = (params: {
  readonly systemPrompt: string
  readonly userContent: string
  readonly maxTokens: number
  readonly timeoutMs: number
}) => Promise<string>

export type GateSource = 'llm' | 'empty' | 'fail_closed' | 'fail_open' | 'disabled'

export interface GateResult {
  /** How the cycle ended; see the module header. */
  readonly source: GateSource
  readonly cards: number
  readonly verdicts: readonly Verdict[]
  readonly undecided: readonly string[]
  readonly replyConversations: readonly string[]
  readonly posted: number
  readonly postFailures: number
  readonly truncated: boolean
  readonly latencyMs: number
  readonly failure: string | null
}

export function startTurn(result: GateResult): boolean {
  return result.replyConversations.length > 0 || result.source === 'fail_open'
}

export function countVerdicts(result: GateResult): Record<Decision, number> {
  const counts: Record<Decision, number> = { reply: 0, dismiss: 0, defer: 0 }
  for (const verdict of result.verdicts) counts[verdict.decision] += 1
  return counts
}

// ─── building the call ──────────────────────────────────────────────────

export type Card = Record<string, unknown>

/** The tray's cards, exactly as served (non-object entries dropped). */
export function cardsOf(tray: Tray): Card[] {
  const raw = tray.conversations
  if (!Array.isArray(raw)) return []
  return raw.filter((card): card is Card => Boolean(card) && typeof card === 'object' && !Array.isArray(card))
}

export function cardIds(cards: readonly Card[]): string[] {
  const out: string[] = []
  for (const card of cards) {
    const id = card.conversation_id
    if (typeof id === 'string' && id.length > 0) out.push(id)
  }
  return out
}

/**
 * The verdict categories, when the server serves them with the tray. The
 * taxonomy is the server's; until the tray carries it, verdicts are posted
 * without a category, never with a locally invented one.
 */
export function categoriesOf(tray: Tray): string[] {
  const raw = tray.categories
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/**
 * The decision call. System: the server's question, verbatim, then the
 * two-line JSON wrapper. User: the server's cards, verbatim, as JSON. Pure.
 *
 * Throws when the tray carries no question (a server contract break:
 * judging without the question is exactly the drift this design removes, so
 * the gate fails closed instead).
 */
export function buildGateMessages(tray: Tray): GateMessages {
  const question = tray.question
  if (typeof question !== 'string' || question.trim().length === 0) {
    throw new Error('tray carries no gate question')
  }
  const cards = cardsOf(tray)
  const categories = categoriesOf(tray)

  let shape =
    '{"decisions": [{"conversation_id": "<conversation_id from a card>", ' +
    '"decision": "reply" | "dismiss" | "defer"'
  if (categories.length > 0) {
    shape += `, "category": "<one of: ${categories.join(', ')}>"`
  }
  shape += ', "defer_seconds": <seconds until you look again, only with defer>}]}'

  const wrapper =
    'Answer with ONLY a JSON object, no prose and no code fences, in this shape: ' +
    shape +
    ' — one entry per card, every card decided.'

  const payload: Record<string, unknown> = {}
  if (typeof tray.you === 'string' && tray.you.length > 0) payload.you = tray.you
  payload.conversations = cards

  // Facts the server states on a card that a model skimming JSON may miss:
  // a group that no longer exists. One line per such card, after the
  // verbatim tray, so the model dismisses knowingly. Not judgement — the
  // server's own field, printed.
  const notes = cards.map(renderDeletedGroupNote).filter((note): note is string => note !== null)

  return {
    systemPrompt: `${question.trim()}\n\n${wrapper}`,
    userContent: `Your tray, as the server built it:\n${JSON.stringify(payload)}${notes.length > 0 ? `\n\n${notes.join('\n')}` : ''}`,
  }
}

export interface GroupDeletion {
  readonly at: string
  readonly by: string
}

/**
 * The card's `group.deleted` — `{ at, by }` when the group was deleted
 * (`by` is the deleting handle, with its `@`), `null` or absent otherwise.
 * Optional on purpose: older servers omit it.
 */
export function readGroupDeletion(card: Card): GroupDeletion | null {
  const group = card.group
  if (!group || typeof group !== 'object' || Array.isArray(group)) return null
  const deleted = (group as Record<string, unknown>).deleted
  if (!deleted || typeof deleted !== 'object' || Array.isArray(deleted)) return null
  const at = (deleted as Record<string, unknown>).at
  const by = (deleted as Record<string, unknown>).by
  if (typeof at !== 'string' || typeof by !== 'string') return null
  return { at, by }
}

/** `Card conv_1: group "old-room" — DELETED by @alice at 2026-11-02T10:00:00Z; nothing can be sent here.` or `null`. */
export function renderDeletedGroupNote(card: Card): string | null {
  const deletion = readGroupDeletion(card)
  if (!deletion) return null
  const id = typeof card.conversation_id === 'string' ? card.conversation_id : '<unknown conversation>'
  const name = (card.group as Record<string, unknown>).name
  const label = typeof name === 'string' && name.length > 0 ? `group "${name}"` : 'group'
  return `Card ${id}: ${label} — DELETED by ${deletion.by} at ${deletion.at}; nothing can be sent here.`
}

// ─── parsing the answer ─────────────────────────────────────────────────

/**
 * Parse the model's JSON into verdicts for cards we showed it. Returns
 * `null` when the text holds no JSON at all (the caller applies the failure
 * policy). Entries for unknown conversations, unknown decisions, or
 * duplicates are dropped; the caller sees those cards as undecided.
 * Tolerant of fences, surrounding prose and spelling.
 */
export function parseVerdicts(
  text: string | null | undefined,
  params: { knownIds: readonly string[]; categories?: readonly string[] },
): Verdict[] | null {
  const raw = extractJson(text)
  if (raw === null) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }

  let items: unknown
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>
    items = record.decisions ?? record.verdicts
    if (items === undefined && 'conversation_id' in record) items = [record]
  } else {
    items = obj
  }
  if (!Array.isArray(items)) return null

  const known = new Set(params.knownIds)
  const allowed = new Set((params.categories ?? []).map((c) => c.toLowerCase()))
  const seen = new Set<string>()
  const out: Verdict[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const id = entry.conversation_id
    if (typeof id !== 'string' || !known.has(id) || seen.has(id)) continue
    const decision = normalizeDecision(entry.decision)
    if (decision === null) continue
    seen.add(id)
    const category = normalizeCategory(entry.category, allowed)
    const deferSeconds = decision === DEFER ? normalizeDeferSeconds(entry.defer_seconds) : undefined
    out.push({
      conversationId: id,
      decision,
      ...(category !== undefined ? { category } : {}),
      ...(deferSeconds !== undefined ? { deferSeconds } : {}),
    })
  }
  return out
}

function extractJson(text: string | null | undefined): string | null {
  if (!text || text.trim().length === 0) return null
  let s = text.trim()
  const fence = FENCE_RE.exec(s)
  if (fence?.[1]) s = fence[1].trim()
  const starts = [s.indexOf('{'), s.indexOf('[')].filter((i) => i !== -1)
  if (starts.length === 0) return null
  const start = Math.min(...starts)
  const closer = s[start] === '{' ? '}' : ']'
  const end = s.lastIndexOf(closer)
  if (end <= start) return null
  return s.slice(start, end + 1)
}

export function normalizeDecision(value: unknown): Decision | null {
  if (typeof value !== 'string') return null
  const token = value.trim().toLowerCase().replace(/\s+/g, '_')
  if (REPLY_TOKENS.has(token)) return REPLY
  if (DISMISS_TOKENS.has(token)) return DISMISS
  if (DEFER_TOKENS.has(token)) return DEFER
  return null
}

function normalizeCategory(value: unknown, allowed: Set<string>): string | undefined {
  if (allowed.size === 0 || typeof value !== 'string') return undefined
  const token = value.trim().toLowerCase()
  return allowed.has(token) ? token : undefined
}

function normalizeDeferSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const seconds = Math.trunc(value)
  return seconds > 0 ? seconds : undefined
}

// ─── the step ───────────────────────────────────────────────────────────

export interface RunGateParams {
  readonly tray: Tray
  readonly mainLine: MainLineClient
  readonly caller: GateCaller
  readonly failOpen: boolean
  readonly timeoutMs: number
  readonly maxTokens?: number
  readonly now?: () => number
  readonly log?: (level: 'debug' | 'info' | 'warn', message: string) => void
}

/** Decide every card on the tray and record the verdicts. Never throws. */
export async function runGate(params: RunGateParams): Promise<GateResult> {
  const cards = cardsOf(params.tray)
  const ids = cardIds(cards)
  const truncated = params.tray.truncated === true
  const now = params.now ?? Date.now
  const log = params.log ?? (() => undefined)
  if (ids.length === 0) return emptyResult('empty', truncated)

  const started = now()
  let text: string
  try {
    const messages = buildGateMessages(params.tray)
    text = await params.caller({
      systemPrompt: messages.systemPrompt,
      userContent: messages.userContent,
      maxTokens: params.maxTokens ?? DEFAULT_GATE_MAX_TOKENS,
      timeoutMs: params.timeoutMs,
    })
  } catch (err) {
    const reason = `decision call failed: ${err instanceof Error ? err.message : String(err)}`
    log('warn', `gate: ${reason} (${ids.length} cards)`)
    return failedResult(ids, params.failOpen, reason, now() - started, truncated)
  }
  const latencyMs = now() - started

  const verdicts = parseVerdicts(text, { knownIds: ids, categories: categoriesOf(params.tray) })
  if (!verdicts || verdicts.length === 0) {
    log('warn', `gate: unusable answer for ${ids.length} cards (latency ${latencyMs} ms)`)
    log('debug', `gate: raw model output: ${(text ?? '').slice(0, 200)}`)
    return failedResult(ids, params.failOpen, 'no usable verdicts in the answer', latencyMs, truncated)
  }

  const byId = new Map<string, Card>()
  for (const card of cards) {
    const id = card.conversation_id
    if (typeof id === 'string') byId.set(id, card)
  }
  const decided = new Set(verdicts.map((v) => v.conversationId))
  const undecided = ids.filter((id) => !decided.has(id))
  const reply: string[] = []
  let posted = 0
  let postFailures = 0
  for (const verdict of verdicts) {
    if (verdict.decision === REPLY) {
      reply.push(verdict.conversationId)
      continue
    }
    if (await postVerdict(params.mainLine, verdict, byId.get(verdict.conversationId), log)) posted += 1
    else postFailures += 1
  }
  if (undecided.length > 0) {
    log('warn', `gate: ${undecided.length} of ${ids.length} cards left undecided by the model: ${undecided.join(', ')}`)
  }
  return {
    source: 'llm',
    cards: ids.length,
    verdicts,
    undecided,
    replyConversations: reply,
    posted,
    postFailures,
    truncated,
    latencyMs,
    failure: null,
  }
}

export function emptyResult(source: 'empty' | 'disabled', truncated: boolean, replyConversations: readonly string[] = []): GateResult {
  return {
    source,
    cards: replyConversations.length,
    verdicts: [],
    undecided: [],
    replyConversations,
    posted: 0,
    postFailures: 0,
    truncated,
    latencyMs: 0,
    failure: null,
  }
}

function failedResult(ids: readonly string[], failOpen: boolean, reason: string, latencyMs: number, truncated: boolean): GateResult {
  return {
    source: failOpen ? 'fail_open' : 'fail_closed',
    cards: ids.length,
    verdicts: [],
    undecided: ids,
    replyConversations: failOpen ? ids : [],
    posted: 0,
    postFailures: 0,
    truncated,
    latencyMs,
    failure: reason,
  }
}

/**
 * Record one `dismiss`/`defer` verdict. `through_message_id` is the card's
 * newest stored message (`preview.message_id`), so only what the model saw
 * is settled; anything that landed since stays `stored` and knocks again. A
 * `400` for an optional field (category, defer_seconds) is retried once with
 * the bare verdict — a verdict the server can take is worth more than its
 * label.
 */
export async function postVerdict(
  mainLine: MainLineClient,
  verdict: Verdict,
  card: Card | undefined,
  log: (level: 'info' | 'warn', message: string) => void = () => undefined,
): Promise<boolean> {
  const through = previewMessageId(card)
  try {
    await mainLine.recordDecision(verdict.conversationId, {
      decision: verdict.decision,
      category: verdict.category,
      throughMessageId: through,
      deferSeconds: verdict.deferSeconds,
    })
    return true
  } catch (err) {
    const retryable =
      err instanceof MainLineError &&
      err.status === 400 &&
      (verdict.category !== undefined || verdict.deferSeconds !== undefined)
    if (!retryable) {
      log('warn', `gate: verdict ${verdict.decision} for ${verdict.conversationId} not recorded: ${describe(err)}`)
      return false
    }
    log('warn', `gate: server rejected optional fields for ${verdict.conversationId} (${describe(err)}) — retrying bare verdict`)
  }
  try {
    await mainLine.recordDecision(verdict.conversationId, {
      decision: verdict.decision,
      throughMessageId: through,
    })
    return true
  } catch (err) {
    log('warn', `gate: verdict ${verdict.decision} for ${verdict.conversationId} not recorded: ${describe(err)}`)
    return false
  }
}

function previewMessageId(card: Card | undefined): string | undefined {
  if (!card) return undefined
  const preview = card.preview
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return undefined
  const id = (preview as Record<string, unknown>).message_id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
