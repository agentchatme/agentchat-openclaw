/**
 * Knock coalescing — one gate cycle per burst, not per frame.
 *
 * A `message.new` frame is a knock: a hint that the tray changed, never the
 * carrier of what changed. A group burst arrives as many frames seconds
 * apart; the server already bundles its *wakes* for such bursts, and the
 * doorbell does the same for the socket. The window is trailing-edge: every
 * knock restarts it, so the cycle fires `debounceMs` after the LAST knock of
 * the burst — with a hard cap: no later than `maxWindowMs` after the FIRST
 * knock, so a steady trickle cannot starve the gate. Whoever fires then
 * reads the whole tray, so nothing a later frame announced is missed — the
 * tray is the truth, the knock is not.
 *
 * `knockAfter` serves the local retry ladder: when a gate cycle could not
 * complete (model unreachable, server error) the doorbell schedules another
 * knock later instead of dropping the tray. The server's own ladder only
 * rings webhooks; a connected socket gets no re-ring, so the doorbell
 * carries that duty itself. When a delayed knock is already pending the
 * SOONER deadline wins — a later retry never pushes an earlier one back.
 */

export const DEFAULT_DEBOUNCE_MS = 2_000
/** A burst fires at most this long after its first knock, however many knocks keep landing. */
export const DEFAULT_MAX_WINDOW_MS = 6_000

export interface KnockCoalescerOptions {
  readonly onFire: () => void
  readonly debounceMs?: number
  readonly maxWindowMs?: number
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout
  readonly clearTimeout?: (handle: NodeJS.Timeout) => void
}

export class KnockCoalescer {
  private readonly onFire: () => void
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

  knocks = 0
  absorbed = 0
  fires = 0

  constructor(options: KnockCoalescerOptions) {
    const debounce = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    if (!(debounce >= 0)) throw new RangeError('debounceMs must be >= 0')
    const maxWindow = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS
    if (!(maxWindow >= debounce)) throw new RangeError('maxWindowMs must be >= debounceMs')
    this.onFire = options.onFire
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

  /** True while a retry knock is scheduled and has not fired. */
  get delayedPending(): boolean {
    return this.delayed !== null
  }

  /**
   * A knock. The first one of a burst arms the window; every later one is
   * absorbed and restarts it (trailing edge), never past the burst's cap.
   */
  knock(): void {
    if (this.stopped) return
    this.knocks += 1
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

  /** A delayed knock (retry ladder). The sooner pending deadline is kept. */
  knockAfter(delayMs: number): void {
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
      this.knock()
    }, delay)
  }

  /** Cancel everything; later knocks are ignored. */
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
      // the timer machinery. The next knock re-arms as usual.
    }
  }
}
