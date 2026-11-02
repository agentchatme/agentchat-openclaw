import { describe, expect, it } from 'vitest'

import { KnockCoalescer } from '../../src/doorbell/knock.js'

interface Scheduled {
  id: number
  fireAt: number
  fn: () => void
}

class Clock {
  now = 0
  private next = 1
  pending: Scheduled[] = []
  setTimeout = (fn: () => void, ms: number): NodeJS.Timeout => {
    const t = { id: this.next++, fireAt: this.now + ms, fn }
    this.pending.push(t)
    return t.id as unknown as NodeJS.Timeout
  }
  clearTimeout = (h: NodeJS.Timeout): void => {
    this.pending = this.pending.filter((t) => (t.id as unknown as NodeJS.Timeout) !== h)
  }
  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      this.pending.sort((a, b) => a.fireAt - b.fireAt)
      const n = this.pending[0]
      if (!n || n.fireAt > target) break
      this.now = n.fireAt
      this.pending.shift()
      n.fn()
    }
    this.now = target
  }
}

function make(debounceMs = 2000) {
  const clock = new Clock()
  let fires = 0
  const c = new KnockCoalescer({
    onFire: () => {
      fires += 1
    },
    debounceMs,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  return { clock, c, fires: () => fires }
}

describe('KnockCoalescer', () => {
  it('a burst of knocks inside the window fires exactly once, after the window', () => {
    const { clock, c, fires } = make()
    for (let i = 0; i < 20; i++) c.knock()
    expect(c.armed).toBe(true)
    expect(fires()).toBe(0)
    clock.advance(1999)
    expect(fires()).toBe(0)
    clock.advance(1)
    expect(fires()).toBe(1)
    expect(c.knocks).toBe(20)
    expect(c.absorbed).toBe(19)
    expect(c.armed).toBe(false)
  })

  it('trailing edge: a slow burst (knocks 1.2 s apart) is ONE cycle, fired 2 s after the last knock', () => {
    const { clock, c, fires } = make()
    c.knock()
    clock.advance(1200)
    c.knock()
    clock.advance(1200)
    c.knock()
    expect(fires()).toBe(0) // 2.4 s after the first knock: a leading-edge window would have fired already
    clock.advance(1999)
    expect(fires()).toBe(0)
    clock.advance(1)
    expect(fires()).toBe(1) // 2 s after the LAST knock
    expect(c.absorbed).toBe(2)
  })

  it('hard cap: a steady trickle cannot starve the gate — fires at most 6 s after the first knock', () => {
    const { clock, c, fires } = make()
    c.knock()
    for (let i = 0; i < 10; i++) {
      clock.advance(1000)
      c.knock()
      if (fires() > 0) break
    }
    expect(fires()).toBe(1)
    expect(clock.now).toBe(6000)
    // and the knock that landed after the cap opens a new burst
    expect(c.armed).toBe(true)
  })

  it('a knock exactly at the cap fires immediately', () => {
    const { clock, c, fires } = make()
    c.knock()
    clock.advance(5500)
    c.knock() // debounce would want 7500; cap says 6000
    clock.advance(500)
    expect(fires()).toBe(1)
  })

  it('rejects a cap shorter than the window', () => {
    expect(() => new KnockCoalescer({ onFire: () => undefined, debounceMs: 2000, maxWindowMs: 1000 })).toThrow(RangeError)
  })

  it('a knock after the fire arms again', () => {
    const { clock, c, fires } = make()
    c.knock()
    clock.advance(2000)
    c.knock()
    clock.advance(2000)
    expect(fires()).toBe(2)
  })

  it('knockAfter keeps the sooner pending deadline', () => {
    const { clock, c, fires } = make()
    c.knockAfter(60_000)
    c.knockAfter(300_000) // a later retry never pushes the sooner one back
    expect(c.delayedPending).toBe(true)
    clock.advance(60_000 + 2000)
    expect(fires()).toBe(1)
    clock.advance(300_000)
    expect(fires()).toBe(1) // the later request was dropped, not queued
  })

  it('knockAfter with a sooner deadline replaces a later pending one', () => {
    const { clock, c, fires } = make()
    c.knockAfter(300_000)
    c.knockAfter(60_000)
    clock.advance(60_000 + 2000)
    expect(fires()).toBe(1)
  })

  it('an immediate knock still fires on its own schedule while a retry is pending', () => {
    const { clock, c, fires } = make()
    c.knockAfter(60_000)
    c.knock()
    clock.advance(2000)
    expect(fires()).toBe(1)
    expect(c.delayedPending).toBe(true)
    clock.advance(60_000)
    expect(fires()).toBe(2)
  })

  it('stop cancels everything and ignores later knocks', () => {
    const { clock, c, fires } = make()
    c.knock()
    c.knockAfter(60_000)
    c.stop()
    c.knock()
    clock.advance(100_000)
    expect(fires()).toBe(0)
    expect(c.armed).toBe(false)
    expect(c.delayedPending).toBe(false)
  })

  it('a throwing onFire does not break the next knock', () => {
    const clock = new Clock()
    let calls = 0
    const c = new KnockCoalescer({
      onFire: () => {
        calls += 1
        throw new Error('boom')
      },
      debounceMs: 10,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    c.knock()
    expect(() => clock.advance(10)).not.toThrow()
    c.knock()
    clock.advance(10)
    expect(calls).toBe(2)
  })

  it('rejects a negative debounce', () => {
    expect(() => new KnockCoalescer({ onFire: () => undefined, debounceMs: -1 })).toThrow(RangeError)
  })
})
