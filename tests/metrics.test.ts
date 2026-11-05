/**
 * The three recorders: the prom-client one registers the four documented
 * families with their label names; the in-memory one counts and snapshots
 * (what the gateway wires and the status probe reads); the no-op one keeps
 * nothing.
 */

import { describe, expect, it } from 'vitest'

import { createInMemoryMetrics, createMetrics, createNoopMetrics } from '../src/metrics.js'

describe('createMetrics (prom-client registry)', () => {
  it('registers the four agentchat_channel_* families with the documented label names and routes every call', () => {
    const registered: Array<{ name: string; labelNames?: readonly string[] }> = []
    const calls: string[] = []
    const registry = { registerMetric: () => undefined }
    const factory = {
      Counter: class {
        private readonly name: string
        constructor(cfg: { name: string; labelNames?: readonly string[]; registers?: readonly unknown[] }) {
          this.name = cfg.name
          registered.push({ name: cfg.name, labelNames: cfg.labelNames })
          expect(cfg.registers).toEqual([registry])
        }
        inc(labels?: Record<string, string>): void {
          calls.push(`${this.name}${JSON.stringify(labels)}`)
        }
      },
      Gauge: class {
        private readonly name: string
        constructor(cfg: { name: string; labelNames?: readonly string[]; registers?: readonly unknown[] }) {
          this.name = cfg.name
          registered.push({ name: cfg.name, labelNames: cfg.labelNames })
        }
        set(labels: Record<string, string> | number, value?: number): void {
          calls.push(`${this.name}${JSON.stringify(labels)}=${value}`)
        }
      },
    }
    const m = createMetrics({ registry, factory })
    expect(registered).toEqual([
      { name: 'agentchat_channel_disconnect_total', labelNames: ['code', 'initiator'] },
      { name: 'agentchat_channel_error_total', labelNames: ['errorClass'] },
      { name: 'agentchat_channel_connection_state', labelNames: ['kind'] },
      { name: 'agentchat_channel_wake_total', labelNames: ['source'] },
    ])
    m.incWake({ source: 'message' })
    m.incDisconnect({ code: '4000', initiator: 'client' })
    m.incError({ errorClass: 'auth' })
    m.setConnectionState('ready')
    expect(calls).toEqual([
      'agentchat_channel_wake_total{"source":"message"}',
      'agentchat_channel_disconnect_total{"code":"4000","initiator":"client"}',
      'agentchat_channel_error_total{"errorClass":"auth"}',
      'agentchat_channel_connection_state{"kind":"ready"}=1',
    ])
    expect(m.snapshot).toBeUndefined() // a registry is read by scraping
  })
})

describe('createInMemoryMetrics (the gateway recorder)', () => {
  it('starts empty, counts by bounded label, and snapshots sorted plain objects', () => {
    const m = createInMemoryMetrics()
    expect(m.snapshot()).toEqual({ state: 'idle', wakes: {}, disconnects: {}, errors: {} })
    m.setConnectionState('connecting')
    m.setConnectionState('ready')
    m.incWake({ source: 'connect' })
    m.incWake({ source: 'message' })
    m.incWake({ source: 'message' })
    m.incWake({ source: 'retry' })
    m.incDisconnect({ code: '1006', initiator: 'server' })
    m.incDisconnect({ code: '4000', initiator: 'client' })
    m.incDisconnect({ code: '1006', initiator: 'server' })
    m.incError({ errorClass: 'transport' })
    m.incError({ errorClass: 'auth' })
    expect(m.snapshot()).toEqual({
      state: 'ready',
      wakes: { connect: 1, message: 2, retry: 1 },
      disconnects: { '1006/server': 2, '4000/client': 1 },
      errors: { auth: 1, transport: 1 },
    })
    // A snapshot is a copy: later counts do not leak into it.
    const before = m.snapshot()
    m.incWake({ source: 'message' })
    expect(before.wakes).toEqual({ connect: 1, message: 2, retry: 1 })
    expect(m.snapshot().wakes.message).toBe(3)
  })
})

describe('createNoopMetrics', () => {
  it('accepts every call and keeps nothing', () => {
    const m = createNoopMetrics()
    m.incWake({ source: 'message' })
    m.incDisconnect({ code: '1006', initiator: 'server' })
    m.incError({ errorClass: 'other' })
    m.setConnectionState('ready')
    expect(m.snapshot).toBeUndefined()
  })
})
