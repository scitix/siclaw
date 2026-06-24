import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MetricsAggregator,
  type PodLister,
  type SnapshotFetcher,
} from "./metrics-aggregator.js";
import type { MetricsFlushPayload } from "../shared/metrics-types.js";
import { PromFederationAggregator } from "./prom-federation-aggregator.js";

function fedSnap(incarnation: string, prom: MetricsFlushPayload["prom"]): MetricsFlushPayload {
  return { incarnation, prom };
}

describe("MetricsAggregator (K8s federation pull loop)", () => {
  let aggr: MetricsAggregator;
  let lister: PodLister;
  let fetcher: SnapshotFetcher;
  let pods: Array<{ boxId: string; endpoint: string; status: string }>;
  let fetchMap: Map<string, MetricsFlushPayload | null>;

  beforeEach(() => {
    vi.useFakeTimers();
    pods = [];
    fetchMap = new Map();
    lister = { list: async () => pods };
    fetcher = {
      fetch: async (endpoint: string) => fetchMap.has(endpoint) ? fetchMap.get(endpoint)! : null,
    };
    aggr = new MetricsAggregator(lister, fetcher);
  });

  afterEach(() => {
    aggr.destroy();
    vi.useRealTimers();
  });

  it("only fetches pods that are running and have an endpoint", async () => {
    const fetchSpy = vi.fn(async () => null);
    aggr.destroy();
    fetcher = { fetch: fetchSpy };
    aggr = new MetricsAggregator(lister, fetcher);
    pods.push({ boxId: "p1", endpoint: "https://p1", status: "pending" });   // not running
    pods.push({ boxId: "p2", endpoint: "", status: "running" });             // no endpoint
    pods.push({ boxId: "p3", endpoint: "https://p3", status: "running" });   // valid
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("https://p3");
  });

  it("destroy clears the pull timer", async () => {
    const fetchSpy = vi.fn(async () => null);
    aggr.destroy();
    fetcher = { fetch: fetchSpy };
    aggr = new MetricsAggregator(lister, fetcher);
    pods.push({ boxId: "p1", endpoint: "https://p1", status: "running" });
    aggr.destroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pull loop feeds prom snapshots into the federation aggregator keyed by (boxId, incarnation)", async () => {
    const fed = new PromFederationAggregator();
    aggr.destroy();
    aggr = new MetricsAggregator(lister, fetcher, fed);

    pods.push({ boxId: "box-p1", endpoint: "https://p1", status: "running" });
    pods.push({ boxId: "box-p2", endpoint: "https://p2", status: "running" });
    fetchMap.set("https://p1", fedSnap("inc-1", [{ name: "siclaw_tokens_total", type: "counter", values: [{ labels: { type: "input" }, value: 40 }] }]));
    fetchMap.set("https://p2", fedSnap("inc-1", [{ name: "siclaw_tokens_total", type: "counter", values: [{ labels: { type: "input" }, value: 60 }] }]));

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();

    // Two pods, same business labels → one federated series summed to 100.
    const text = fed.metrics();
    expect(text).toContain('siclaw_tokens_total{type="input"} 100');
    expect(fed.trackedInstanceCount()).toBe(2);
  });

  it("when a pod leaves the running set, its gauge contribution is grace-evicted while its counter stays settled", async () => {
    const fed = new PromFederationAggregator();
    aggr.destroy();
    aggr = new MetricsAggregator(lister, fetcher, fed);

    pods.push({ boxId: "box-p1", endpoint: "https://p1", status: "running" });
    fetchMap.set("https://p1", fedSnap("inc-1", [
      { name: "siclaw_tokens_total", type: "counter", values: [{ labels: { type: "input" }, value: 10 }] },
      { name: "siclaw_sessions_active", type: "gauge", values: [{ labels: {}, value: 3 }] },
    ]));

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve(); await Promise.resolve();
    expect(fed.metrics()).toContain("siclaw_sessions_active 3");

    // Pod disappears from the list → two reconciliation rounds → gauge evicted.
    pods.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve(); await Promise.resolve();

    const out = fed.metrics();
    // Gauge contribution dropped from the cross-pod sum...
    expect(out).not.toContain("siclaw_sessions_active 3");
    // ...but the monotonic counter stays settled (never goes down).
    expect(out).toContain('siclaw_tokens_total{type="input"} 10');
  });
});
