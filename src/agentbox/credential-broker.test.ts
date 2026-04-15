import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialBroker } from "./credential-broker.js";
import type {
  CredentialTransport,
  ClusterMeta,
  HostMeta,
  CredentialPayload,
} from "./credential-transport.js";

/**
 * In-memory transport stub. Tests inject the metas/payloads they want.
 */
class FakeTransport implements CredentialTransport {
  clusters: ClusterMeta[] = [];
  hosts: HostMeta[] = [];
  clusterPayloads = new Map<string, CredentialPayload>();
  hostPayloads = new Map<string, CredentialPayload>();
  listHostsCalls = 0;
  getHostCalls: string[] = [];

  listClusters(): Promise<ClusterMeta[]> { return Promise.resolve(this.clusters); }
  listHosts(): Promise<HostMeta[]> {
    this.listHostsCalls += 1;
    return Promise.resolve(this.hosts);
  }
  getClusterCredential(name: string): Promise<CredentialPayload> {
    const p = this.clusterPayloads.get(name);
    if (!p) throw new Error(`no cluster payload for ${name}`);
    return Promise.resolve(p);
  }
  getHostCredential(name: string): Promise<CredentialPayload> {
    this.getHostCalls.push(name);
    const p = this.hostPayloads.get(name);
    if (!p) throw new Error(`no host payload for ${name}`);
    return Promise.resolve(p);
  }
}

let dir: string;
let broker: CredentialBroker;
let transport: FakeTransport;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-test-"));
  transport = new FakeTransport();
  broker = new CredentialBroker(transport, dir);
});

afterEach(() => {
  broker.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CredentialBroker — host pipeline", () => {
  it("creates clusters/ and hosts/ subdirectories at construction", () => {
    expect(fs.existsSync(path.join(dir, "clusters"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "hosts"))).toBe(true);
  });

  it("listHosts upserts metadata into the registry without materializing files", async () => {
    transport.hosts = [
      { name: "node-a", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true },
      { name: "node-b", ip: "10.0.0.2", port: 2222, username: "ops", auth_type: "password", is_production: false },
    ];
    const result = await broker.refreshHosts();
    expect(result).toHaveLength(2);

    const local = broker.listHostsLocalInfo();
    expect(local.map((e) => e.meta.name).sort()).toEqual(["node-a", "node-b"]);
    // No files materialized just from list
    expect(fs.readdirSync(path.join(dir, "hosts"))).toEqual([]);
  });

  it("listHosts prunes registry entries no longer returned by transport (decision #6 reconcile)", async () => {
    transport.hosts = [
      { name: "node-a", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true },
      { name: "node-b", ip: "10.0.0.2", port: 22, username: "root", auth_type: "key", is_production: true },
    ];
    await broker.refreshHosts();
    expect(broker.listHostsLocalInfo()).toHaveLength(2);

    // Re-list with node-b removed (admin unbound it in the Portal)
    transport.hosts = [
      { name: "node-a", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true },
    ];
    await broker.refreshHosts();
    const remaining = broker.listHostsLocalInfo().map((e) => e.meta.name);
    expect(remaining).toEqual(["node-a"]);
  });

  it("acquireHost (key) writes <name>.key with mode 0640 (sandbox-readable via group)", async () => {
    transport.hostPayloads.set("node-a", {
      credential: {
        name: "node-a",
        type: "ssh",
        files: [{ name: "node-a.key", content: "PRIVATE KEY DATA", mode: 0o640 }],
        metadata: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true },
        ttl_seconds: 300,
      },
    });
    await broker.acquireHost("node-a", "test");

    const filePath = path.join(dir, "hosts", "node-a.node-a.key");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("PRIVATE KEY DATA");
    const stat = fs.statSync(filePath);
    // In K8s the broker chgrp's hostcred and writes 0640; in test envs without
    // the group, it falls back to 0600. Both are tight (no world bits).
    expect(stat.mode & 0o007).toBe(0); // no world access
    expect([0o640, 0o600]).toContain(stat.mode & 0o777);
  });

  it("acquireHost (password) writes <name>.password", async () => {
    transport.hostPayloads.set("node-b", {
      credential: {
        name: "node-b",
        type: "ssh",
        files: [{ name: "node-b.password", content: "s3cret", mode: 0o640 }],
        metadata: { ip: "10.0.0.2", port: 22, username: "ops", auth_type: "password", is_production: false },
        ttl_seconds: 300,
      },
    });
    await broker.acquireHost("node-b", "test");

    const filePath = path.join(dir, "hosts", "node-b.node-b.password");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("s3cret");
  });

  it("acquireHost does NOT cache-reconstruct: every call hits transport", async () => {
    transport.hostPayloads.set("node-a", {
      credential: {
        name: "node-a",
        type: "ssh",
        files: [{ name: "node-a.key", content: "K1", mode: 0o640 }],
        metadata: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true },
        ttl_seconds: 300,
      },
    });
    await broker.acquireHost("node-a", "first");
    await broker.acquireHost("node-a", "second");
    expect(transport.getHostCalls).toEqual(["node-a", "node-a"]);
  });

  it("cluster and host with the same name materialize to separate subdirs", async () => {
    transport.clusterPayloads.set("prod", {
      credential: {
        name: "prod",
        type: "kubeconfig",
        files: [{ name: "prod.kubeconfig", content: "apiVersion: v1\nkind: Config\nclusters: []", mode: 0o640 }],
        ttl_seconds: 300,
      },
    });
    transport.hostPayloads.set("prod", {
      credential: {
        name: "prod",
        type: "ssh",
        files: [{ name: "prod.key", content: "HOST KEY", mode: 0o640 }],
        metadata: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true },
        ttl_seconds: 300,
      },
    });

    await broker.acquireCluster("prod", "test");
    await broker.acquireHost("prod", "test");

    expect(fs.existsSync(path.join(dir, "clusters", "prod.prod.kubeconfig"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "hosts", "prod.prod.key"))).toBe(true);
  });

  it("reconcileFullList prune unlinks materialized host files for dropped entries", async () => {
    transport.hostPayloads.set("node-a", {
      credential: {
        name: "node-a",
        type: "ssh",
        files: [{ name: "node-a.key", content: "K", mode: 0o640 }],
        metadata: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true },
        ttl_seconds: 300,
      },
    });
    transport.hosts = [
      { name: "node-a", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true },
    ];
    await broker.refreshHosts();
    await broker.acquireHost("node-a", "test");
    const filePath = path.join(dir, "hosts", "node-a.node-a.key");
    expect(fs.existsSync(filePath)).toBe(true);

    // Admin unbinds node-a → next listHosts returns empty → prune unlinks
    transport.hosts = [];
    await broker.refreshHosts();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(broker.getHostLocalInfo("node-a")).toBeUndefined();
  });

  it("acquireHost fails fast when metadata is missing required fields (no silent fallback)", async () => {
    transport.hostPayloads.set("node-y", {
      credential: {
        name: "node-y",
        type: "ssh",
        files: [{ name: "node-y.key", content: "K", mode: 0o640 }],
        metadata: { ip: "10.0.0.10", port: 22, username: "root", auth_type: "key" }, // missing is_production
        ttl_seconds: 300,
      },
    });
    await expect(broker.acquireHost("node-y", "test")).rejects.toThrow(/missing required metadata\.is_production/);
  });

  it("ensureHost throws when payload contains no files", async () => {
    transport.hostPayloads.set("node-x", {
      credential: {
        name: "node-x",
        type: "ssh",
        files: [],
        metadata: { ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", is_production: false },
        ttl_seconds: 300,
      },
    });
    await expect(broker.ensureHost("node-x", "test")).rejects.toThrow(/no files materialized/);
  });
});

