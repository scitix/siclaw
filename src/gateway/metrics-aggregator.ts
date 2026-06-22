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
  type PromSampleGroup,
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

/**
 * What the pull loop needs from the Prometheus federation aggregator (module 2).
 * Declared as a structural interface — not an import of PromFederationAggregator —
 * so this file stays self-contained for the agentbox tsconfig/Docker build (which
 * compiles metrics-aggregator.ts but does NOT ship the gateway-only federation code).
 */
export interface FederationSink {
  ingest(boxId: string, incarnation: string, groups: PromSampleGroup[]): void;
  retainInstances(liveBoxIds: Set<string>): void;
  trackedInstanceCount(): number;
  seriesCount(): number;
}

/**
 * Federation self-monitoring hooks used by the pull loop (module 4). The concrete
 * implementation is the prom-client metrics in federation-self-metrics.ts; injected
 * (not imported) so the aggregator stays free of global counter state in tests.
 */
export interface FederationSelfMetrics {
  pullFailuresTotal: { inc(labels: { box_id: string }): void };
  pullDurationMs: { observe(ms: number): void };
  lastSuccessTimestampSeconds: { set(seconds: number): void };
  trackedInstances: { set(n: number): void };
  seriesCount: { set(n: number): void };
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
    /**
     * K8s-only: the Prometheus federation aggregator. The pull loop feeds it each
     * pod's `prom` snapshot (path ②) in addition to the WebUI deltas (path ①).
     */
    private promFederation?: FederationSink,
    /** K8s-only: federation self-monitoring metrics (module 4). */
    private selfMetrics?: FederationSelfMetrics,
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
    const startedAt = Date.now();
    const pods = await this.podLister.list();
    const activePods = pods.filter((p) => p.status === "running" && p.endpoint);
    // Keep the boxId paired with each fetch (even on failure) so federation can key on
    // (boxId, incarnation) and self-monitoring can attribute failures to a box.
    const results = await Promise.all(
      activePods.map(async (p) => {
        try {
          return { boxId: p.boxId, snapshot: await this.snapshotFetcher!.fetch(p.endpoint) };
        } catch {
          return { boxId: p.boxId, snapshot: null as MetricsSnapshot | null };
        }
      }),
    );

    // Reset per-pull cluster counter, then accumulate from fulfilled snapshots
    let active = 0;
    let fetched = 0;
    for (const { boxId, snapshot } of results) {
      if (!snapshot) {
        this.selfMetrics?.pullFailuresTotal.inc({ box_id: boxId });
        continue;
      }
      fetched++;
      this.mergeSnapshot(snapshot); // path ① (WebUI dashboard)
      active += snapshot.activeSessions;
      // path ② (Prometheus federation): only when this build of the snapshot carries
      // the federation fields (incarnation + prom).
      if (this.promFederation && snapshot.incarnation && snapshot.prom) {
        this.promFederation.ingest(boxId, snapshot.incarnation, snapshot.prom);
      }
    }
    this.clusterActiveSessions = active;

    // Reconcile federation tracking against the running pod set (grace eviction).
    // Liveness is the K8s pod list, independent of per-pod fetch success.
    if (this.promFederation) {
      const liveBoxIds = new Set(pods.filter((p) => p.status === "running").map((p) => p.boxId));
      this.promFederation.retainInstances(liveBoxIds);

      // Self-monitoring (module 4): without this the federator's failures are
      // indistinguishable from "no activity" once 9090 is gone.
      if (this.selfMetrics) {
        this.selfMetrics.pullDurationMs.observe(Date.now() - startedAt);
        if (fetched > 0) this.selfMetrics.lastSuccessTimestampSeconds.set(Math.floor(Date.now() / 1000));
        this.selfMetrics.trackedInstances.set(this.promFederation.trackedInstanceCount());
        this.selfMetrics.seriesCount.set(this.promFederation.seriesCount());
      }
    }
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
