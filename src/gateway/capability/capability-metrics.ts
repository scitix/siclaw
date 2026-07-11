import { Counter, Gauge, Histogram } from "prom-client";

import { federationSelfRegistry } from "../federation-self-metrics.js";

// Gateway-native capability lifecycle metrics. Labels are deliberately bounded:
// repo/run/operation identifiers belong in traces and logs, never Prometheus.
export const capabilityStartsTotal = new Counter({
  name: "siclaw_gateway_capability_starts_total",
  help: "Capability start attempts by outcome",
  labelNames: ["outcome"] as const,
  registers: [federationSelfRegistry],
});

export const capabilityStartDurationMs = new Histogram({
  name: "siclaw_gateway_capability_start_duration_ms",
  help: "End-to-end capability start and box setup duration in milliseconds",
  labelNames: ["outcome"] as const,
  buckets: [100, 500, 1_000, 3_000, 10_000, 30_000, 60_000, 120_000],
  registers: [federationSelfRegistry],
});

export const capabilityActiveRuns = new Gauge({
  name: "siclaw_gateway_capability_active_runs",
  help: "Non-terminal capability runs currently tracked by this Runtime",
  registers: [federationSelfRegistry],
});

export const capabilityMaterializationFailuresTotal = new Counter({
  name: "siclaw_gateway_capability_materialization_failures_total",
  help: "Fail-closed capability input materialization failures by stable stage",
  labelNames: ["stage"] as const,
  registers: [federationSelfRegistry],
});

export const capabilityRelayFailuresTotal = new Counter({
  name: "siclaw_gateway_capability_relay_failures_total",
  help: "Capability box event relays that ended with an error",
  registers: [federationSelfRegistry],
});
