/**
 * Wake coalescing — one gate cycle per burst, not per frame.
 *
 * A `message.new` frame, a `wake` frame and a successful connect are all
 * wakes: a hint that the tray changed, never the carrier of what changed. A
 * group burst arrives as many frames seconds apart; the server already
 * bundles its webhook wakes for such bursts, and the integration does the
 * same for the socket. The window is trailing-edge: every wake restarts it,
 * so the cycle fires `debounceMs` after the LAST wake of the burst — with a
 * hard cap: no later than `maxWindowMs` after the FIRST wake, so a steady
 * trickle cannot starve the gate. Whoever fires then reads the whole tray,
 * so nothing a later frame announced is missed — the tray is the truth, the
 * wake is not.
 *
 * `wakeAfter` serves the local retry ladder: when a gate cycle could not
 * complete (model unreachable, server error, turn refused) the invoker
 * schedules another wake later instead of dropping the tray. The server's
 * own ladder only rings webhooks; a connected socket gets no re-ring, so the
 * integration carries that duty itself. When a delayed wake is already
 * pending the SOONER deadline wins — a later retry never pushes an earlier
 * one back.
 */

export const DEFAULT_DEBOUNCE_MS = 2_000
/** A burst fires at most this long after its first wake, however many wakes keep landing. */
export const DEFAULT_MAX_WINDOW_MS = 6_000

export interface WakeCoalescerOptions {
  readonly onFire: () => void
  /** Called when a delayed (retry-ladder) wake fires, before it is counted like any other wake. */
  readonly onDelayedWake?: () => void
  readonly debounceMs?: number
  readonly maxWindowMs?: number
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout
  readonly clearTimeout?: (handle: NodeJS.Timeout) => void
}

export class WakeCoalescer {
  private readonly onFire: () => void
  private readonly onDelayedWake: (() => void) | undefined
  private readonly debounceMs: number
  private readonly maxWindowMs: number
  private readonly now: () => number
  private readonly _setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout
  private readonly _clearTimeout: (handle: NodeJS.Timeout) => void

  private timer: NodeJS.Timeout | null = null
  private burstStartedAt: number | null = null
  private delayed: NodeJS.Timeout | null = null
  private delayedDeadline: number | null = null
  private stopped = false

  wakes = 0
  absorbed = 0
  fires = 0

  constructor(options: WakeCoalescerOptions) {
    const debounce = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    if (!(debounce >= 0)) throw new RangeError('debounceMs must be >= 0')
    const maxWindow = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS
    if (!(maxWindow >= debounce)) throw new RangeError('maxWindowMs must be >= debounceMs')
    this.onFire = options.onFire
    this.onDelayedWake = options.onDelayedWake
    this.debounceMs = debounce
    this.maxWindowMs = maxWindow
    this.now = options.now ?? Date.now
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((h) => clearTimeout(h))
  }

  /** True while a debounce timer is armed. */
  get armed(): boolean {
    return this.timer !== null
  }

  /** True while a retry wake is scheduled and has not fired. */
  get delayedPending(): boolean {
    return this.delayed !== null
  }

  /**
   * A wake. The first one of a burst arms the window; every later one is
   * absorbed and restarts it (trailing edge), never past the burst's cap.
   */
  wake(): void {
    if (this.stopped) return
    this.wakes += 1
    const now = this.now()
    if (this.timer === null) {
      this.burstStartedAt = now
      this.timer = this._setTimeout(() => this.fire(), this.debounceMs)
      return
    }
    this.absorbed += 1
    const capAt = (this.burstStartedAt ?? now) + this.maxWindowMs
    const delay = Math.max(0, Math.min(this.debounceMs, capAt - now))
    this._clearTimeout(this.timer)
    this.timer = this._setTimeout(() => this.fire(), delay)
  }

  /** A delayed wake (retry ladder). The sooner pending deadline is kept. */
  wakeAfter(delayMs: number): void {
    if (this.stopped) return
    const delay = Math.max(0, delayMs)
    const deadline = this.now() + delay
    if (this.delayed !== null) {
      if (this.delayedDeadline !== null && this.delayedDeadline <= deadline) {
        return // an earlier retry is already on its way; keep it
      }
      this._clearTimeout(this.delayed)
    }
    this.delayedDeadline = deadline
    this.delayed = this._setTimeout(() => {
      this.delayed = null
      this.delayedDeadline = null
      if (this.stopped) return
      try {
        this.onDelayedWake?.()
      } catch {
        // observers never block the wake
      }
      this.wake()
    }, delay)
  }

  /** Cancel everything; later wakes are ignored. */
  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      this._clearTimeout(this.timer)
      this.timer = null
      this.burstStartedAt = null
    }
    if (this.delayed !== null) {
      this._clearTimeout(this.delayed)
      this.delayed = null
      this.delayedDeadline = null
    }
  }

  private fire(): void {
    this.timer = null
    this.burstStartedAt = null
    if (this.stopped) return
    this.fires += 1
    try {
      this.onFire()
    } catch {
      // The callback belongs to the invoker; a failure there must not kill
      // the timer machinery. The next wake re-arms as usual.
    }
  }
}
