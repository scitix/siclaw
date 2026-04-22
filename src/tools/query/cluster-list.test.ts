import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClusterListTool } from "./cluster-list.js";
import { CredentialBroker } from "../../agentbox/credential-broker.js";
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
});
