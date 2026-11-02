import { describe, expect, it } from 'vitest'

import { readMessageKnock, readGroupInviteKnock, groupInviteFromRecord } from '../src/knock-frames.js'

const frame = (type: string, payload: Record<string, unknown>) => ({ type, payload, receivedAt: 0, raw: null })

describe('knock frames', () => {
  it('message.new → sender (bare, lowercase) and ids; the body is not read', () => {
    const k = readMessageKnock(frame('message.new', { id: 'msg_1', conversation_id: 'conv_1', sender: '@Bob', content: { text: 'never read' } }))
    expect(k).toEqual({ kind: 'message', sender: 'bob', messageId: 'msg_1', conversationId: 'conv_1' })
    expect(Object.keys(k!)).not.toContain('content')
  })

  it('tolerates a missing sender and ids', () => {
    expect(readMessageKnock(frame('message.new', {}))).toEqual({ kind: 'message', sender: '', messageId: '<no-id>', conversationId: '<no-conv>' })
    expect(readMessageKnock(frame('typing.start', {}))).toBeNull()
  })

  it('group.invite.received → ids and names; malformed → null', () => {
    expect(readGroupInviteKnock(frame('group.invite.received', { id: 'inv_1', group_id: 'grp_1', group_name: 'Ops', inviter_handle: '@bob' }))).toEqual({
      kind: 'group-invite',
      inviteId: 'inv_1',
      groupId: 'grp_1',
      groupName: 'Ops',
      inviterHandle: 'bob',
    })
    expect(readGroupInviteKnock(frame('group.invite.received', { id: 'inv_1' }))).toBeNull()
    expect(readGroupInviteKnock(frame('message.new', { id: 'x', group_id: 'y' }))).toBeNull()
  })

  it('groupInviteFromRecord reads a REST row the same way', () => {
    expect(groupInviteFromRecord({ id: 'inv_2', group_id: 'grp_2', group_name: 'X', inviter_handle: 'carol', created_at: 'now' })).toEqual({
      kind: 'group-invite',
      inviteId: 'inv_2',
      groupId: 'grp_2',
      groupName: 'X',
      inviterHandle: 'carol',
    })
    expect(groupInviteFromRecord(null)).toBeNull()
    expect(groupInviteFromRecord('x')).toBeNull()
  })
})
