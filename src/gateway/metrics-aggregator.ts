/**
 * MetricsAggregator — Gateway-side metrics aggregation for the Monitoring Dashboard.
 *
 * Two modes:
 * - **Local**: Proxies LocalCollector (same process). Consumes session stats
 *   queue on `session_released` events and writes directly to Gateway DB.
 * - **K8s**: Runs a 30s pull loop fetching `/api/internal/metrics-snapshot`
 *   from all active AgentBox pods, merges buckets, and writes session stats to DB.
 *
 * In both modes, Gateway-side WS connection counts are tracked via onDiagnostic().
 * K8s mode does NOT import local-collector.ts.
 */

import crypto from "node:crypto";
import { onDiagnostic } from "../shared/diagnostic-events.js";
import {
  type MetricsBucket,
  type ToolCallStats,
  type SkillCallStats,
  type SessionStatsRecord,
  type MetricsSnapshot,
  createEmptyBucket,
} from "../shared/metrics-types.js";
import type { Database } from "./db/index.js";
import { sessionStats } from "./db/schema.js";

const MAX_BUCKETS = 1440;

/** Interface for LocalCollector dependency injection (Local mode only) */
export interface LocalCollectorRef {
  query(range: "1h" | "6h" | "24h"): MetricsBucket[];
  snapshot(): { activeSessions: number; wsConnections: number };
  topTools(n: number): ToolCallStats[];
  topSkills(n: number): SkillCallStats[];
  drainSessionStats(): SessionStatsRecord[];
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
    scope: "builtin" | "team" | "personal";
    success: number;
    error: number;
    totalDurationMs: number;
  }>();
  private wsConnections = 0;
  private pullTimer?: ReturnType<typeof setInterval>;
  private db?: Database;

  constructor(
    private mode: "local" | "k8s",
    private localRef?: LocalCollectorRef,
    private podLister?: PodLister,
    private snapshotFetcher?: SnapshotFetcher,
  ) {
    // Both modes: track Gateway-side WS connections
    onDiagnostic((event) => {
      if (event.type === "ws_connected") this.wsConnections++;
      if (event.type === "ws_disconnected") this.wsConnections = Math.max(0, this.wsConnections - 1);

      // Local mode: consume session stats on release (fire-and-forget)
      if (mode === "local" && event.type === "session_released" && this.localRef && this.db) {
        const records = this.localRef.drainSessionStats();
        void Promise.all(records.map((r) => this.writeSessionStats(r)));
      }
    });

    if (mode === "k8s") {
      this.startPullLoop();
    }
  }

  /** Set the database reference (called after DB is initialized) */
  setDb(db: Database): void {
    this.db = db;
  }

  // ── Public query API (unified for both modes) ──

  query(range: "1h" | "6h" | "24h"): MetricsBucket[] {
    if (this.mode === "local" && this.localRef) {
      const buckets = this.localRef.query(range);
      // Patch WS connections from Gateway side
      for (const b of buckets) {
        b.wsConnections = this.wsConnections;
      }
      return buckets;
    }

    // K8s mode: read from aggregated ring buffer
    const rangeMs = range === "1h" ? 3_600_000 : range === "6h" ? 21_600_000 : 86_400_000;
    const cutoff = Math.floor(Date.now() / 60_000) * 60_000 - rangeMs;
    const result: MetricsBucket[] = [];
    for (const [ts, bucket] of this.ringBuffer) {
      if (ts >= cutoff) {
        result.push({ ...bucket, wsConnections: this.wsConnections });
      }
    }
    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  snapshot(): { activeSessions: number; wsConnections: number } {
    if (this.mode === "local" && this.localRef) {
      const snap = this.localRef.snapshot();
      return { activeSessions: snap.activeSessions, wsConnections: this.wsConnections };
    }

    // K8s mode: sum activeSessions from the latest buckets
    let activeSessions = 0;
    let latestTs = 0;
    for (const [ts, bucket] of this.ringBuffer) {
      if (ts > latestTs) {
        latestTs = ts;
        activeSessions = bucket.activeSessions;
      }
    }
    return { activeSessions, wsConnections: this.wsConnections };
  }

  topTools(n: number): ToolCallStats[] {
    if (this.mode === "local" && this.localRef) {
      return this.localRef.topTools(n);
    }

    const result: ToolCallStats[] = [];
    for (const [toolName, entry] of this.toolCallMap) {
      result.push({
        toolName,
        success: entry.success,
        error: entry.error,
        total: entry.success + entry.error,
      });
    }
    result.sort((a, b) => b.total - a.total);
    return result.slice(0, n);
  }

  topSkills(n: number): SkillCallStats[] {
    if (this.mode === "local" && this.localRef) {
      return this.localRef.topSkills(n);
    }

    return [...this.skillCallMap.entries()]
      .map(([skillName, v]) => {
        const total = v.success + v.error;
        return {
          skillName,
          scope: v.scope,
          success: v.success,
          error: v.error,
          total,
          avgDurationMs: total > 0 ? Math.round(v.totalDurationMs / total) : 0,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, n);
  }

  // ── K8s pull loop ──

  private startPullLoop(): void {
    this.pullTimer = setInterval(() => {
      this.pullAll().catch((err) => {
        console.warn("[metrics-aggregator] pull loop error:", err);
      });
    }, 30_000);
  }

  private async pullAll(): Promise<void> {
    if (!this.podLister || !this.snapshotFetcher) return;

    const pods = await this.podLister.list();
    const activePods = pods.filter((p) => p.status === "running" && p.endpoint);

    const results = await Promise.allSettled(
      activePods.map((pod) => this.snapshotFetcher!.fetch(pod.endpoint)),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        await this.mergeSnapshot(result.value);
      }
    }
  }

  private async mergeSnapshot(snapshot: MetricsSnapshot): Promise<void> {
    // Merge buckets
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

    // Evict old buckets
    if (this.ringBuffer.size > MAX_BUCKETS) {
      const sorted = [...this.ringBuffer.keys()].sort((a, b) => a - b);
      const excess = sorted.length - MAX_BUCKETS;
      for (let i = 0; i < excess; i++) {
        this.ringBuffer.delete(sorted[i]);
      }
    }

    // Merge tool call deltas
    for (const delta of snapshot.toolCallDeltas) {
      const existing = this.toolCallMap.get(delta.toolName);
      if (existing) {
        existing.success += delta.success;
        existing.error += delta.error;
      } else {
        this.toolCallMap.set(delta.toolName, { success: delta.success, error: delta.error });
      }
    }

    // Merge skill call deltas
    for (const delta of snapshot.skillCallDeltas) {
      const totalDelta = delta.success + delta.error;
      const existing = this.skillCallMap.get(delta.skillName);
      if (existing) {
        existing.success += delta.success;
        existing.error += delta.error;
        existing.totalDurationMs += delta.avgDurationMs * totalDelta;
      } else {
        this.skillCallMap.set(delta.skillName, {
          scope: delta.scope,
          success: delta.success,
          error: delta.error,
          totalDurationMs: delta.avgDurationMs * totalDelta,
        });
      }
    }

    // Write session stats to DB
    for (const record of snapshot.sessionStats) {
      await this.writeSessionStats(record);
    }
  }

  // ── DB write ──

  private async writeSessionStats(record: SessionStatsRecord): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.insert(sessionStats).values({
        id: crypto.randomUUID(),
        sessionId: record.sessionId,
        userId: record.userId,
        provider: record.provider,
        model: record.model,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheReadTokens: record.cacheReadTokens,
        cacheWriteTokens: record.cacheWriteTokens,
        durationMs: record.durationMs,
        promptCount: record.promptCount,
        toolCallCount: record.toolCallCount,
        skillCallCount: record.skillCallCount,
        createdAt: record.createdAt,
      });
    } catch (err) {
      console.warn("[metrics-aggregator] Failed to write session_stats:", err);
    }
  }

  /** Cleanup on shutdown */
  destroy(): void {
    if (this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = undefined;
    }
  }
}
