/**
 * Shared data types for the Monitoring Dashboard (pull-based counter + top-N only).
 *
 * Time-series buckets and session_stats persistence were intentionally removed —
 * long-term trends go to external Grafana (via prom-client /metrics), and session
 * auditing uses the durable chat_messages/chat_sessions tables directly.
 */

/** Tool call ranking entry */
export interface ToolCallStats {
  toolName: string;
  userId: string;
  agentId: string | null;
  success: number;
  error: number;
  total: number;
}

/** Skill call ranking entry */
export interface SkillCallStats {
  skillName: string;
  scope: "builtin" | "global";
  userId: string;
  agentId: string | null;
  success: number;
  error: number;
  total: number;
  avgDurationMs: number;
}

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
 * Body of the SIGTERM final-flush push (agentbox → Gateway, K8s mode).
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

/** Snapshot exported by LocalCollector for Gateway pull (K8s mode) */
export interface MetricsSnapshot {
  /** Current in-process active sessions (instantaneous) */
  activeSessions: number;
  /** Tool-call cumulative deltas since last export; exporter clears its map after snapshot */
  toolCallDeltas: ToolCallStats[];
  /** Skill-call cumulative deltas since last export; exporter clears its map after snapshot */
  skillCallDeltas: SkillCallStats[];
  /**
   * Per-process start nonce. Distinguishes two process incarnations that share the
   * same boxId (boxId is derived from agentId only and is reused when a pod is
   * rebuilt). The federation aggregator keys lastSeen on (boxId, incarnation) so a
   * rebuilt pod is treated as a fresh series rather than diffed against the stale
   * counter values of the previous incarnation.
   *
   * Optional: only the federation path (K8s mode) sets it; local-mode callers omit it.
   */
  incarnation?: string;
  /**
   * Raw `getMetricsAsJSON()` cumulative snapshot of this process's prom-client
   * registry — feeds the Prometheus federation path (path ②).
   *
   * CONTRACT: these are CUMULATIVE current values and MUST NOT be cleared on read
   * (unlike toolCallDeltas/skillCallDeltas, which are clear-on-read). Clearing them
   * would break the aggregator's delta comparison against lastSeen.
   *
   * Optional: only the federation path (K8s mode) populates it.
   */
  prom?: PromSampleGroup[];
}
