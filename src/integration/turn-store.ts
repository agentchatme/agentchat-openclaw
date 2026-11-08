/**
 * The turns in flight, on disk: `<state>/agentchat/<accountId>/turns.json`.
 *
 * Why it exists: a gateway restart ends every run with the process, and
 * OpenClaw (current main) may then continue a plugin's turn session on its
 * own. A plugin run started with no requester is registered under the
 * agent's main session (`registerPluginSubagentRunFromGateway`,
 * `src/gateway/server-methods/agent-subagent-registration.ts`), restart
 * resume walks a live subagent session up to that root
 * (`resolveRootSubagentRequester`) and wakes it with "send a fresh
 * instruction to the same retained child session when appropriate"
 * (`src/gateway/session-restart-resume.ts`). So after a restart the agent
 * may run our turn's session again while the new receive loop would gate
 * the same card and start a second turn. The new process knows neither the
 * old run nor its conversation, and a third-party plugin has no public API
 * that lists live runs (`readSessionFacts` is for bundled / trusted
 * official plugins only). So the turns in flight are written here, and the
 * next start holds their conversations for a while (`AccountTurns.adopt`).
 *
 * What is written: the run id, the turn's session key, what it held (the
 * conversation or invite id and the message the gate read through), and the
 * few card fields the after-turn rule compares — never message text.
 * Written atomically (temp file + rename) on every change; an entry whose
 * run ended stays `KEEP_ENDED_MS` longer, because a restart ends a run
 * before it ends the process. Never throws: a file that cannot be written
 * costs only the defense, and one that cannot be read is treated as empty.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { InboxCard } from 'agentchatme'

import { integrationStateDir } from './state.js'

export const TURN_STORE_FILE = 'turns.json'

/** An ended run's entry stays this long (a restart ends the run a few seconds before the process). */
export const KEEP_ENDED_MS = 60_000

/** The card fields the after-turn rule reads (`turnOutcome`): no message text. */
export type StoredCard = Pick<InboxCard, 'conversation_id'> & {
  readonly last_message_id?: string | null
  readonly your_last_message_at?: string | null
  readonly you_owe_reply?: boolean
  readonly your_last_decision?: InboxCard['your_last_decision'] | null
}

export interface StoredTurn {
  readonly runId: string
  readonly kind: 'reply' | 'invite'
  /** The conversation id (reply) or the invite id. */
  readonly id: string
  readonly anchor: string | null
  readonly sessionKey: string
  /** Local clock, ms. */
  readonly startedAt: number
  /** When the first turn of this chain started (a turn continued after a restart keeps it): stored turns age out by it. */
  readonly firstStartedAt?: number
  readonly category?: string | null
  readonly card?: StoredCard
}

interface StoreFile {
  readonly version: 1
  readonly turns: readonly StoredTurn[]
}

/** The card as stored: the fields the rule compares, the anchor as `last_message_id`. */
export function storedCard(card: InboxCard, anchor: string | null): StoredCard {
  return {
    conversation_id: card.conversation_id,
    ...(anchor ? { last_message_id: anchor } : {}),
    ...(card.your_last_message_at !== undefined ? { your_last_message_at: card.your_last_message_at } : {}),
    ...(card.you_owe_reply !== undefined ? { you_owe_reply: card.you_owe_reply } : {}),
    ...(card.your_last_decision !== undefined ? { your_last_decision: card.your_last_decision } : {}),
  }
}

export class TurnStore {
  readonly file: string

  constructor(accountId: string, stateDir?: string) {
    this.file = path.join(integrationStateDir(accountId, stateDir), TURN_STORE_FILE)
  }

  /** What the last process left. Empty when there is no file or it cannot be read. */
  load(): StoredTurn[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return []
    }
    const turns = (parsed as { version?: unknown; turns?: unknown } | null)?.turns
    if ((parsed as { version?: unknown } | null)?.version !== 1 || !Array.isArray(turns)) return []
    return turns.filter(isStoredTurn)
  }

  /** Replace the file with `turns` (removed when empty). Returns false when the write failed. */
  write(turns: readonly StoredTurn[]): boolean {
    try {
      if (turns.length === 0) {
        fs.rmSync(this.file, { force: true })
        return true
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const body: StoreFile = { version: 1, turns }
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      return true
    } catch {
      return false
    }
  }
}

function isStoredTurn(value: unknown): value is StoredTurn {
  const turn = value as Partial<StoredTurn> | null
  return (
    typeof turn === 'object' &&
    turn !== null &&
    typeof turn.runId === 'string' &&
    (turn.kind === 'reply' || turn.kind === 'invite') &&
    typeof turn.id === 'string' &&
    turn.id.length > 0 &&
    typeof turn.sessionKey === 'string' &&
    turn.sessionKey.length > 0 &&
    typeof turn.startedAt === 'number' &&
    (turn.anchor === null || typeof turn.anchor === 'string')
  )
}
