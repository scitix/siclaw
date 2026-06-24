/**
 * MetricsAggregator — Gateway-side Prometheus federation pull loop (K8s mode).
 *
 * Runs a 30s pull loop that fetches each AgentBox pod's cumulative prom-client
 * snapshot via mTLS HTTP and feeds it into the federation aggregator, which backs
 * the gateway's /metrics endpoint. Pod liveness (the K8s pod list) drives
 * grace-eviction of departed instances; self-monitoring counters track pull health.
 *
 * No business-counter state lives here — long-term trends go to external Grafana
 * via the federated prom-client series.
 */

import type {
  MetricsFlushPayload,
  PromSampleGroup,
} from "../shared/metrics-types.js";

/** Interface for pod listing (K8s mode only) */
export interface PodLister {
  list(): Promise<Array<{ boxId: string; endpoint: string; status: string }>>;
}

/** Interface for making mTLS requests to AgentBox pods */
export interface SnapshotFetcher {
  fetch(endpoint: string): Promise<MetricsFlushPayload | null>;
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

export class MetricsAggregator {
  private pullTimer?: ReturnType<typeof setInterval>;

  constructor(
    private podLister?: PodLister,
    private snapshotFetcher?: SnapshotFetcher,
    /**
     * The Prometheus federation aggregator. The pull loop feeds it each pod's
     * cumulative `prom` snapshot; it backs the gateway's /metrics endpoint.
     */
    private promFederation?: FederationSink,
    /** Federation self-monitoring metrics (module 4). */
    private selfMetrics?: FederationSelfMetrics,
  ) {
    this.startPullLoop();
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
          return { boxId: p.boxId, snapshot: null as MetricsFlushPayload | null };
        }
      }),
    );

    let fetched = 0;
    for (const { boxId, snapshot } of results) {
      if (!snapshot) {
        this.selfMetrics?.pullFailuresTotal.inc({ box_id: boxId });
        continue;
      }
      fetched++;
      // Prometheus federation: feed this process's cumulative prom snapshot.
      // incarnation/prom are required on the type but re-checked because the payload
      // crosses the mTLS wire from another pod — validate at the boundary.
      if (this.promFederation && snapshot.incarnation && snapshot.prom) {
        this.promFederation.ingest(boxId, snapshot.incarnation, snapshot.prom);
      }
    }

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

  destroy(): void {
    if (this.pullTimer) { clearInterval(this.pullTimer); this.pullTimer = undefined; }
  }
}
