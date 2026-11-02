/**
 * What the doorbell reads from a server frame — and what it does not.
 *
 * A `message.new` frame means *the tray changed*. The doorbell reads only
 * the sender (to skip the echo of its own sends) and the ids (for the log
 * line). The body is never looked at: the agent reads it through the hosted
 * tools inside its turn. There is no schema for message content here
 * because nothing here consumes it.
 *
 * A `group.invite.received` frame is the second knock kind. Invites are not
 * on the tray and are not gated; the doorbell reads the ids and names it
 * logs and hands the invite to the invoker, which starts one turn with a
 * fixed prompt.
 */

import type { InboundFrame } from './ws-client.js'

export interface MessageKnock {
  readonly kind: 'message'
  /** Bare, lowercase sender handle (`@` stripped); `''` when the frame carried none. */
  readonly sender: string
  readonly messageId: string
  readonly conversationId: string
}

export interface GroupInviteKnock {
  readonly kind: 'group-invite'
  readonly inviteId: string
  readonly groupId: string
  readonly groupName: string
  readonly inviterHandle: string
}

export type Knock = MessageKnock | GroupInviteKnock

/** `message.new` → the sender and ids. `null` when the frame is not a usable knock. */
export function readMessageKnock(frame: InboundFrame): MessageKnock | null {
  if (frame.type !== 'message.new') return null
  const payload = frame.payload
  const senderRaw = payload.sender ?? payload.from ?? ''
  const sender = typeof senderRaw === 'string' ? senderRaw.replace(/^@/, '').toLowerCase() : ''
  return {
    kind: 'message',
    sender,
    messageId: str(payload.id) ?? '<no-id>',
    conversationId: str(payload.conversation_id) ?? '<no-conv>',
  }
}

/** `group.invite.received` → the invite ids and names. `null` when the frame is malformed. */
export function readGroupInviteKnock(frame: InboundFrame): GroupInviteKnock | null {
  if (frame.type !== 'group.invite.received') return null
  return groupInviteFromRecord(frame.payload)
}

/** The same shape from a REST `GET /v1/groups/invites` row (connect-time catch-up). */
export function groupInviteFromRecord(record: unknown): GroupInviteKnock | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const row = record as Record<string, unknown>
  const inviteId = str(row.id)
  const groupId = str(row.group_id)
  if (!inviteId || !groupId) return null
  return {
    kind: 'group-invite',
    inviteId,
    groupId,
    groupName: str(row.group_name) ?? '',
    inviterHandle: (str(row.inviter_handle) ?? '').replace(/^@/, ''),
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
