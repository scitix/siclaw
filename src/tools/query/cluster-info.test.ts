import { describe, it, expect, beforeEach } from "vitest";
import { createClusterInfoTool } from "./cluster-info.js";
import type { KubeconfigRef } from "../../core/types.js";

function makeFakeBroker() {
  return {
    clustersReady: false,
    refreshCount: 0,
    clusters: [] as any[],
    isClustersReady() { return this.clustersReady; },
    async refreshClusters() {
      this.refreshCount++;
      this.clustersReady = true;
      return this.clusters.map(c => c.meta);
    },
    listClustersLocalInfo() { return this.clusters; },
  };
}

describe("cluster_info tool", () => {
  let broker: ReturnType<typeof makeFakeBroker>;

  beforeEach(() => {
    broker = makeFakeBroker();
  });

  it("has correct tool metadata", () => {
    const tool = createClusterInfoTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    expect(tool.name).toBe("cluster_info");
    expect(tool.label).toBe("Cluster Info");
  });

  it("returns error when broker missing", async () => {
    const ref: KubeconfigRef = { credentialsDir: "/tmp" };
    const tool = createClusterInfoTool(ref);
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.error).toContain("Credential broker not initialized");
  });

  it("refreshes on first call then caches", async () => {
    broker.clusters = [
      { meta: { name: "prod-gpu", description: "RDMA via SR-IOV" } },
      { meta: { name: "dev-cluster", description: "calico" } },
    ];
    const tool = createClusterInfoTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    await tool.execute("id-1", {});
    await tool.execute("id-2", {});
    expect(broker.refreshCount).toBe(1);
  });

  it("returns cluster name + infra_context for all clusters", async () => {
    broker.clusters = [
      { meta: { name: "prod-gpu", description: "RDMA SR-IOV" } },
      { meta: { name: "dev", description: null } },
    ];
    const tool = createClusterInfoTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.clusters).toHaveLength(2);
    expect(parsed.clusters[0].infra_context).toBe("RDMA SR-IOV");
    expect(parsed.clusters[1].infra_context).toBeNull();
  });

  it("filters by substring on name", async () => {
    broker.clusters = [
      { meta: { name: "prod-gpu", description: "A" } },
      { meta: { name: "prod-cpu", description: "B" } },
      { meta: { name: "dev-one", description: "C" } },
    ];
    const tool = createClusterInfoTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", { name: "prod" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.clusters.map((c: any) => c.name).sort()).toEqual(["prod-cpu", "prod-gpu"]);
  });

  it("filter is case-insensitive", async () => {
    broker.clusters = [
      { meta: { name: "Prod-GPU", description: "A" } },
    ];
    const tool = createClusterInfoTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", { name: "PROD" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.clusters).toHaveLength(1);
  });

  it("returns error when refreshClusters throws", async () => {
    broker.refreshClusters = async () => { throw new Error("no network"); };
    const tool = createClusterInfoTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.error).toContain("no network");
  });
});
