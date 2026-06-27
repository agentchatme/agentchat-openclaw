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
    const reason = err instanceof GateTimeoutError ? 'decision_timeout' : 'decision_call_error'
    return gateFallback(params.failOpen, reason, Date.now() - start)
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
      skipAgentDiscovery: true,
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
      options: { maxTokens, ...(signal ? { signal } : {}) },
    })

    return result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
  }
}
