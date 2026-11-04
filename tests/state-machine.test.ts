import { describe, expect, it } from 'vitest'
import {
  canSend,
  isTerminal,
  shouldReconnect,
  transition,
  type ConnectionState,
} from '../src/state-machine.js'

const NOW = 1_700_000_000_000

describe('state machine — happy path', () => {
  it('DISCONNECTED → CONNECTING on CONNECT', () => {
    const s = transition({ kind: 'DISCONNECTED' }, { type: 'CONNECT', now: NOW, attempt: 1 })
    expect(s).toEqual({ kind: 'CONNECTING', attempt: 1, startedAt: NOW })
  })

  it('CONNECTING → AUTHENTICATING on SOCKET_OPEN', () => {
    const s = transition(
      { kind: 'CONNECTING', attempt: 1, startedAt: NOW },
      { type: 'SOCKET_OPEN', now: NOW + 100 },
    )
    expect(s).toEqual({ kind: 'AUTHENTICATING', startedAt: NOW + 100 })
  })

  it('AUTHENTICATING → READY on HELLO_OK', () => {
    const s = transition(
      { kind: 'AUTHENTICATING', startedAt: NOW },
      { type: 'HELLO_OK', now: NOW + 50 },
    )
    expect(s).toEqual({ kind: 'READY', connectedAt: NOW + 50 })
  })
})

describe('state machine — failure paths', () => {
  it('AUTHENTICATING → AUTH_FAIL on AUTH_REJECTED is not terminal', () => {
    const s = transition(
      { kind: 'AUTHENTICATING', startedAt: NOW },
      { type: 'AUTH_REJECTED', reason: 'invalid-api-key' },
    )
    expect(s.kind).toBe('AUTH_FAIL')
    expect(isTerminal(s)).toBe(false)
    expect(canSend(s)).toBe(false)
  })

  it('AUTH_FAIL leaves on CONNECT (slow retry), RECONFIGURED or DRAIN_REQUESTED only', () => {
    const authFail: ConnectionState = { kind: 'AUTH_FAIL', reason: 'expired' }
    expect(transition(authFail, { type: 'CONNECT', now: NOW, attempt: 7 })).toEqual({
      kind: 'CONNECTING',
      attempt: 7,
      startedAt: NOW,
    })
    expect(transition(authFail, { type: 'RECONFIGURED' })).toEqual({ kind: 'DISCONNECTED' })
    expect(transition(authFail, { type: 'DRAIN_REQUESTED', now: NOW, deadline: NOW + 1 })).toEqual({ kind: 'CLOSED' })
    expect(transition(authFail, { type: 'SOCKET_OPEN', now: NOW })).toEqual(authFail)
    expect(transition(authFail, { type: 'HELLO_OK', now: NOW })).toEqual(authFail)
    expect(transition(authFail, { type: 'SOCKET_CLOSED', code: 1006, reason: '' })).toEqual(authFail)
  })

  it('nothing the network does reaches CLOSED — only the caller\'s own drain', () => {
    const live: ConnectionState[] = [
      { kind: 'DISCONNECTED' },
      { kind: 'CONNECTING', attempt: 1, startedAt: NOW },
      { kind: 'AUTHENTICATING', startedAt: NOW },
      { kind: 'READY', connectedAt: NOW },
      { kind: 'DEGRADED', since: NOW, reason: 'ping-timeout' },
      { kind: 'AUTH_FAIL', reason: 'bad-key' },
    ]
    for (const state of live) {
      expect(isTerminal(state)).toBe(false)
      expect(transition(state, { type: 'SOCKET_CLOSED', code: 1008, reason: 'Invalid token' }).kind).not.toBe('CLOSED')
      expect(transition(state, { type: 'AUTH_REJECTED', reason: 'Invalid token' }).kind).not.toBe('CLOSED')
    }
  })

  it('READY → DEGRADED on PING_TIMEOUT', () => {
    const s = transition(
      { kind: 'READY', connectedAt: NOW },
      { type: 'PING_TIMEOUT', now: NOW + 30_000 },
    )
    expect(s).toEqual({ kind: 'DEGRADED', since: NOW + 30_000, reason: 'ping-timeout' })
  })

  it('DEGRADED → READY on RECOVERED', () => {
    const s = transition(
      { kind: 'DEGRADED', since: NOW, reason: 'ping-timeout' },
      { type: 'RECOVERED', now: NOW + 100 },
    )
    expect(s).toEqual({ kind: 'READY', connectedAt: NOW + 100 })
  })

  it('READY → DISCONNECTED on SOCKET_CLOSED triggers reconnect', () => {
    const s = transition(
      { kind: 'READY', connectedAt: NOW },
      { type: 'SOCKET_CLOSED', code: 1006, reason: 'abnormal-closure' },
    )
    expect(s.kind).toBe('DISCONNECTED')
    expect(shouldReconnect(s)).toBe(true)
  })
})

describe('state machine — graceful shutdown', () => {
  const deadline = NOW + 5_000

  it('READY → DRAINING on DRAIN_REQUESTED', () => {
    const s = transition(
      { kind: 'READY', connectedAt: NOW },
      { type: 'DRAIN_REQUESTED', now: NOW, deadline },
    )
    expect(s).toEqual({ kind: 'DRAINING', since: NOW, deadline })
  })

  it('DRAINING allows sends until drained', () => {
    const s: ConnectionState = { kind: 'DRAINING', since: NOW, deadline }
    expect(canSend(s)).toBe(true)
  })

  it('DRAINING → CLOSED on DRAIN_COMPLETED', () => {
    const s = transition(
      { kind: 'DRAINING', since: NOW, deadline },
      { type: 'DRAIN_COMPLETED' },
    )
    expect(s).toEqual({ kind: 'CLOSED' })
    expect(isTerminal(s)).toBe(true)
  })

  it('CLOSED is final — ignores further events', () => {
    const closed: ConnectionState = { kind: 'CLOSED' }
    expect(transition(closed, { type: 'CONNECT', now: NOW, attempt: 1 })).toEqual(closed)
    expect(transition(closed, { type: 'RECONFIGURED' })).toEqual(closed)
  })
})

describe('state machine — canSend guard', () => {
  it('READY can send', () => {
    expect(canSend({ kind: 'READY', connectedAt: NOW })).toBe(true)
  })
  it('DEGRADED can still send (best-effort delivery)', () => {
    expect(canSend({ kind: 'DEGRADED', since: NOW, reason: 'backpressure' })).toBe(true)
  })
  it('CONNECTING cannot send', () => {
    expect(canSend({ kind: 'CONNECTING', attempt: 1, startedAt: NOW })).toBe(false)
  })
  it('AUTH_FAIL cannot send', () => {
    expect(canSend({ kind: 'AUTH_FAIL', reason: 'bad-key' })).toBe(false)
  })
  it('CLOSED cannot send', () => {
    expect(canSend({ kind: 'CLOSED' })).toBe(false)
  })
})
