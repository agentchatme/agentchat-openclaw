import { afterEach, describe, it, expect } from 'vitest'

import {
  recordAgentSend,
  hasAgentSendSince,
  resetSendTrackerForTest,
} from '../../src/binding/send-tracker.js'

describe('send-tracker', () => {
  afterEach(() => {
    resetSendTrackerForTest()
  })

  it('reports a send at or after the given start time', () => {
    recordAgentSend('default', 'conv_a', 1_000)
    expect(hasAgentSendSince('default', 'conv_a', 1_000)).toBe(true)
    expect(hasAgentSendSince('default', 'conv_a', 999)).toBe(true)
    expect(hasAgentSendSince('default', 'conv_a', 1_001)).toBe(false)
  })

  it('is scoped by conversation and account', () => {
    recordAgentSend('default', 'conv_a', 1_000)
    expect(hasAgentSendSince('default', 'conv_b', 0)).toBe(false)
    expect(hasAgentSendSince('other', 'conv_a', 0)).toBe(false)
  })

  it('ignores empty conversation ids', () => {
    recordAgentSend('default', '', 1_000)
    expect(hasAgentSendSince('default', '', 0)).toBe(false)
  })

  it('keeps the newest timestamp for a conversation', () => {
    recordAgentSend('default', 'conv_a', 1_000)
    recordAgentSend('default', 'conv_a', 2_000)
    expect(hasAgentSendSince('default', 'conv_a', 1_500)).toBe(true)
  })

  it('prunes the stalest entries beyond the cap without losing fresh ones', () => {
    for (let i = 0; i < 600; i++) {
      recordAgentSend('default', `conv_${i}`, i)
    }
    // Freshest survives; the very first entries were pruned.
    expect(hasAgentSendSince('default', 'conv_599', 0)).toBe(true)
    expect(hasAgentSendSince('default', 'conv_0', 0)).toBe(false)
  })
})
