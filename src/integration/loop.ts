/**
 * The receive loop for one account: the SDK kit's `ReceiveLoop`, with what
 * is OpenClaw's plugged in.
 *
 *   socket frame / connect / wake frame / invite ──► one cycle per burst ──► tray
 *     ──► gate call on the agent's own model (gate-call mode) ──► dismiss / defer at once
 *     ──► one OpenClaw run per reply and per invite ──► the after-turn rule (D5)
 *
 * The cycle, the tray read, the gate, which cards a running turn holds, the
 * prompts, and what is recorded after a turn are the kit's. This module
 * supplies the runtime parts: the gate call (`runtime.llm.complete`, tool
 * free), the turn (`./turns.ts` over `runtime.subagent.run`), whether a turn
 * can have the hosted tools (`readiness`), and the log lines and metrics.
 *
 * `AGENTCHAT_REPLY_GATE_ENABLED=0` switches to the kit's single-run mode:
 * one run with the served wake instruction whenever something is owed; the
 * agent judges every card inside it and records its own verdicts.
 */

import { integration, type RealtimeClient } from 'agentchatme'

import type { Logger } from '../log.js'
import type { MetricsRecorder } from '../metrics.js'
import { createNoopMetrics } from '../metrics.js'
import type { GateModelCall, TurnReadiness, TurnStarter as RuntimeTurnStarter } from './model.js'
import { OPENCLAW_TOOL_NAMER, integrationLane, wakeSessionKey } from './turn.js'
import { createLoopTurnStarter } from './turns.js'
import type { AccountTurns } from './running.js'

export interface IntegrationLoopOptions {
  readonly accountId: string
  readonly agentId: string
  readonly client: integration.ReceiveLoopClient
  readonly texts: integration.TextsSource
  /** The SDK socket (built by `IntegrationSocket`); the loop connects and disconnects it. `null`: wakes only through `wake()`. */
  readonly socket: RealtimeClient | null
  /** The agent's handle, for the echo filter (learned from the tray when absent). */
  readonly handle?: string | undefined
  readonly callModel: GateModelCall
  readonly startRun: RuntimeTurnStarter
  /** The account's turns, shared with every loop for the account in this process (`accountTurns`). */
  readonly turns: AccountTurns
  readonly logger: Logger
  readonly metrics?: MetricsRecorder
  readonly readiness?: () => TurnReadiness
  /** `false`: single-run mode (no gate call). */
  readonly gateEnabled?: boolean
  /** D5 pacing window (the kit's default 60 s); tests shorten it. */
  readonly paceMs?: number
  readonly quietMs?: number
  readonly maxMs?: number
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
}

export interface IntegrationLoop {
  readonly loop: integration.ReceiveLoop
  /** Stop the loop (it disconnects the socket). Turns already running go on and still have their outcome recorded. */
  stop(): Promise<void>
}

let generation = 0

