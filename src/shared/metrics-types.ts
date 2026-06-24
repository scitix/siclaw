/**
 * Shared data types for the Prometheus federation path (K8s mode).
 *
 * Business metrics and long-term trends go to external Grafana via the federated
 * prom-client /metrics series; session auditing uses the durable
 * chat_messages/chat_sessions tables directly.
 */

/**
 * One Prometheus metric family from prom-client's `registry.getMetricsAsJSON()`.
 *
 * For counters/gauges, each `values` entry is one labelled sample (no `metricName`).
 * For histograms, prom-client expands the family into a group of counter-like
 * samples — one `_bucket{le=…}` per bucket (cumulative), plus `_sum` and `_count` —
 * and each carries `metricName` (e.g. `siclaw_prompt_duration_ms_bucket`). The
 * federation aggregator treats every histogram sub-sample as a monotonic counter,
 * which is why no histogram-specific delta logic is needed.
 */
export interface PromSampleGroup {
  name: string;
  /** Metric HELP text from getMetricsAsJSON; carried through so the federation can re-emit it. */
  help?: string;
  type: "counter" | "gauge" | "histogram" | "summary";
  values: Array<{
    labels: Record<string, string | number>;
    value: number;
    /** Present on histogram sub-samples (_bucket/_sum/_count); absent on plain counter/gauge. */
    metricName?: string;
  }>;
}

/**
 * Body of the agentbox → Gateway prom payload (K8s mode). Carried by BOTH the
 * periodic 30s pull (GET /api/internal/metrics-snapshot, gateway-initiated) and
 * the SIGTERM final-flush push (POST /api/internal/metrics-flush, agentbox-initiated);
 * the two messages are byte-identical.
 *
 * Deliberately does NOT carry a boxId/podId: the agentbox process does not know its
 * own pod name, and the Gateway must not trust a client-supplied identity anyway.
 * The Gateway derives boxId from the mTLS client certificate identity. Only the
 * per-process `incarnation` (which the process does own) and the cumulative `prom`
 * snapshot travel on the wire. See metrics-federation-DESIGN.md module 5.
 */
export interface MetricsFlushPayload {
  incarnation: string;
  prom: PromSampleGroup[];
}
