/**
 * Counters for the integration: the socket's state, its closes and the
 * notices the SDK surfaces, and the wakes handed to the invoker. The
 * integration sends nothing, so there are no outbound metrics.
 *
 * Where they can be read. OpenClaw gives a plugin no Prometheus registry:
 * its `/api/diagnostics/prometheus` (the `diagnostics-prometheus` plugin)
 * renders a fixed catalog of `openclaw_*` families from trusted or
 * dispatcher-owned diagnostic events, and a third-party plugin's
 * `emitDiagnosticEvent` is untrusted by definition and dropped by that
 * exporter. So inside the gateway these counters are kept in memory
 * (`createInMemoryMetrics`) and shown by the status probe
 * (`openclaw channels capabilities --channel agentchat`, the `socket —`
 * line). `createMetrics` registers the same counters into a `prom-client`
 * registry for a host that runs the plugin's classes in its own process and
 * owns a scrape endpoint; `createNoopMetrics` is the zero-cost default.
 *
 * Names are prefixed with `agentchat_channel_` (dashboards: see CHANGELOG):
 *   agentchat_channel_wake_total{source}              — message | connect | reminder | unanswered | invite | other
 *   agentchat_channel_disconnect_total{code,initiator} — initiator = server (the wire) | client (the SDK's own watchdog)
 *   agentchat_channel_connection_state{kind}          — the SDK's state: idle | connecting | ready | backoff | blocked | stopped
 *   agentchat_channel_error_total{errorClass}         — auth (one per rejected HELLO) | transport | handler | protocol | other
 */

/** The counters so far, as the in-memory recorder keeps them. */
export interface MetricsSnapshot {
  /** The connection state last set (the gauge's active kind). */
  readonly state: string
  /** Wakes by source. */
  readonly wakes: Readonly<Record<string, number>>
  /** Socket closes by `<code>/<initiator>`, e.g. `1006/server`, `4000/client`. */
  readonly disconnects: Readonly<Record<string, number>>
  /** Rejected HELLOs (`auth`) and the SDK's other notices, by class. */
  readonly errors: Readonly<Record<string, number>>
}

export interface MetricsRecorder {
  /** Incremented on every socket close the SDK reports; `initiator` is `server` (the wire) or `client` (the SDK's own watchdog). */
  incDisconnect(labels: { code: string; initiator: string }): void
  /** Incremented on every rejected HELLO (`auth`) and every other notice the SDK surfaces, labeled by class. */
  incError(labels: { errorClass: string }): void
  /** Set the current connection state (cardinality bounded by state kinds). */
  setConnectionState(kind: string): void
  /** Incremented on every wake handed to the invoker (message frames, connects, server wake frames, the ladder's retries). */
  incWake(labels: { source: string }): void
  /** The counters so far, when the recorder keeps them (the in-memory one does; a prom-client registry is read by scraping). */
  snapshot?(): MetricsSnapshot
}

/** Minimal contract for a prom-client-compatible registry. */
export interface PromRegistryLike {
  registerMetric(metric: unknown): void
}

/** Minimal contract for a prom-client factory; avoids a hard dep on `prom-client`. */
export interface PromFactory {
  Counter: new (cfg: MetricConfig) => {
    inc(labels?: Record<string, string>, value?: number): void
  }
  Gauge: new (cfg: MetricConfig) => {
    set(labelsOrValue: Record<string, string> | number, value?: number): void
  }
}

interface MetricConfig {
  name: string
  help: string
  labelNames?: readonly string[]
  registers?: readonly unknown[]
}

export interface CreateMetricsOptions {
  registry: PromRegistryLike
  factory: PromFactory
}

/** The recorder for a host with a `prom-client` registry and a scrape endpoint of its own. */
export function createMetrics(options: CreateMetricsOptions): MetricsRecorder {
  const { registry, factory } = options

  const disconnects = new factory.Counter({
    name: 'agentchat_channel_disconnect_total',
    help: 'WebSocket closes reported by the SDK, by close code and initiator (server | client).',
    labelNames: ['code', 'initiator'],
    registers: [registry],
  })

  const errors = new factory.Counter({
    name: 'agentchat_channel_error_total',
    help: 'Rejected HELLOs (auth) and the other notices the SDK surfaced, labeled by error class.',
    labelNames: ['errorClass'],
    registers: [registry],
  })

  const connectionState = new factory.Gauge({
    name: 'agentchat_channel_connection_state',
    help: 'Current connection state (1 = active kind, 0 = otherwise).',
    labelNames: ['kind'],
    registers: [registry],
  })

  const wakes = new factory.Counter({
    name: 'agentchat_channel_wake_total',
    help: 'Wakes handed to the integration (message frames, connects, server wake frames).',
    labelNames: ['source'],
    registers: [registry],
  })

  return {
    incDisconnect: ({ code, initiator }) => disconnects.inc({ code, initiator }),
    incError: ({ errorClass }) => errors.inc({ errorClass }),
    setConnectionState: (kind) => connectionState.set({ kind }, 1),
    incWake: ({ source }) => wakes.inc({ source }),
  }
}

/**
 * The recorder the gateway binding uses: the same counters, kept in memory
 * and read by the status probe. Label sets are bounded by construction
 * (fixed source / class / state vocabularies, close codes from the wire).
 */
export function createInMemoryMetrics(): MetricsRecorder & { snapshot(): MetricsSnapshot } {
  let state = 'idle'
  const wakes = new Map<string, number>()
  const disconnects = new Map<string, number>()
  const errors = new Map<string, number>()
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  const plain = (map: Map<string, number>): Record<string, number> => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
  return {
    incDisconnect: ({ code, initiator }) => bump(disconnects, `${code}/${initiator}`),
    incError: ({ errorClass }) => bump(errors, errorClass),
    setConnectionState: (kind) => {
      state = kind
    },
    incWake: ({ source }) => bump(wakes, source),
    snapshot: () => ({ state, wakes: plain(wakes), disconnects: plain(disconnects), errors: plain(errors) }),
  }
}

/** No-op recorder — zero overhead when nothing reads the counters. */
export function createNoopMetrics(): MetricsRecorder {
  return {
    incDisconnect: () => undefined,
    incError: () => undefined,
    setConnectionState: () => undefined,
    incWake: () => undefined,
  }
}