export function createIntegrationLoop(options: IntegrationLoopOptions): IntegrationLoop {
  const logger = options.logger.child({ component: 'integration', accountId: options.accountId })
  const metrics = options.metrics ?? createNoopMetrics()
  const now = options.now ?? Date.now
  generation += 1
  const owner = `${options.accountId}#${generation}`
  const gateEnabled = options.gateEnabled ?? true

  let unreadyReason: string | null = null
  const readiness: integration.Readiness | undefined = options.readiness
    ? () => {
        const ready = options.readiness!()
        if (ready.ready) {
          if (unreadyReason !== null) logger.info({}, 'turns can start again — gating resumes')
          unreadyReason = null
          return ready
        }
        // Logged when the reason changes, not on every wake.
        if (unreadyReason !== ready.reason) logger.warn({ reason: ready.reason }, 'not gating — no turn can start now; the cards wait on the tray')
        unreadyReason = ready.reason
        return ready
      }
    : undefined

  const startTurn = createLoopTurnStarter({ accountId: options.accountId, agentId: options.agentId, startRun: options.startRun, turns: options.turns, owner, logger, now })

  const loop = new integration.ReceiveLoop({
    client: options.client,
    texts: options.texts,
    mode: gateEnabled ? 'gateCall' : 'singleRun',
    ...(gateEnabled ? { callModel: options.callModel, startTurn } : { startRun: singleRunStarter(options, logger, now) }),
    socket: options.socket,
    ...(options.handle ? { handle: options.handle } : {}),
    toolNamer: OPENCLAW_TOOL_NAMER,
    // One account's turns run on one OpenClaw lane anyway; one slot keeps
    // the rest held out of the gate (no second model call decides them).
    maxConcurrentTurns: 1,
    tracker: options.turns.tracker,
    ...(readiness ? { readiness } : {}),
    ...(options.paceMs !== undefined ? { paceMs: options.paceMs } : {}),
    ...(options.quietMs !== undefined ? { quietMs: options.quietMs } : {}),
    ...(options.maxMs !== undefined ? { maxMs: options.maxMs } : {}),
    now,
    ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
    ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
    onEvent: (event) => logEvent(event, logger, metrics),
  })

  // The account's live loop: a held run that ends (hung, or started by an
  // earlier loop) wakes it, so what arrived meanwhile is gated at once.
  options.turns.setLive(owner, () => loop.wake())

  return {
    loop,
    async stop() {
      options.turns.clearLive(owner)
      await loop.stop()
    },
  }
}

/** Single-run mode: one OpenClaw run with the served text; the cycle waits for its confirmed end. */
function singleRunStarter(options: IntegrationLoopOptions, logger: Logger, now: () => number): integration.RunStarter {
  return async (request) => {
    const sessionKey = wakeSessionKey(options.agentId, now())
    logger.info({ sessionKey, cards: request.cards, invites: request.invites }, 'gate off — one run with the served wake instruction')
    const admission = await options.startRun({ sessionKey, prompt: request.prompt, lane: integrationLane(options.accountId, options.turns.laneGeneration) })
    if (!admission.ran) return { status: 'not_started', detail: admission.error }
    const outcome = await admission.done
    logger[outcome.status === 'ok' ? 'info' : 'warn']({ sessionKey, runId: outcome.runId, status: outcome.status, agentchatCalls: outcome.agentchatCalls ?? null }, 'gate off — run ended')
    return outcome.status === 'ok' && !outcome.error ? { status: 'completed' } : { status: 'failed', detail: outcome.error ?? `run ended: ${outcome.status ?? 'unknown'}` }
  }
}

