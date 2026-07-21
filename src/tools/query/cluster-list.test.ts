import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClusterListTool } from "./cluster-list.js";
import { CredentialBroker } from "../../agentbox/credential-broker.js";
import type { ProbeResult } from "../../agentbox/credential-broker.js";
import type {
  CredentialTransport,
  ClusterMeta,
  HostMeta,
  CredentialPayload,
} from "../../agentbox/credential-transport.js";
import type { KubeconfigRef } from "../../core/types.js";

class FakeTransport implements CredentialTransport {
  clusters: ClusterMeta[] = [];
  listClustersCalls = 0;

  listClusters(): Promise<ClusterMeta[]> {
    this.listClustersCalls += 1;
    return Promise.resolve(this.clusters);
  }
  listHosts(): Promise<HostMeta[]> {
    return Promise.resolve([]);
  }
  getClusterCredential(): Promise<CredentialPayload> {
    throw new Error("not used");
  }
  getHostCredential(): Promise<CredentialPayload> {
    throw new Error("not used");
  }
}

let dir: string;
let broker: CredentialBroker;
let transport: FakeTransport;
let ref: KubeconfigRef;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-list-test-"));
  transport = new FakeTransport();
  broker = new CredentialBroker(transport, dir);
  ref = { credentialsDir: dir, credentialBroker: broker };
});

afterEach(() => {
  broker.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("cluster_list tool — lazy fill", () => {
  it("first execute triggers exactly one refresh; second reads Map without hitting transport", async () => {
    transport.clusters = [
      { name: "c1", is_production: true },
      { name: "c2", is_production: false },
    ];
    const tool = createClusterListTool(ref);

    const first = await tool.execute("id-1", {});
    expect(transport.listClustersCalls).toBe(1);
    const firstPayload = JSON.parse((first.content[0] as any).text.split("\n\n")[0]);
    expect(firstPayload.clusters.map((c: any) => c.name).sort()).toEqual(["c1", "c2"]);

    const second = await tool.execute("id-2", {});
    expect(transport.listClustersCalls).toBe(1); // still 1 — no refresh
    const secondPayload = JSON.parse((second.content[0] as any).text.split("\n\n")[0]);
    expect(secondPayload.clusters.map((c: any) => c.name).sort()).toEqual(["c1", "c2"]);
  });

  it("returns error payload when refresh fails on first call", async () => {
    transport.listClusters = () => Promise.reject(new Error("gateway unavailable"));
    const tool = createClusterListTool(ref);
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.error).toContain("gateway unavailable");
    expect(broker.isClustersReady()).toBe(false);
  });

  it("returns error when broker is missing from the ref", async () => {
    const missingRef: KubeconfigRef = { credentialsDir: dir };
    const tool = createClusterListTool(missingRef);
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.error).toContain("Credential broker not initialized");
  });

  it("filters by name substring (case-insensitive)", async () => {
    transport.clusters = [
      { name: "changliu-prod", is_production: true },
      { name: "changliu-dev", is_production: false },
      { name: "other-cluster", is_production: true },
    ];
    const tool = createClusterListTool(ref);
    const result = await tool.execute("id", { name: "ChangLiu" });
    const parsed = JSON.parse((result.content[0] as any).text.split("\n\n")[0]);
    expect(parsed.clusters.map((c: any) => c.name).sort()).toEqual(["changliu-dev", "changliu-prod"]);
  });

  it("hints to drop the filter when a name search matches nothing", async () => {
    transport.clusters = [
      { name: "prod-a", is_production: true },
      { name: "prod-b", is_production: true },
    ];
    const tool = createClusterListTool(ref);
    const result = await tool.execute("id", { name: "nope" });
    const text = (result.content[0] as any).text;
    const parsed = JSON.parse(text.split("\n\n")[0]);
    expect(parsed.clusters).toHaveLength(0);
    expect(text).toContain('No clusters match "nope"');
    expect(text).toContain("2"); // mentions the bound-cluster count
  });

  it("still reports unbound when the agent has zero clusters (not a search miss)", async () => {
    transport.clusters = [];
    const tool = createClusterListTool(ref);
    const result = await tool.execute("id", { name: "anything" });
    const text = (result.content[0] as any).text;
    expect(text).toContain("No clusters are bound");
  });

  it("passes structured meta through, flattened to key→value", async () => {
    transport.clusters = [
      { name: "c1", is_production: true, meta: [
        { key: "rdma_type", display_name: "RDMA Type", value: "SR-IOV" },
        { key: "scheduler", value: "volcano" },
      ] },
      { name: "c2", is_production: false }, // no meta
    ];
    const tool = createClusterListTool(ref);
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text.split("\n\n")[0]);
    const c1 = parsed.clusters.find((c: any) => c.name === "c1");
    const c2 = parsed.clusters.find((c: any) => c.name === "c2");
    expect(c1.meta).toEqual({ rdma_type: "SR-IOV", scheduler: "volcano" });
    expect(c2).not.toHaveProperty("meta");
  });
});

