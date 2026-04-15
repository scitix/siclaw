import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createClusterHandler,
  createHostHandler,
} from "./sync-handlers.js";
import { CredentialBroker } from "./credential-broker.js";
import type {
  CredentialTransport,
  ClusterMeta,
  HostMeta,
  CredentialPayload,
} from "./credential-transport.js";

class FakeTransport implements CredentialTransport {
  clusters: ClusterMeta[] = [];
  hosts: HostMeta[] = [];
  listClustersCalls = 0;
  listHostsCalls = 0;

  listClusters(): Promise<ClusterMeta[]> {
    this.listClustersCalls += 1;
    return Promise.resolve(this.clusters);
  }
  listHosts(): Promise<HostMeta[]> {
    this.listHostsCalls += 1;
    return Promise.resolve(this.hosts);
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-handlers-test-"));
  transport = new FakeTransport();
  broker = new CredentialBroker(transport, dir);
});

afterEach(() => {
  broker.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createClusterHandler", () => {
  it("fetch drives broker.refreshClusters and returns count", async () => {
    transport.clusters = [
      { name: "c1", is_production: true },
      { name: "c2", is_production: false },
    ];
    const handler = createClusterHandler(broker);
    const count = await handler.fetch(null);
    expect(count).toBe(2);
    expect(transport.listClustersCalls).toBe(1);
    expect(broker.isClustersReady()).toBe(true);
    expect(broker.getClustersLocal().map((m) => m.name).sort()).toEqual(["c1", "c2"]);
  });

  it("materialize is a passthrough that returns the count verbatim", async () => {
    const handler = createClusterHandler(broker);
    await expect(handler.materialize(42)).resolves.toBe(42);
  });

  it("handler type is 'cluster'", () => {
    expect(createClusterHandler(broker).type).toBe("cluster");
  });
});

describe("createHostHandler", () => {
  it("fetch drives broker.refreshHosts and returns count", async () => {
    transport.hosts = [
      { name: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true },
    ];
    const handler = createHostHandler(broker);
    const count = await handler.fetch(null);
    expect(count).toBe(1);
    expect(transport.listHostsCalls).toBe(1);
    expect(broker.isHostsReady()).toBe(true);
  });

  it("handler type is 'host'", () => {
    expect(createHostHandler(broker).type).toBe("host");
  });
});

describe("per-broker isolation", () => {
  it("two brokers yield two independent handlers — Map isolation stays", async () => {
    // Simulate two AgentBoxes co-resident in a Local-mode process.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "sync-handlers-test-"));
    const transport2 = new FakeTransport();
    transport2.clusters = [{ name: "cB", is_production: false }];
    const broker2 = new CredentialBroker(transport2, dir2);
    try {
      transport.clusters = [{ name: "cA", is_production: true }];

      const handlerA = createClusterHandler(broker);
      const handlerB = createClusterHandler(broker2);
      await handlerA.fetch(null);
      await handlerB.fetch(null);

      // Refreshing A's handler must not touch B's Map.
      expect(broker.getClustersLocal().map((m) => m.name)).toEqual(["cA"]);
      expect(broker2.getClustersLocal().map((m) => m.name)).toEqual(["cB"]);
    } finally {
      broker2.dispose();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});
