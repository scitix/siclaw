import { describe, it, expect, beforeEach } from "vitest";
import { createClusterProbeTool } from "./cluster-probe.js";
import type { KubeconfigRef } from "../../core/types.js";

const fakeBroker = {
  probeCalls: [] as string[],
  probeResult: { name: "c1", reachable: true, server_version: "v1.29.0" } as any,
  probeCluster(name: string) {
    this.probeCalls.push(name);
    return Promise.resolve(this.probeResult);
  },
} as any;

beforeEach(() => {
  fakeBroker.probeCalls = [];
  fakeBroker.probeResult = { name: "c1", reachable: true, server_version: "v1.29.0" };
});

describe("cluster_probe", () => {
  it("has correct tool metadata", () => {
    const tool = createClusterProbeTool({ credentialsDir: "/tmp", credentialBroker: fakeBroker });
    expect(tool.name).toBe("cluster_probe");
    expect(tool.label).toBe("Cluster Probe");
  });

  it("returns error when name is missing", async () => {
    const tool = createClusterProbeTool({ credentialsDir: "/tmp", credentialBroker: fakeBroker });
    const result = await tool.execute("id", {} as any);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.error).toBe("name is required");
    expect(fakeBroker.probeCalls).toEqual([]);
  });

  it("returns error when broker is missing", async () => {
    const ref: KubeconfigRef = { credentialsDir: "/tmp" };
    const tool = createClusterProbeTool(ref);
    const result = await tool.execute("id", { name: "c1" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.error).toContain("Credential broker not initialized");
  });

  it("calls broker.probeCluster and returns result as JSON", async () => {
    const tool = createClusterProbeTool({ credentialsDir: "/tmp", credentialBroker: fakeBroker });
    const result = await tool.execute("id", { name: "c1" });
    expect(fakeBroker.probeCalls).toEqual(["c1"]);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.reachable).toBe(true);
    expect(parsed.server_version).toBe("v1.29.0");
  });

  it("returns probe error payload when unreachable", async () => {
    fakeBroker.probeResult = { name: "c1", reachable: false, probe_error: "timeout" };
    const tool = createClusterProbeTool({ credentialsDir: "/tmp", credentialBroker: fakeBroker });
    const result = await tool.execute("id", { name: "c1" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.reachable).toBe(false);
    expect(parsed.probe_error).toBe("timeout");
  });
});
