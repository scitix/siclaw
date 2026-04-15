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

/** Snapshot exported by LocalCollector for Gateway pull (K8s mode) */
export interface MetricsSnapshot {
  /** Current in-process active sessions (instantaneous) */
  activeSessions: number;
  /** Tool-call cumulative deltas since last export; exporter clears its map after snapshot */
  toolCallDeltas: ToolCallStats[];
  /** Skill-call cumulative deltas since last export; exporter clears its map after snapshot */
  skillCallDeltas: SkillCallStats[];
}
