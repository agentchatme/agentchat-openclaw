/**
 * Group invites: the second wake kind, and the ledger of invites already
 * offered to the agent.
 *
 * An invite is not on the tray and is not gated: the agent gets one turn
 * with the served invite prompt and decides for itself through the hosted
 * tools (accept, decline, or leave it pending). Invites arrive live
 * (`group.invite.received` frame) and are listed again on every connect
 * (`GET /v1/groups/invites`), so the same invite is seen many times over
 * the life of an account. The ledger remembers which invites were offered —
 * on disk, so a gateway restart never starts one more turn for an invite
 * the agent chose to leave pending. An invite whose turn could not start is
 * NOT marked offered: it stays pending in the invoker and is retried on the
 * next wake.
 */

import * as path from 'node:path'

import { integrationStateDir, readJsonFile, writeJsonFile } from './state.js'

export interface GroupInvite {
  readonly inviteId: string
  readonly groupId: string
  readonly groupName: string
  /** Bare handle, `@` stripped; `''` when the frame carried none. */
  readonly inviterHandle: string
}

/** From a `group.invite.received` frame payload or a `GET /v1/groups/invites` row. `null` when the ids are missing. */
export function groupInviteFromRecord(record: unknown): GroupInvite | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const row = record as Record<string, unknown>
  const inviteId = str(row.id)
  const groupId = str(row.group_id)
  if (!inviteId || !groupId) return null
  return {
    inviteId,
    groupId,
    groupName: str(row.group_name) ?? '',
    inviterHandle: (str(row.inviter_handle) ?? '').replace(/^@/, ''),
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export const INVITE_LEDGER_FILE = 'invites.json'
/** Offered ids older than this are forgotten; a server-side invite does not live that long. */
export const INVITE_LEDGER_MAX_AGE_MS = 30 * 24 * 60 * 60_000

interface LedgerFile {
  readonly offered: Record<string, string>
}

export interface InviteLedgerOptions {
  readonly accountId: string
  readonly stateDir?: string | undefined
  /** Explicit file (test seam). Defaults to `<plugin state dir>/invites.json`. */
  readonly file?: string
  readonly now?: () => number
  readonly maxAgeMs?: number
  /** Called when a write fails; the in-memory ledger still holds the id. */
  readonly onWriteError?: (err: unknown) => void
}

export function inviteLedgerPath(accountId: string, stateDir?: string): string {
  return path.join(integrationStateDir(accountId, stateDir), INVITE_LEDGER_FILE)
}

export class InviteLedger {
  private readonly file: string
  private readonly now: () => number
  private readonly maxAgeMs: number
  private readonly onWriteError: ((err: unknown) => void) | undefined
  private offered: Map<string, string>

  constructor(options: InviteLedgerOptions) {
    this.file = options.file ?? inviteLedgerPath(options.accountId, options.stateDir)
    this.now = options.now ?? Date.now
    this.maxAgeMs = options.maxAgeMs ?? INVITE_LEDGER_MAX_AGE_MS
    this.onWriteError = options.onWriteError
    this.offered = this.read()
  }

  get path(): string {
    return this.file
  }

  get size(): number {
    return this.offered.size
  }

  /** True when a turn for this invite was started before (in this process or an earlier one). */
  isOffered(inviteId: string): boolean {
    return this.offered.has(inviteId)
  }

  /** Record that a turn for this invite was admitted. Persists at once. */
  markOffered(inviteId: string): void {
    this.offered.set(inviteId, new Date(this.now()).toISOString())
    this.prune()
    try {
      writeJsonFile(this.file, { offered: Object.fromEntries(this.offered) } satisfies LedgerFile)
    } catch (err) {
      this.onWriteError?.(err)
    }
  }

  private read(): Map<string, string> {
    const raw = readJsonFile(this.file)
    const out = new Map<string, string>()
    if (!raw || typeof raw !== 'object') return out
    const offered = (raw as Record<string, unknown>).offered
    if (!offered || typeof offered !== 'object' || Array.isArray(offered)) return out
    for (const [id, at] of Object.entries(offered as Record<string, unknown>)) {
      if (typeof at === 'string' && id.length > 0) out.set(id, at)
    }
    this.offered = out
    this.prune()
    return this.offered
  }

  private prune(): void {
    const cutoff = this.now() - this.maxAgeMs
    for (const [id, at] of this.offered) {
      const t = Date.parse(at)
      if (!Number.isFinite(t) || t < cutoff) this.offered.delete(id)
    }
  }
}