/** One line per loop event, and the wake metric for the sources the socket binding does not count. */
function logEvent(event: integration.ReceiveLoopEvent, logger: Logger, metrics: MetricsRecorder): void {
  switch (event.type) {
    case 'wake':
      // `connect` and wake frames are counted by the socket binding (with their reason).
      if (event.source === 'message') metrics.incWake({ source: 'message' })
      else if (event.source === 'invite') metrics.incWake({ source: 'invite' })
      logger.debug({ source: event.source, ...(event.conversationId ? { conversationId: event.conversationId } : {}) }, 'wake')
      return
    case 'echo':
      logger.debug(event.conversationId ? { conversationId: event.conversationId } : {}, 'own echo — not a wake')
      return
    case 'cycle': {
      const s = event.summary
      const fields = {
        outcome: s.outcome,
        cards: s.cards,
        invites: s.invites,
        reply: s.reply,
        dismiss: s.dismiss,
        defer: s.defer,
        undecided: s.undecided,
        recordFailures: s.recordFailures,
        turnsStarted: s.turnsStarted,
        turnsRefused: s.turnsRefused,
        heldByTurns: s.heldByTurns,
        ...(s.truncated ? { truncated: true } : {}),
        ...(s.failure ? { failure: s.failure } : {}),
      }
      switch (s.outcome) {
        case 'empty':
          logger.info({}, 'tray empty — nothing to decide')
          return
        case 'nothing_owed':
          logger.info(fields, 'nothing new to decide (muted cards, or cards a running turn holds)')
          return
        case 'fail_closed':
          logger.warn(fields, 'gate failed closed — nothing recorded, no turn started; the server re-wakes')
          return
        case 'tray_failed':
          logger.warn(fields, 'tray read failed — the cards stay on the tray; the server re-wakes')
          return
        case 'texts_missing':
          logger.warn(fields, 'served texts not available — not gating; the cards wait on the tray')
          return
        case 'tools_unavailable':
          logger.debug(fields, 'not gating — no turn can start now')
          return
        case 'abandoned':
          logger.warn(fields, 'cycle abandoned — it ran past its deadline; nothing more is done for it, the next wake starts a new one')
          return
        default: {
          const incomplete = s.turnsRefused > 0 || s.recordFailures > 0 || s.undecided > 0
          logger[incomplete ? 'warn' : 'info'](fields, incomplete ? 'gate — some cards were left on the tray; the server re-wakes' : 'gate')
          return
        }
      }
    }
    case 'turn_started':
      return // the turn starter logs it with the OpenClaw session and run
    case 'turn_refused':
      logger.warn({ kind: event.kind, id: event.id, error: event.error }, 'turn not started — nothing recorded; the card stays on the tray')
      return
    case 'turn_outcome': {
      const o = event.outcome
      logger.info(
        { conversationId: o.conversationId, action: o.action, reason: o.reason, recorded: event.recorded, ...(o.action !== 'none' ? { through: o.throughMessageId } : {}) },
        event.recorded ? `${o.action === 'record_reply' ? 'reply' : 'dismiss'} recorded after the turn (${o.reason})` : `nothing recorded after the turn (${o.reason})`,
      )
      return
    }
    case 'invite_outcome':
      logger.info(
        { inviteId: event.outcome.inviteId, action: event.outcome.action, reason: event.outcome.reason, recorded: event.recorded },
        event.recorded ? 'invite dismissed after a second silent turn (left pending)' : `nothing recorded for the invite (${event.outcome.reason})`,
      )
      return
    case 'run':
      return // single-run mode logs the run itself
    case 'error':
      logger.debug({ err: event.error.message }, 'receive loop notice')
      return
  }
}

/** Cycle outcomes that mean nothing could be decided: repeated, they are an operator's problem. */
const TROUBLE_OUTCOMES: ReadonlySet<string> = new Set(['fail_closed', 'tools_unavailable', 'texts_missing', 'abandoned'])

/** How many cycles in a row must end in trouble before status and doctor warn. */
export const CYCLE_TROUBLE_RUN = 3

const TROUBLE_MEANING: Readonly<Record<string, string>> = {
  fail_closed: 'the gate call failed (model unreachable, too slow, or nothing usable)',
  tools_unavailable: 'no turn could have the hosted tools',
  texts_missing: 'the served texts are not available',
  abandoned: 'the cycle ran past its deadline and was abandoned',
}

/**
 * One operator line when the most recent cycles (`status().recentCycles`,
 * oldest first) ended in trouble at least `CYCLE_TROUBLE_RUN` times in a row,
 * else null. Nothing was gated in those cycles; the cards wait on the tray
 * and AgentChat re-wakes them.
 */
export function cycleTroubleLine(recentCycles: ReadonlyArray<{ readonly outcome: string; readonly failure?: string | null; readonly at?: string }>): string | null {
  let run = 0
  for (let i = recentCycles.length - 1; i >= 0 && TROUBLE_OUTCOMES.has(recentCycles[i]!.outcome); i -= 1) run += 1
  if (run < CYCLE_TROUBLE_RUN) return null
  const last = recentCycles[recentCycles.length - 1]!
  const kinds = [...new Set(recentCycles.slice(-run).map((c) => c.outcome))]
  const meaning = kinds.map((k) => TROUBLE_MEANING[k] ?? k).join('; ')
  return `the last ${run} cycles decided nothing (${kinds.join(', ')}): ${meaning}${last.failure ? ` — latest: ${last.failure}` : ''}; the cards wait on the tray and AgentChat re-wakes them`
}

