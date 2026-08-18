import { describe, it, expect } from "vitest";
import {
  ensureClusterForTool,
  ensureHostForTool,
  classifyClusterFailure,
} from "./ensure-kubeconfigs.js";

describe("ensureClusterForTool", () => {
  it("no-op when broker undefined", async () => {
    await expect(ensureClusterForTool(undefined, "x", "p")).resolves.toBeUndefined();
  });

  it("calls ensureCluster for specific name", async () => {
    const calls: string[] = [];
    const broker = {
      ensureCluster: async (n: string) => { calls.push(n); },
      refreshClusters: async () => [],
    } as any;
    await ensureClusterForTool(broker, "prod", "p");
    expect(calls).toEqual(["prod"]);
  });

  it("auto-selects single cluster when no name given", async () => {
    const calls: string[] = [];
    const broker = {
      ensureCluster: async (n: string) => { calls.push(n); },
      refreshClusters: async () => [{ name: "only-one" }],
    } as any;
    await ensureClusterForTool(broker, undefined, "p");
    expect(calls).toEqual(["only-one"]);
  });

  it("does NOT ensure any cluster when multiple bound and no name given", async () => {
    const calls: string[] = [];
    const broker = {
      ensureCluster: async (n: string) => { calls.push(n); },
      refreshClusters: async () => [{ name: "a" }, { name: "b" }],
    } as any;
    await ensureClusterForTool(broker, undefined, "p");
    expect(calls).toEqual([]);
  });
});

describe("ensureHostForTool", () => {
  it("throws when broker missing", async () => {
    await expect(ensureHostForTool(undefined, "h1", "p")).rejects.toThrow("Credential broker required");
  });

  it("calls broker.ensureHost", async () => {
    const calls: string[] = [];
    const broker = { ensureHost: async (n: string) => { calls.push(n); } } as any;
    await ensureHostForTool(broker, "h1", "p");
    expect(calls).toEqual(["h1"]);
  });

  it("propagates ensureHost errors", async () => {
    const broker = { ensureHost: async () => { throw new Error("not bound"); } } as any;
    await expect(ensureHostForTool(broker, "h1", "p")).rejects.toThrow("not bound");
  });
});

describe("classifyClusterFailure", () => {
  // The transport reports a missing binding as an HTTP 502 "cluster not found",
  // which is indistinguishable from a real upstream fault — the binding list is
  // what tells them apart.
  const gatewayError = new Error('Gateway returned 502: {"error":"cluster not found"}');

  it("reports an unbound cluster as a non-retryable config error", async () => {
    const broker = {
      refreshClusters: async () => [{ name: "prod" }, { name: "staging" }],
    } as any;
    const result = await classifyClusterFailure(broker, "typo-cluster", gatewayError);
    expect(result.reason).toBe("cluster_not_bound");
    expect(result.retryable).toBe(false);
    expect(result.available_clusters).toEqual(["prod", "staging"]);
    expect(result.message).toContain("cluster_list");
    // The 502 must not survive — it is what misleads the caller into retrying.
    expect(result.message).not.toContain("502");
  });

  it("says so explicitly when nothing at all is bound", async () => {
    const broker = { refreshClusters: async () => [] } as any;
    const result = await classifyClusterFailure(broker, "prod", gatewayError);
    expect(result.reason).toBe("cluster_not_bound");
    expect(result.available_clusters).toEqual([]);
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("No cluster is bound");
  });

  // ensureClusterForTool auto-selects when the caller omits `cluster`, so this
  // path arrives with no name — but an empty list is just as conclusive.
  it("reports not-bound for an empty list even with no name given", async () => {
    const broker = { refreshClusters: async () => [] } as any;
    const result = await classifyClusterFailure(broker, undefined, gatewayError);
    expect(result.reason).toBe("cluster_not_bound");
    expect(result.retryable).toBe(false);
    expect(result.message).not.toContain("502");
  });

  it("keeps the upstream error when the cluster IS bound", async () => {
    const broker = { refreshClusters: async () => [{ name: "prod" }] } as any;
    const result = await classifyClusterFailure(broker, "prod", new Error("TLS handshake timeout"));
    expect(result.reason).toBe("cluster_unavailable");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("TLS handshake timeout");
    expect(result.available_clusters).toEqual(["prod"]);
  });

  it("does not claim 'not bound' when the binding list itself is unreachable", async () => {
    const broker = {
      refreshClusters: async () => { throw new Error("list failed"); },
    } as any;
    const result = await classifyClusterFailure(broker, "prod", gatewayError);
    expect(result.reason).toBe("cluster_unavailable");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("502");
  });

  it("falls back to cluster_unavailable with no broker", async () => {
    const result = await classifyClusterFailure(undefined, "prod", gatewayError);
    expect(result.reason).toBe("cluster_unavailable");
    expect(result.available_clusters).toEqual([]);
  });

  it("does not label an auto-select failure as unbound (no name given)", async () => {
    const broker = { refreshClusters: async () => [{ name: "prod" }] } as any;
    const result = await classifyClusterFailure(broker, undefined, gatewayError);
    expect(result.reason).toBe("cluster_unavailable");
  });
});
