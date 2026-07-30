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
 * `boxId` is a CLAIM, not an identity. Every box of an agent presents the same
 * certificate, so the cert alone can no longer say which replica is reporting — but the
 * Gateway still must not simply believe a client. The cert's own boxId is the agent's
 * BASE pod name, and the Gateway accepts a claim only if it is that base or one of its
 * instance suffixes, so a box can name itself precisely and can never name another
 * agent's. An absent or unacceptable claim falls back to the cert value, which is what
 * every pre-replica box reported. See `handleMetricsFlush`.
 */
export interface MetricsFlushPayload {
  incarnation: string;
  prom: PromSampleGroup[];
  /** This pod's name (downward API). Authorized against the certificate, never trusted raw. */
  boxId?: string;
}