describe("cluster_list tool — opt-in probe flag", () => {
  // The fixtures below are typed as ProbeResult (no `as any`), so any future
  // change to the probe contract fails these mocks at compile time.
  it("without probe: no cluster contact, entries carry no reachability", async () => {
    transport.clusters = [{ name: "c1", is_production: true }];
    let probeCalls = 0;
    broker.probeClusters = async (names: string[]): Promise<ProbeResult[]> => {
      probeCalls += 1;
      return names.map((name) => ({ name, probe_status: "success", reachable: true, server_version: "unknown" }));
    };
    const tool = createClusterListTool(ref);
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text.split("\n\n")[0]);
    expect(probeCalls).toBe(0);
    expect(parsed.clusters[0]).not.toHaveProperty("reachable");
    expect(parsed.clusters[0]).not.toHaveProperty("probe_status");
  });

  it("probe:true (success) folds probe_status + reachable + server_version into each entry", async () => {
    transport.clusters = [
      { name: "c1", is_production: true },
      { name: "c2", is_production: false },
    ];
    const probedNames: string[][] = [];
    broker.probeClusters = async (names: string[]): Promise<ProbeResult[]> => {
      probedNames.push([...names]);
      return names.map((name) => ({ name, probe_status: "success", reachable: true, server_version: "v1.29.0" }));
    };
    const tool = createClusterListTool(ref);
    const result = await tool.execute("id", { probe: true });
    const parsed = JSON.parse((result.content[0] as any).text.split("\n\n")[0]);
    expect(probedNames).toEqual([["c1", "c2"]]);
    for (const c of parsed.clusters) {
      expect(c.probe_status).toBe("success");
      expect(c.reachable).toBe(true);
      expect(c.server_version).toBe("v1.29.0");
      expect(c).not.toHaveProperty("probe_reason");
    }
  });

  it("probe:true only probes the name-filtered subset", async () => {
    transport.clusters = [
      { name: "prod-a", is_production: true },
      { name: "prod-b", is_production: true },
      { name: "dev-c", is_production: false },
    ];
    let probedWith: string[] = [];
    broker.probeClusters = async (names: string[]): Promise<ProbeResult[]> => {
      probedWith = [...names];
      return names.map((name) => ({ name, probe_status: "success", reachable: true, server_version: "unknown" }));
    };
    const tool = createClusterListTool(ref);
    await tool.execute("id", { name: "prod", probe: true });
    expect(probedWith.sort()).toEqual(["prod-a", "prod-b"]);
  });

  it("unreachable probe surfaces reachable:false + probe_reason + probe_error, no server_version", async () => {
    transport.clusters = [{ name: "c1", is_production: true }];
    broker.probeClusters = async (names: string[]): Promise<ProbeResult[]> =>
      names.map((name) => ({ name, probe_status: "unreachable", reachable: false, reason: "timeout", probe_error: "i/o timeout" }));
    const tool = createClusterListTool(ref);
    const result = await tool.execute("id", { probe: true });
    const parsed = JSON.parse((result.content[0] as any).text.split("\n\n")[0]);
    expect(parsed.clusters[0].probe_status).toBe("unreachable");
    expect(parsed.clusters[0].probe_reason).toBe("timeout");
    expect(parsed.clusters[0].reachable).toBe(false);
    expect(parsed.clusters[0].probe_error).toBe("i/o timeout");
    expect(parsed.clusters[0]).not.toHaveProperty("server_version");
  });

  it("probe_failed surfaces probe_reason + error WITHOUT claiming the cluster is unreachable", async () => {
    transport.clusters = [{ name: "c1", is_production: false }];
    broker.probeClusters = async (names: string[]): Promise<ProbeResult[]> =>
      names.map((name) => ({ name, probe_status: "probe_failed", reason: "kubeconfig", probe_error: "no configuration has been provided" }));
    const tool = createClusterListTool(ref);
    const result = await tool.execute("id", { probe: true });
    const parsed = JSON.parse((result.content[0] as any).text.split("\n\n")[0]);
    expect(parsed.clusters[0].probe_status).toBe("probe_failed");
    expect(parsed.clusters[0].probe_reason).toBe("kubeconfig");
    expect(parsed.clusters[0].probe_error).toBe("no configuration has been provided");
    expect(parsed.clusters[0]).not.toHaveProperty("reachable");
    expect(parsed.clusters[0]).not.toHaveProperty("server_version");
  });

  it("probe_failed/auth carries reachable:true (401 proves the API server answered — cluster is up)", async () => {
    transport.clusters = [{ name: "c1", is_production: true }];
    broker.probeClusters = async (names: string[]): Promise<ProbeResult[]> =>
      names.map((name) => ({ name, probe_status: "probe_failed", reason: "auth", reachable: true, probe_error: "Unauthorized" }));
    const tool = createClusterListTool(ref);
    const result = await tool.execute("id", { probe: true });
    const parsed = JSON.parse((result.content[0] as any).text.split("\n\n")[0]);
    expect(parsed.clusters[0].probe_status).toBe("probe_failed");
    expect(parsed.clusters[0].probe_reason).toBe("auth");
    expect(parsed.clusters[0].reachable).toBe(true);
    expect(parsed.clusters[0]).not.toHaveProperty("server_version");
  });
});
