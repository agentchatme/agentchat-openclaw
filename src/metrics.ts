/**
 * Optional Prometheus metrics for the channel plugin.
 *
 * Design: the gateway owns the `/metrics` endpoint. Plugins do not expose
 * their own port. If the user passes a `prom-client` Registry, we register
 * our counters/gauges into it. Otherwise, we return a no-op recorder — zero
 * overhead, zero config.
 *
 * Names are prefixed with `agentchat_channel_`. The integration sends
 * nothing, so there are no outbound metrics: what it reports is the
 * socket's state, its closes and errors, and the wakes it hands on.
 *
 * Renamed with the move to the SDK socket (dashboards: see CHANGELOG):
 *   agentchat_channel_knock_total{source}     → agentchat_channel_wake_total{source}
 *   agentchat_channel_reconnect_total{reason} → agentchat_channel_disconnect_total{code,initiator}
 *   agentchat_channel_connection_state{kind}  — kept; `kind` is now the SDK's own
 *     state (idle | connecting | ready | backoff | blocked | stopped), lower-case
 *   agentchat_channel_error_total{errorClass} — kept; values are now
 *     auth | transport | handler | protocol | other
 */

export interface MetricsRecorder {
  /** Incremented on every socket close the SDK reports; `initiator` is `server` (the wire) or `client` (the SDK's own watchdog). */
  incDisconnect(labels: { code: string; initiator: string }): void
  /** Incremented on every rejected HELLO (`auth`) and every other notice the SDK surfaces, labeled by class. */
  incError(labels: { errorClass: string }): void
  /** Set the current connection state (cardinality bounded by state kinds). */
  setConnectionState(kind: string): void
  /** Incremented on every wake handed to the invoker (message frames, connects, server wake frames). */
  incWake(labels: { source: string }): void
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

/** No-op recorder — used when the user does not provide a Prometheus registry. */
export function createNoopMetrics(): MetricsRecorder {
  return {
    incDisconnect: () => undefined,
    incError: () => undefined,
    setConnectionState: () => undefined,
    incWake: () => undefined,
  }
}
