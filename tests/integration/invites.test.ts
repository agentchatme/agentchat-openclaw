import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { InviteLedger, groupInviteFromRecord, inviteLedgerPath } from '../../src/integration/invites.js'

describe('groupInviteFromRecord', () => {
  it('reads the ids and names from a frame payload or a REST row; drops records without ids', () => {
    expect(groupInviteFromRecord({ id: 'inv_1', group_id: 'grp_1', group_name: 'Ops', inviter_handle: '@bob', created_at: 'x' })).toEqual({
      inviteId: 'inv_1',
      groupId: 'grp_1',
      groupName: 'Ops',
      inviterHandle: 'bob',
    })
    expect(groupInviteFromRecord({ group_name: 'no ids' })).toBeNull()
    expect(groupInviteFromRecord(null)).toBeNull()
    expect(groupInviteFromRecord([1])).toBeNull()
  })
})

describe('InviteLedger — offered invites survive a restart', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-invites-'))
  })
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  it('lives under <state dir>/agentchat/<accountId>/invites.json', () => {
    expect(inviteLedgerPath('default', stateDir)).toBe(path.join(stateDir, 'agentchat', 'default', 'invites.json'))
    expect(inviteLedgerPath('a/b', stateDir)).toBe(path.join(stateDir, 'agentchat', 'a-b', 'invites.json'))
  })

  it('remembers an offered invite across instances (a gateway restart)', () => {
    const first = new InviteLedger({ accountId: 'default', stateDir, now: () => 1_000_000 })
    expect(first.isOffered('inv_1')).toBe(false)
    first.markOffered('inv_1')
    expect(first.isOffered('inv_1')).toBe(true)
    expect(JSON.parse(fs.readFileSync(first.path, 'utf8'))).toEqual({ offered: { inv_1: new Date(1_000_000).toISOString() } })

    const second = new InviteLedger({ accountId: 'default', stateDir, now: () => 2_000_000 })
    expect(second.isOffered('inv_1')).toBe(true)
    expect(second.isOffered('inv_2')).toBe(false)
    expect(second.size).toBe(1)
  })

  it('forgets offered ids older than the retention window', () => {
    const old = new InviteLedger({ accountId: 'default', stateDir, now: () => 0 })
    old.markOffered('inv_old')
    const later = new InviteLedger({ accountId: 'default', stateDir, now: () => 31 * 24 * 60 * 60_000 })
    expect(later.isOffered('inv_old')).toBe(false)
  })

  it('a corrupt or missing file is an empty ledger; a write failure keeps the id in memory and reports', () => {
    fs.mkdirSync(path.dirname(inviteLedgerPath('default', stateDir)), { recursive: true })
    fs.writeFileSync(inviteLedgerPath('default', stateDir), '{not json')
    const ledger = new InviteLedger({ accountId: 'default', stateDir })
    expect(ledger.size).toBe(0)

    const errors: unknown[] = []
    const unwritable = new InviteLedger({ accountId: 'x', file: path.join(stateDir, 'agentchat', 'x'), onWriteError: (err) => errors.push(err) })
    fs.mkdirSync(path.join(stateDir, 'agentchat', 'x'), { recursive: true }) // a directory where the file should be
    unwritable.markOffered('inv_9')
    expect(unwritable.isOffered('inv_9')).toBe(true)
    expect(errors).toHaveLength(1)
  })
})
