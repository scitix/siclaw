/**
 * MetricsAggregator — Gateway-side metrics aggregation.
 *
 * Two modes:
 * - **Local**: Proxies LocalCollector (same process).
 * - **K8s**: Runs a 30s pull loop fetching metrics snapshots from AgentBox pods
 *   via mTLS HTTP. Per-pod deltas are merged into gateway-side cumulative maps.
 *
 * Stateless counter + top-N only — no time-series buckets or session_stats here.
 */

import { onDiagnostic } from "../shared/diagnostic-events.js";
import {
  type ToolCallStats,
  type SkillCallStats,
  type MetricsSnapshot,
} from "../shared/metrics-types.js";

/** Interface for LocalCollector dependency injection (Local mode only) */
export interface LocalCollectorRef {
  snapshot(): { activeSessions: number; wsConnections: number };
  topTools(n: number, userId?: string): ToolCallStats[];
  topSkills(n: number, userId?: string): SkillCallStats[];
}

/** Interface for pod listing (K8s mode only) */
export interface PodLister {
  list(): Promise<Array<{ boxId: string; endpoint: string; status: string }>>;
}

/** Interface for making mTLS requests to AgentBox pods */
export interface SnapshotFetcher {
  fetch(endpoint: string): Promise<MetricsSnapshot | null>;
}

function tnKey(userId: string, agentId: string | null, name: string): string {
  return `${userId}|${agentId ?? ""}|${name}`;
}

export class MetricsAggregator {
  private toolCallMap = new Map<string, { userId: string; agentId: string | null; toolName: string; success: number; error: number }>();
  private skillCallMap = new Map<string, {
    userId: string;
    agentId: string | null;
    skillName: string;
    scope: "builtin" | "global";
    success: number;
    error: number;
    totalDurationMs: number;
  }>();
  private wsConnections = 0;
  /** K8s mode: sum of activeSessions across all pods at last pull */
  private clusterActiveSessions = 0;
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

  snapshot(): { activeSessions: number; wsConnections: number } {
    if (this.mode === "local" && this.localRef) {
      return { activeSessions: this.localRef.snapshot().activeSessions, wsConnections: this.wsConnections };
    }
    return { activeSessions: this.clusterActiveSessions, wsConnections: this.wsConnections };
  }

  topTools(n: number, userId?: string): ToolCallStats[] {
    if (this.mode === "local" && this.localRef) return this.localRef.topTools(n, userId);
    const result: ToolCallStats[] = [];
    for (const entry of this.toolCallMap.values()) {
      if (userId && entry.userId !== userId) continue;
      result.push({ toolName: entry.toolName, userId: entry.userId, agentId: entry.agentId, success: entry.success, error: entry.error, total: entry.success + entry.error });
    }
    return result.sort((a, b) => b.total - a.total).slice(0, n);
  }

  topSkills(n: number, userId?: string): SkillCallStats[] {
    if (this.mode === "local" && this.localRef) return this.localRef.topSkills(n, userId);
    return [...this.skillCallMap.values()]
      .filter(v => !userId || v.userId === userId)
      .map(v => {
        const total = v.success + v.error;
        return { skillName: v.skillName, scope: v.scope, userId: v.userId, agentId: v.agentId, success: v.success, error: v.error, total, avgDurationMs: total > 0 ? Math.round(v.totalDurationMs / total) : 0 };
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
    const activePods = pods.filter((p) => p.status === "running" && p.endpoint);
    const results = await Promise.allSettled(
      activePods.map((p) => this.snapshotFetcher!.fetch(p.endpoint)),
    );

    // Reset per-pull cluster counter, then accumulate from fulfilled snapshots
    let active = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        this.mergeSnapshot(result.value);
        active += result.value.activeSessions;
      }
    }
    this.clusterActiveSessions = active;
  }

  private mergeSnapshot(snapshot: MetricsSnapshot): void {
    for (const delta of snapshot.toolCallDeltas) {
      const key = tnKey(delta.userId, delta.agentId, delta.toolName);
      const existing = this.toolCallMap.get(key);
      if (existing) { existing.success += delta.success; existing.error += delta.error; }
      else this.toolCallMap.set(key, { userId: delta.userId, agentId: delta.agentId, toolName: delta.toolName, success: delta.success, error: delta.error });
    }

    for (const delta of snapshot.skillCallDeltas) {
      const totalDelta = delta.success + delta.error;
      const key = tnKey(delta.userId, delta.agentId, delta.skillName);
      const existing = this.skillCallMap.get(key);
      if (existing) {
        existing.success += delta.success;
        existing.error += delta.error;
        existing.totalDurationMs += delta.avgDurationMs * totalDelta;
      } else {
        this.skillCallMap.set(key, { userId: delta.userId, agentId: delta.agentId, skillName: delta.skillName, scope: delta.scope, success: delta.success, error: delta.error, totalDurationMs: delta.avgDurationMs * totalDelta });
      }
    }
  }

  destroy(): void {
    if (this.pullTimer) { clearInterval(this.pullTimer); this.pullTimer = undefined; }
  }
}
