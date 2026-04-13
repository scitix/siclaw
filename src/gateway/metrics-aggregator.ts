/**
 * MetricsAggregator — Runtime-side metrics aggregation.
 *
 * Two modes:
 * - **Local**: Proxies LocalCollector (same process).
 * - **K8s**: Runs a 30s pull loop fetching metrics from AgentBox pods.
 *
 * Stateless — no DB writes. Metrics are kept in-memory only.
 */

import { onDiagnostic } from "../shared/diagnostic-events.js";
import {
  type MetricsBucket,
  type ToolCallStats,
  type SkillCallStats,
  type MetricsSnapshot,
} from "../shared/metrics-types.js";

const MAX_BUCKETS = 1440;

/** Interface for LocalCollector dependency injection (Local mode only) */
export interface LocalCollectorRef {
  query(range: "1h" | "6h" | "24h"): MetricsBucket[];
  snapshot(): { activeSessions: number; wsConnections: number };
  topTools(n: number): ToolCallStats[];
  topSkills(n: number): SkillCallStats[];
}

/** Interface for pod listing (K8s mode only) */
export interface PodLister {
  list(): Promise<Array<{ boxId: string; endpoint: string; status: string }>>;
}

/** Interface for making mTLS requests to AgentBox pods */
export interface SnapshotFetcher {
  fetch(endpoint: string): Promise<MetricsSnapshot | null>;
}

export class MetricsAggregator {
  private ringBuffer = new Map<number, MetricsBucket>();
  private toolCallMap = new Map<string, { success: number; error: number }>();
  private skillCallMap = new Map<string, {
    scope: "builtin" | "global" | "personal" | "skillset";
    success: number;
    error: number;
    totalDurationMs: number;
  }>();
  private wsConnections = 0;
  private pullTimer?: ReturnType<typeof setInterval>;

  constructor(
    private mode: "local" | "k8s",
    private localRef?: LocalCollectorRef,
    private podLister?: PodLister,
    private snapshotFetcher?: SnapshotFetcher,
  ) {
    onDiagnostic((event) => {
      if (event.type === "ws_connected") this.wsConnections++;
      if (event.type === "ws_disconnected") this.wsConnections = Math.max(0, this.wsConnections - 1);
    });

    if (mode === "k8s") {
      this.startPullLoop();
    }
  }

  query(range: "1h" | "6h" | "24h"): MetricsBucket[] {
    if (this.mode === "local" && this.localRef) {
      const buckets = this.localRef.query(range);
      for (const b of buckets) b.wsConnections = this.wsConnections;
      return buckets;
    }

    const rangeMs = range === "1h" ? 3_600_000 : range === "6h" ? 21_600_000 : 86_400_000;
    const cutoff = Math.floor(Date.now() / 60_000) * 60_000 - rangeMs;
    const result: MetricsBucket[] = [];
    for (const [ts, bucket] of this.ringBuffer) {
      if (ts >= cutoff) result.push({ ...bucket, wsConnections: this.wsConnections });
    }
    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  snapshot(): { activeSessions: number; wsConnections: number } {
    if (this.mode === "local" && this.localRef) {
      return { activeSessions: this.localRef.snapshot().activeSessions, wsConnections: this.wsConnections };
    }
    let activeSessions = 0;
    let latestTs = 0;
    for (const [ts, bucket] of this.ringBuffer) {
      if (ts > latestTs) { latestTs = ts; activeSessions = bucket.activeSessions; }
    }
    return { activeSessions, wsConnections: this.wsConnections };
  }

  topTools(n: number): ToolCallStats[] {
    if (this.mode === "local" && this.localRef) return this.localRef.topTools(n);
    const result: ToolCallStats[] = [];
    for (const [toolName, entry] of this.toolCallMap) {
      result.push({ toolName, success: entry.success, error: entry.error, total: entry.success + entry.error });
    }
    return result.sort((a, b) => b.total - a.total).slice(0, n);
  }

  topSkills(n: number): SkillCallStats[] {
    if (this.mode === "local" && this.localRef) return this.localRef.topSkills(n);
    return [...this.skillCallMap.entries()]
      .map(([skillName, v]) => {
        const total = v.success + v.error;
        return { skillName, scope: v.scope, success: v.success, error: v.error, total, avgDurationMs: total > 0 ? Math.round(v.totalDurationMs / total) : 0 };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, n);
  }

  private startPullLoop(): void {
    this.pullTimer = setInterval(() => {
      this.pullAll().catch((err) => console.warn("[metrics-aggregator] pull loop error:", err));
    }, 30_000);
  }

  private async pullAll(): Promise<void> {
    if (!this.podLister || !this.snapshotFetcher) return;
    const pods = await this.podLister.list();
    const results = await Promise.allSettled(
      pods.filter((p) => p.status === "running" && p.endpoint).map((p) => this.snapshotFetcher!.fetch(p.endpoint)),
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) this.mergeSnapshot(result.value);
    }
  }

  private mergeSnapshot(snapshot: MetricsSnapshot): void {
    for (const bucket of snapshot.buckets) {
      const existing = this.ringBuffer.get(bucket.timestamp);
      if (existing) {
        existing.tokensInput += bucket.tokensInput;
        existing.tokensOutput += bucket.tokensOutput;
        existing.tokensCacheRead += bucket.tokensCacheRead;
        existing.tokensCacheWrite += bucket.tokensCacheWrite;
        existing.promptCount += bucket.promptCount;
        existing.promptErrors += bucket.promptErrors;
        existing.promptDurationSum += bucket.promptDurationSum;
        existing.promptDurationMax = Math.max(existing.promptDurationMax, bucket.promptDurationMax);
        existing.activeSessions += bucket.activeSessions;
        existing.toolCalls += bucket.toolCalls;
        existing.toolErrors += bucket.toolErrors;
        existing.skillSuccesses += bucket.skillSuccesses;
        existing.skillErrors += bucket.skillErrors;
      } else {
        this.ringBuffer.set(bucket.timestamp, { ...bucket });
      }
    }

    if (this.ringBuffer.size > MAX_BUCKETS) {
      const sorted = [...this.ringBuffer.keys()].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length - MAX_BUCKETS; i++) this.ringBuffer.delete(sorted[i]);
    }

    for (const delta of snapshot.toolCallDeltas) {
      const existing = this.toolCallMap.get(delta.toolName);
      if (existing) { existing.success += delta.success; existing.error += delta.error; }
      else this.toolCallMap.set(delta.toolName, { success: delta.success, error: delta.error });
    }

    for (const delta of snapshot.skillCallDeltas) {
      const totalDelta = delta.success + delta.error;
      const existing = this.skillCallMap.get(delta.skillName);
      if (existing) {
        existing.success += delta.success;
        existing.error += delta.error;
        existing.totalDurationMs += delta.avgDurationMs * totalDelta;
      } else {
        this.skillCallMap.set(delta.skillName, { scope: delta.scope, success: delta.success, error: delta.error, totalDurationMs: delta.avgDurationMs * totalDelta });
      }
    }
  }

  destroy(): void {
    if (this.pullTimer) { clearInterval(this.pullTimer); this.pullTimer = undefined; }
  }
}
