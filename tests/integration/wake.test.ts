import { describe, expect, it } from 'vitest'

import { WakeCoalescer } from '../../src/integration/wake.js'
import { Clock } from '../helpers/clock.js'

function make(debounceMs = 2000) {
  const clock = new Clock()
  let fires = 0
  const c = new WakeCoalescer({
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

describe('WakeCoalescer', () => {
  it('a burst of wakes inside the window fires exactly once, after the window', () => {
    const { clock, c, fires } = make()
    for (let i = 0; i < 20; i++) c.wake()
    expect(c.armed).toBe(true)
    expect(fires()).toBe(0)
    clock.advance(1999)
    expect(fires()).toBe(0)
    clock.advance(1)
    expect(fires()).toBe(1)
    expect(c.wakes).toBe(20)
    expect(c.absorbed).toBe(19)
    expect(c.armed).toBe(false)
  })

  it('trailing edge: a slow burst (wakes 1.2 s apart) is ONE cycle, fired 2 s after the last wake', () => {
    const { clock, c, fires } = make()
    c.wake()
    clock.advance(1200)
    c.wake()
    clock.advance(1200)
    c.wake()
    expect(fires()).toBe(0) // 2.4 s after the first wake: a leading-edge window would have fired already
    clock.advance(1999)
    expect(fires()).toBe(0)
    clock.advance(1)
    expect(fires()).toBe(1) // 2 s after the LAST wake
    expect(c.absorbed).toBe(2)
  })

  it('hard cap: a steady trickle cannot starve the gate — fires at most 6 s after the first wake', () => {
    const { clock, c, fires } = make()
    c.wake()
    for (let i = 0; i < 10; i++) {
      clock.advance(1000)
      c.wake()
      if (fires() > 0) break
    }
    expect(fires()).toBe(1)
    expect(clock.now).toBe(6000)
    // and the wake that landed after the cap opens a new burst
    expect(c.armed).toBe(true)
  })

  it('a wake exactly at the cap fires immediately', () => {
    const { clock, c, fires } = make()
    c.wake()
    clock.advance(5500)
    c.wake() // debounce would want 7500; cap says 6000
    clock.advance(500)
    expect(fires()).toBe(1)
  })

  it('rejects a cap shorter than the window', () => {
    expect(() => new WakeCoalescer({ onFire: () => undefined, debounceMs: 2000, maxWindowMs: 1000 })).toThrow(RangeError)
  })

  it('a wake after the fire arms again', () => {
    const { clock, c, fires } = make()
    c.wake()
    clock.advance(2000)
    c.wake()
    clock.advance(2000)
    expect(fires()).toBe(2)
  })

  it('wakeAfter keeps the sooner pending deadline', () => {
    const { clock, c, fires } = make()
    c.wakeAfter(60_000)
    c.wakeAfter(300_000) // a later retry never pushes the sooner one back
    expect(c.delayedPending).toBe(true)
    clock.advance(60_000 + 2000)
    expect(fires()).toBe(1)
    clock.advance(300_000)
    expect(fires()).toBe(1) // the later request was dropped, not queued
  })

  it('wakeAfter with a sooner deadline replaces a later pending one', () => {
    const { clock, c, fires } = make()
    c.wakeAfter(300_000)
    c.wakeAfter(60_000)
    clock.advance(60_000 + 2000)
    expect(fires()).toBe(1)
  })

  it('an immediate wake still fires on its own schedule while a retry is pending', () => {
    const { clock, c, fires } = make()
    c.wakeAfter(60_000)
    c.wake()
    clock.advance(2000)
    expect(fires()).toBe(1)
    expect(c.delayedPending).toBe(true)
    clock.advance(60_000)
    expect(fires()).toBe(2)
  })

  it('stop cancels everything and ignores later wakes', () => {
    const { clock, c, fires } = make()
    c.wake()
    c.wakeAfter(60_000)
    c.stop()
    c.wake()
    clock.advance(100_000)
    expect(fires()).toBe(0)
    expect(c.armed).toBe(false)
    expect(c.delayedPending).toBe(false)
  })

  it('a throwing onFire does not break the next wake', () => {
    const clock = new Clock()
    let calls = 0
    const c = new WakeCoalescer({
      onFire: () => {
        calls += 1
        throw new Error('boom')
      },
      debounceMs: 10,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    c.wake()
    expect(() => clock.advance(10)).not.toThrow()
    c.wake()
    clock.advance(10)
    expect(calls).toBe(2)
  })

  it('rejects a negative debounce', () => {
    expect(() => new WakeCoalescer({ onFire: () => undefined, debounceMs: -1 })).toThrow(RangeError)
  })
})