describe("CredentialBroker — sync read + refresh API", () => {
  it("isClustersReady returns false until refreshClusters succeeds", async () => {
    expect(broker.isClustersReady()).toBe(false);
    expect(broker.getClustersLocal()).toEqual([]);

    transport.clusters = [{ name: "c1", is_production: true }];
    await broker.refreshClusters();

    expect(broker.isClustersReady()).toBe(true);
    expect(broker.getClustersLocal().map((m) => m.name)).toEqual(["c1"]);
  });

  it("isHostsReady mirrors isClustersReady for hosts", async () => {
    expect(broker.isHostsReady()).toBe(false);
    transport.hosts = [
      { name: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: false },
    ];
    await broker.refreshHosts();
    expect(broker.isHostsReady()).toBe(true);
    expect(broker.getHostsLocal().map((m) => m.name)).toEqual(["h1"]);
  });

  it("readiness flag stays false when refresh fails", async () => {
    // transport.listHosts throws because we override the impl
    const originalListHosts = transport.listHosts.bind(transport);
    transport.listHosts = () => Promise.reject(new Error("gateway down"));
    await expect(broker.refreshHosts()).rejects.toThrow("gateway down");
    expect(broker.isHostsReady()).toBe(false);
    // Restore so the afterEach dispose works cleanly
    transport.listHosts = originalListHosts;
  });

  it("inflight dedup: concurrent refreshHosts share one transport call", async () => {
    transport.hosts = [
      { name: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: false },
    ];
    const baseline = transport.listHostsCalls;
    const [a, b, c] = await Promise.all([
      broker.refreshHosts(),
      broker.refreshHosts(),
      broker.refreshHosts(),
    ]);
    // Only one transport.listHosts() call should have fired for the whole batch.
    expect(transport.listHostsCalls - baseline).toBe(1);
    expect(a.map((m) => m.name)).toEqual(["h1"]);
    expect(b.map((m) => m.name)).toEqual(["h1"]);
    expect(c.map((m) => m.name)).toEqual(["h1"]);
  });

  it("refreshAll refreshes clusters and hosts in parallel and reports counts", async () => {
    transport.clusters = [
      { name: "c1", is_production: true },
      { name: "c2", is_production: false },
    ];
    transport.hosts = [
      { name: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: false },
    ];
    const result = await broker.refreshAll();
    expect(result).toEqual({ clusters: 2, hosts: 1 });
    expect(broker.isClustersReady()).toBe(true);
    expect(broker.isHostsReady()).toBe(true);
  });

  it("sequential refreshHosts calls each hit the transport (no false sharing across awaits)", async () => {
    transport.hosts = [
      { name: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: false },
    ];
    const baseline = transport.listHostsCalls;
    await broker.refreshHosts();
    await broker.refreshHosts();
    expect(transport.listHostsCalls - baseline).toBe(2);
  });
});
