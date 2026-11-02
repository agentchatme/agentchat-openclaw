/**
 * Optional Prometheus metrics for the channel plugin.
 *
 * Design: the gateway owns the `/metrics` endpoint. Plugins do not expose
 * their own port. If the user passes a `prom-client` Registry, we register
 * our counters/gauges into it. Otherwise, we return a no-op recorder — zero
 * overhead, zero config.
 *
 * Names are prefixed with `agentchat_channel_` for easy scraping. The
 * doorbell sends nothing, so there are no outbound metrics: what it reports
 * is the socket's state and its knocks.
 */

export interface MetricsRecorder {
  /** Incremented on every reconnect attempt. */
  incReconnect(labels: { reason: string }): void
  /** Incremented on every transport/channel error, labeled by error class. */
  incError(labels: { errorClass: string }): void
  /** Set the current connection state (cardinality bounded by state kinds). */
  setConnectionState(kind: string): void
  /** Incremented on every knock handed to the invoker. */
  incKnock(labels: { source: string }): void
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

  const reconnects = new factory.Counter({
    name: 'agentchat_channel_reconnect_total',
    help: 'WebSocket reconnect attempts.',
    labelNames: ['reason'],
    registers: [registry],
  })

  const errors = new factory.Counter({
    name: 'agentchat_channel_error_total',
    help: 'Transport and channel errors, labeled by error class.',
    labelNames: ['errorClass'],
    registers: [registry],
  })

  const connectionState = new factory.Gauge({
    name: 'agentchat_channel_connection_state',
    help: 'Current connection state (1 = active kind, 0 = otherwise).',
    labelNames: ['kind'],
    registers: [registry],
  })

  const knocks = new factory.Counter({
    name: 'agentchat_channel_knock_total',
    help: 'Knocks handed to the doorbell (message frames and connects).',
    labelNames: ['source'],
    registers: [registry],
  })

  return {
    incReconnect: ({ reason }) => reconnects.inc({ reason }),
    incError: ({ errorClass }) => errors.inc({ errorClass }),
    setConnectionState: (kind) => connectionState.set({ kind }, 1),
    incKnock: ({ source }) => knocks.inc({ source }),
  }
}

/** No-op recorder — used when the user does not provide a Prometheus registry. */
export function createNoopMetrics(): MetricsRecorder {
  return {
    incReconnect: () => undefined,
    incError: () => undefined,
    setConnectionState: () => undefined,
    incKnock: () => undefined,
  }
}
