/**
 * Reply-gate integration — runs the forced reply / no-reply decision on the
 * agent's OWN configured model via OpenClaw's simple-completion runtime.
 *
 * The decision logic (signals, prompt, parsing) is the pure core in
 * `reply-gate.ts`. This module only wires it to the model call and applies the
 * fail-open / fail-closed policy. The model caller is injectable so the policy
 * is unit-testable without a live runtime — mirroring the Hermes plugin's
 * `reply_gate.decide(caller=…)`.
 *
 * The gate runs on the agent's own model on purpose: the platform stays a dumb
 * carrier and the judgement lives at the edge, matching the model the agent
 * composes with. We never pick a model here.
 */

import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from 'openclaw/plugin-sdk/simple-completion-runtime'

import {
  DEFAULT_GATE_MAX_TOKENS,
  buildDecisionMessages,
  computeConversationSignals,
  gateFallback,
  parseDecision,
  type GateDecision,
  type GateInboundEvent,
  type GateRawMessage,
  type HistoryTurn,
} from './reply-gate.js'
import type { OpenClawConfig } from './openclaw-types.js'

/** Default decision-call timeout. The gate must never block inbound forever. */
export const DEFAULT_GATE_TIMEOUT_MS = 20_000

/**
 * The gate is a binary reply/no_reply verdict — it never needs the model to
 * reason. We force reasoning OFF on the gate call so it stays fast (~1–3s) on
 * ANY model. Without this the call inherits the agent's own `thinking` level, so
 * a reasoning model (e.g. `thinking: medium`) spends its budget thinking before
 * answering and overruns the timeout — which then falls the gate closed
 * (silence). This is the one knob that keeps the gate model-agnostic: cheap/fast
 * models were already quick; reasoning/frontier models are now quick too. Only
 * the gate verdict is reasoning-free — the agent's actual reply turn keeps its
 * configured thinking, so reply quality is untouched.
 */
const GATE_REASONING_LEVEL = 'off' as const

class GateTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GateTimeoutError('gate decision timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** Inputs handed to a gate model caller. Injectable so tests can stub the LLM. */
export interface GateCallParams {
  readonly systemPrompt: string
  readonly userContent: string
  readonly maxTokens: number
  readonly signal?: AbortSignal
}

/** Returns the model's raw text response (expected to be the JSON decision). */
export type GateCaller = (params: GateCallParams) => Promise<string>

export interface DecideReplyParams {
  readonly cfg: OpenClawConfig
  /** Agent whose own model runs the decision (resolved from the inbound route). */
  readonly agentId: string
  /** This agent's handle (for the prompt + group-addressing check). */
  readonly handle: string
  readonly event: GateInboundEvent
  /** Rehydrated recent turns (oldest first), excluding the trigger message. */
  readonly history: readonly HistoryTurn[]
  /** Raw `getMessages` rows the signals are derived from (same fetch as history). */
  readonly rawMessages: readonly GateRawMessage[]
  readonly triggerMessageId: string
  readonly ownHandle: string
  /** Inbound receive time (epoch ms) — the reference point for cadence/pace. */
  readonly nowMs: number
  /** On decision-call error or unparseable output: reply (true) or stay silent (false). */
  readonly failOpen: boolean
  /** Injectable caller; defaults to the agent's own model via simple-completion. */
  readonly caller?: GateCaller
  /** Output-token cap override; defaults to {@link DEFAULT_GATE_MAX_TOKENS}. */
  readonly maxTokens?: number
  /** Decision-call timeout (ms); defaults to {@link DEFAULT_GATE_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/**
 * Decide whether the agent should reply to one inbound message. Never throws —
 * any failure resolves to the configured fail-open / fail-closed fallback so the
 * gate is self-correcting (it simply re-runs on the next inbound).
 */
export async function decideReply(params: DecideReplyParams): Promise<GateDecision> {
  const signals = computeConversationSignals(params.rawMessages, {
    ownHandle: params.ownHandle,
    triggerMessageId: params.triggerMessageId,
    nowMs: params.nowMs,
  })
  const messages = buildDecisionMessages({
    handle: params.handle,
    event: params.event,
    history: params.history,
    signals,
  })
  const systemPrompt = messages.find((m) => m.role === 'system')?.content ?? ''
  const userContent = messages.find((m) => m.role === 'user')?.content ?? ''

  const caller =
    params.caller ?? createSimpleCompletionGateCaller(params.cfg, params.agentId)
  const maxTokens = params.maxTokens ?? DEFAULT_GATE_MAX_TOKENS
  const timeoutMs = params.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS

  const start = Date.now()
  let text: string
  try {
    text = await withTimeout(caller({ systemPrompt, userContent, maxTokens }), timeoutMs)
  } catch (err) {
    if (err instanceof GateTimeoutError) {
      return gateFallback(params.failOpen, 'decision_timeout', Date.now() - start)
    }
    // Surface the underlying failure (auth / model-resolution / provider) in the
    // decision log instead of an opaque `decision_call_error` — the gate is the
    // one place these errors would otherwise vanish, which makes a misconfigured
    // model look identical to a model that simply chose silence.
    const detail = err instanceof Error ? err.message : String(err)
    return gateFallback(
      params.failOpen,
      `decision_call_error: ${detail}`.slice(0, 220),
      Date.now() - start,
    )
  }

  const latencyMs = Date.now() - start
  const parsed = parseDecision(text, { source: 'llm', latencyMs })
  return parsed ?? gateFallback(params.failOpen, 'unparseable_decision', latencyMs)
}

/**
 * Default caller: runs the decision on the agent's own configured model. Mirrors
 * the internal `runtime-llm` usage of the simple-completion runtime — resolve
 * the agent's model + auth, then one completion bounded to a tiny JSON object.
 */
function createSimpleCompletionGateCaller(
  cfg: OpenClawConfig,
  agentId: string,
): GateCaller {
  return async ({ systemPrompt, userContent, maxTokens, signal }) => {
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg: cfg as never, // plugin-local OpenClawConfig alias → sdk's internal type
      agentId,
      allowMissingApiKeyModes: ['aws-sdk'],
      // Do NOT skip discovery: it loads provider model catalogs. Skipping it
      // works for providers with pure dynamic resolution (e.g. Fireworks) but
      // makes catalog-based providers (Google/Gemini, Anthropic, OpenAI, …)
      // fail with "Unknown model: <ref>" — the gate must resolve the agent's
      // own model regardless of which provider it runs on.
      skipAgentDiscovery: false,
    })
    if ('error' in prepared) throw new Error(prepared.error)

    const result = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      cfg: cfg as never,
      context: {
        systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      } as never,
      options: { maxTokens, reasoning: GATE_REASONING_LEVEL, ...(signal ? { signal } : {}) },
    })

    return result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
  }
}
