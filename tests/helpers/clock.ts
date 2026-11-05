/** A manual clock with injectable setTimeout/clearTimeout, for timer-driven units. */

interface Scheduled {
  id: number
  fireAt: number
  fn: () => void
}

export class Clock {
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
