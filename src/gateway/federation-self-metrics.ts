/**
 * Gateway-side self-monitoring registry for the Prometheus federation (K8s mode).
 *
 * 🔴 DEDUP CONTRACT (metrics-federation-DESIGN.md module 3): this registry is the
 * ONLY local-registry content the gateway exposes on /metrics in K8s mode. It must
 * contain ONLY gateway-native / federation self-monitoring metrics (all
 * `siclaw_federation_*`), which have ZERO name overlap with the federated business
 * metrics (`siclaw_tokens_total`, …) emitted by PromFederationAggregator.
 *
 * The 13 business-metric definitions registered in shared/metrics.js
 * (`metricsRegistry`) are deliberately NOT exposed in K8s mode — the gateway process
 * emits no business events there, so those series are empty, and emitting them
 * alongside the federated series of the same name would produce duplicate
 * `# TYPE` lines and break Prometheus parsing.
 *
 * Self-monitoring metric objects are added in module 4. Keeping the registry in its
 * own module lets that step register metrics without re-touching server.ts wiring.
 */

import { Counter, Gauge, Histogram, Registry } from "prom-client";

/** Dedicated registry for federation self-monitoring metrics (K8s mode). */
export const federationSelfRegistry = new Registry();

/**
 * After removing the 9090 direct-scrape path (module 6), the federator is the ONLY
 * Prometheus entry point. If it silently fails — every pull errors, flushes are
 * dropped, the series set drifts — Prometheus would show "metrics went flat", which
 * is indistinguishable from "the system genuinely went idle". These metrics make
 * federator failures observable & alertable, and are a precondition for deleting 9090.
 *
 * They live on a dedicated registry (NOT shared/metrics.js metricsRegistry, and NOT
 * federated) so their names never collide with the federated business metrics.
 */

/** Failed metric pulls from agentbox pods (replaces the old console.warn). */
export const pullFailuresTotal = new Counter({
  name: "siclaw_federation_pull_failures_total",
  help: "AgentBox metric pulls that failed (per box id)",
  labelNames: ["box_id"] as const,
  registers: [federationSelfRegistry],
});

/** Wall-clock duration of a full pull round across all pods. */
export const pullDurationMs = new Histogram({
  name: "siclaw_federation_pull_duration_ms",
  help: "Duration of one federation pull round in milliseconds",
  buckets: [10, 50, 100, 250, 500, 1_000, 3_000, 10_000],
  registers: [federationSelfRegistry],
});

/** SIGTERM final-flush frames received from agentbox pods (incremented in module 5). */
export const flushReceivedTotal = new Counter({
  name: "siclaw_federation_flush_received_total",
  help: "Final-flush frames received from AgentBox pods on shutdown",
  registers: [federationSelfRegistry],
});

/** Final-flush frames that failed to process (incremented in module 5). */
export const flushErrorsTotal = new Counter({
  name: "siclaw_federation_flush_errors_total",
  help: "Final-flush frames that failed to process",
  registers: [federationSelfRegistry],
});

/** Unix timestamp (seconds) of the last pull round that fetched at least one pod. */
export const lastSuccessTimestampSeconds = new Gauge({
  name: "siclaw_federation_last_success_timestamp_seconds",
  help: "Unix time of the last federation pull that succeeded for ≥1 pod",
  registers: [federationSelfRegistry],
});

/** Distinct (boxId, incarnation) instances currently tracked. */
export const trackedInstances = new Gauge({
  name: "siclaw_federation_tracked_instances",
  help: "Number of (boxId, incarnation) instances currently tracked",
  registers: [federationSelfRegistry],
});

/** Distinct federated series currently held (cardinality watch). */
export const seriesCount = new Gauge({
  name: "siclaw_federation_series_count",
  help: "Number of distinct federated series currently held",
  registers: [federationSelfRegistry],
});
