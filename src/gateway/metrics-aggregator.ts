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
  type SessionStatsRecord,
  type MetricsSnapshot,
  createEmptyBucket,
} from "../shared/metrics-types.js";
import type { Database } from "./db/index.js";
import { sessionStats } from "./db/schema-sqlite.js";

const MAX_BUCKETS = 1440;

/** Interface for LocalCollector dependency injection (Local mode only) */
export interface LocalCollectorRef {
  query(range: "1h" | "6h" | "24h"): MetricsBucket[];
  snapshot(): { activeSessions: number; wsConnections: number };
  topTools(n: number): ToolCallStats[];
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

      // Local mode: consume session stats on release
      if (mode === "local" && event.type === "session_released" && this.localRef && this.db) {
        const records = this.localRef.drainSessionStats();
        for (const record of records) {
          this.writeSessionStats(record);
        }
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
        this.mergeSnapshot(result.value);
      }
    }
  }

  private mergeSnapshot(snapshot: MetricsSnapshot): void {
    // Merge buckets
    for (const bucket of snapshot.buckets) {
      const existing = this.ringBuffer.get(bucket.timestamp);
      if (existing) {
        existing.tokensInput += bucket.tokensInput;
        existing.tokensOutput += bucket.tokensOutput;
        existing.tokensCacheRead += bucket.tokensCacheRead;
        existing.tokensCacheWrite += bucket.tokensCacheWrite;
        existing.costUsd += bucket.costUsd;
        existing.promptCount += bucket.promptCount;
        existing.promptErrors += bucket.promptErrors;
        existing.promptDurationSum += bucket.promptDurationSum;
        existing.promptDurationMax = Math.max(existing.promptDurationMax, bucket.promptDurationMax);
        existing.activeSessions += bucket.activeSessions;
        existing.toolCalls += bucket.toolCalls;
        existing.toolErrors += bucket.toolErrors;
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

    // Write session stats to DB
    for (const record of snapshot.sessionStats) {
      this.writeSessionStats(record);
    }
  }

  // ── DB write ──

  private writeSessionStats(record: SessionStatsRecord): void {
    if (!this.db) return;
    try {
      const sdb = this.db as any;
      sdb.insert(sessionStats).values({
        id: crypto.randomUUID(),
        sessionId: record.sessionId,
        userId: record.userId,
        provider: record.provider,
        model: record.model,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheReadTokens: record.cacheReadTokens,
        cacheWriteTokens: record.cacheWriteTokens,
        costUsd: record.costUsd,
        durationMs: record.durationMs,
        promptCount: record.promptCount,
        toolCallCount: record.toolCallCount,
        createdAt: record.createdAt,
      }).run();
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
