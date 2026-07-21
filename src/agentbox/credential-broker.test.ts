import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialBroker, classifyKubectlProbeError, withProbeTimeout } from "./credential-broker.js";
import type { ProbeResult, ClusterLocalInfo } from "./credential-broker.js";
import type {
  CredentialTransport,
  ClusterMeta,
  HostMeta,
  CredentialPayload,
  HostListResult,
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
  queryResult: HostListResult = { hosts: [], total: 0, next_cursor: null };
  queryHostsCalls: Array<{ query: string; opts?: { limit?: number; cursor?: string } }> = [];
  queryHosts(query: string, opts?: { limit?: number; cursor?: string }): Promise<HostListResult> {
    this.queryHostsCalls.push({ query, opts });
    return Promise.resolve(this.queryResult);
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

  it("acquireHost copies metadata.jump_host into HostMeta (and omits when absent)", async () => {
    transport.hostPayloads.set("with-jump", {
      credential: {
        name: "with-jump",
        type: "ssh",
        files: [{ name: "with-jump.key", content: "K", mode: 0o600 }],
        metadata: { ip: "10.0.0.5", port: 22, username: "root", auth_type: "key", is_production: true, jump_host: "bastion" },
        ttl_seconds: 300,
      },
    });
    transport.hostPayloads.set("no-jump", {
      credential: {
        name: "no-jump",
        type: "ssh",
        files: [{ name: "no-jump.key", content: "K", mode: 0o600 }],
        metadata: { ip: "10.0.0.6", port: 22, username: "root", auth_type: "key", is_production: true },
        ttl_seconds: 300,
      },
    });
    await broker.acquireHost("with-jump", "test");
    await broker.acquireHost("no-jump", "test");
    expect(broker.getHostLocalInfo("with-jump")?.meta.jump_host).toBe("bastion");
    expect(broker.getHostLocalInfo("no-jump")?.meta.jump_host).toBeUndefined();
  });

  it("acquireHost accepts a managed host (no files) with jump_host", async () => {
    transport.hostPayloads.set("managed-t", {
      credential: {
        name: "managed-t",
        type: "ssh",
        files: [],
        metadata: { ip: "10.0.0.9", port: 22, username: "ops", auth_type: "managed", is_production: false, jump_host: "bastion" },
        ttl_seconds: 300,
      },
    });
    await broker.acquireHost("managed-t", "test");
    const info = broker.getHostLocalInfo("managed-t");
    expect(info?.meta.auth_type).toBe("managed");
    expect(info?.meta.jump_host).toBe("bastion");
  });

  it("rejects a managed host with no jump_host", async () => {
    transport.hostPayloads.set("bad-managed", {
      credential: {
        name: "bad-managed",
        type: "ssh",
        files: [],
        metadata: { ip: "10.0.0.9", port: 22, username: "ops", auth_type: "managed", is_production: false },
        ttl_seconds: 300,
      },
    });
    await expect(broker.acquireHost("bad-managed", "test")).rejects.toThrow(/managed.*no jump_chain or metadata\.jump_host/);
  });

  it("acquireHost materializes a jump_chain under isolated per-hop paths + records jumpChain (kept out of filePaths)", async () => {
    transport.hostPayloads.set("target", {
      credential: {
        name: "target",
        type: "ssh",
        files: [{ name: "host.key", content: "TARGET_KEY", mode: 0o600 }],
        metadata: { ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", is_production: false, jump_host: "nearest" },
        jump_chain: [
          { name: "outer", metadata: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key" }, files: [{ name: "host.key", content: "OUTER_KEY", mode: 0o600 }] },
          { name: "nearest", metadata: { ip: "10.0.0.2", port: 22, username: "ops", auth_type: "password" }, files: [{ name: "host.password", content: "NEAR_PW" }] },
        ],
        ttl_seconds: 300,
      },
    });
    await broker.acquireHost("target", "test");
    const info = broker.getHostLocalInfo("target")!;
    // The target's OWN files only — hop files must NOT leak into filePaths (so
    // ssh-client's suffix lookup can't match a hop file).
    expect(info.filePaths).toEqual([path.join(dir, "hosts", "target.host.key")]);
    // Structured chain [outermost … nearest] with isolated per-hop paths.
    expect(info.jumpChain).toEqual([
      { meta: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key" }, filePaths: [path.join(dir, "hosts", "target.hop0.host.key")] },
      { meta: { ip: "10.0.0.2", port: 22, username: "ops", auth_type: "password" }, filePaths: [path.join(dir, "hosts", "target.hop1.host.password")] },
    ]);
    expect(fs.readFileSync(path.join(dir, "hosts", "target.hop0.host.key"), "utf-8")).toBe("OUTER_KEY");
    expect(fs.readFileSync(path.join(dir, "hosts", "target.hop1.host.password"), "utf-8")).toBe("NEAR_PW");
  });

  it("invalidateHostCredentials drops the cache + hop files, forcing ensureHost to re-acquire", async () => {
    transport.hostPayloads.set("target", {
      credential: {
        name: "target", type: "ssh",
        files: [{ name: "host.key", content: "K", mode: 0o600 }],
        metadata: { ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", is_production: false, jump_host: "b" },
        jump_chain: [{ name: "b", metadata: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key" }, files: [{ name: "host.key", content: "BK", mode: 0o600 }] }],
        ttl_seconds: 300,
      },
    });

    // First ensure materializes; a second ensure within TTL serves the cache.
    await broker.ensureHost("target", "first");
    await broker.ensureHost("target", "second");
    expect(transport.getHostCalls).toEqual(["target"]); // cached — no re-fetch

    const own = path.join(dir, "hosts", "target.host.key");
    const hop = path.join(dir, "hosts", "target.hop0.host.key");
    expect(fs.existsSync(own)).toBe(true);
    expect(fs.existsSync(hop)).toBe(true);

    // Config-change reload: invalidate clears files + expiry, keeps metadata.
    broker.invalidateHostCredentials();
    expect(fs.existsSync(own)).toBe(false);
    expect(fs.existsSync(hop)).toBe(false);
    expect(broker.getHostsLocal().map((m) => m.name)).toContain("target");

    // Next ensure must walk the transport again (picks up the edited config).
    await broker.ensureHost("target", "after-reload");
    expect(transport.getHostCalls).toEqual(["target", "target"]);
    expect(fs.existsSync(own)).toBe(true);
  });

  it("dispose unlinks jump_chain hop files as well as the target's own", async () => {
    transport.hostPayloads.set("t2", {
      credential: {
        name: "t2", type: "ssh",
        files: [{ name: "host.key", content: "K", mode: 0o600 }],
        metadata: { ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", is_production: false, jump_host: "b" },
        jump_chain: [{ name: "b", metadata: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key" }, files: [{ name: "host.key", content: "BK", mode: 0o600 }] }],
        ttl_seconds: 300,
      },
    });
    await broker.acquireHost("t2", "test");
    const hop = path.join(dir, "hosts", "t2.hop0.host.key");
    expect(fs.existsSync(hop)).toBe(true);
    broker.dispose();
    expect(fs.existsSync(hop)).toBe(false);
  });

  it("acquireHost accepts a managed target carried by jump_chain (no metadata.jump_host)", async () => {
    transport.hostPayloads.set("m1", {
      credential: {
        name: "m1", type: "ssh", files: [],
        metadata: { ip: "10.0.0.9", port: 22, username: "ops", auth_type: "managed", is_production: false }, // no jump_host
        jump_chain: [{ name: "b", metadata: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key" }, files: [{ name: "host.key", content: "BK", mode: 0o600 }] }],
        ttl_seconds: 300,
      },
    });
    await broker.acquireHost("m1", "test");
    expect(broker.getHostLocalInfo("m1")?.meta.auth_type).toBe("managed");
    expect(broker.getHostLocalInfo("m1")?.jumpChain?.length).toBe(1);
  });

  it("ensureHost falls back to credential.name when the request handle differs (e.g. an id)", async () => {
    transport.hostPayloads.set("host-id-123", {
      credential: {
        name: "real-name", type: "ssh",
        files: [{ name: "host.key", content: "K", mode: 0o600 }],
        metadata: { ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", is_production: false },
        ttl_seconds: 300,
      },
    });
    const info = await broker.ensureHost("host-id-123", "test");
    expect(info.meta.name).toBe("real-name");
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

  it("parses metadata.meta on credential.get, filtering malformed entries", async () => {
    transport.clusterPayloads.set("c1", {
      credential: {
        name: "c1",
        type: "kubeconfig",
        files: [{ name: "c1.kubeconfig", content: "apiVersion: v1\nkind: Config\nclusters: []", mode: 0o640 }],
        metadata: {
          is_production: true,
          meta: [
            { key: "rdma_type", display_name: "RDMA Type", value: "SR-IOV" },
            { key: "scheduler", value: "volcano" },     // no display_name — still valid
            { key: "missing_value", display_name: "X" }, // no value → filtered
            { display_name: "no key", value: "v" },      // no key → filtered
            "garbage",                                   // not an object → filtered
          ],
        },
        ttl_seconds: 300,
      },
    });
    await broker.acquireCluster("c1", "test");
    const info = broker.getClusterLocalInfo("c1");
    expect(info?.meta.meta).toEqual([
      { key: "rdma_type", display_name: "RDMA Type", value: "SR-IOV" },
      { key: "scheduler", value: "volcano" },
    ]);
  });

  it("omits meta when credential.get carries no structured entries", async () => {
    transport.clusterPayloads.set("c2", {
      credential: {
        name: "c2",
        type: "kubeconfig",
        files: [{ name: "c2.kubeconfig", content: "apiVersion: v1\nkind: Config\nclusters: []", mode: 0o640 }],
        metadata: { is_production: false },
        ttl_seconds: 300,
      },
    });
    await broker.acquireCluster("c2", "test");
    expect(broker.getClusterLocalInfo("c2")?.meta.meta).toBeUndefined();
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

  it("queryHosts passes through to the transport without touching the registry (no reconcile)", async () => {
    transport.queryResult = {
      hosts: [{ name: "gpu-1", ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", is_production: true }],
      total: 1,
      next_cursor: null,
    };
    const result = await broker.queryHosts("gpu", { limit: 10 });
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].name).toBe("gpu-1");
    expect(result.total).toBe(1);
    expect(transport.queryHostsCalls).toEqual([{ query: "gpu", opts: { limit: 10 } }]);
    // No reconcile / no caching — the registry stays empty (full-snapshot contract intact).
    expect(broker.listHostsLocalInfo()).toHaveLength(0);
  });
});

describe("CredentialBroker — probeClusters batch", () => {
  // probeCluster runs real `kubectl version`; stub it so these tests exercise
  // only the batch contract (order, per-item fold pass-through, concurrency
  // bound) rather than kubectl.
  it("preserves input order and folds each per-cluster result (batch never rejects)", async () => {
    broker.probeCluster = async (name: string): Promise<ProbeResult> =>
      name === "bad"
        ? { name, probe_status: "unreachable", reachable: false, reason: "connection_refused", probe_error: "boom" }
        : { name, probe_status: "success", reachable: true, server_version: "v1.29.0" };

    const results = await broker.probeClusters(["good1", "bad", "good2"]);

    expect(results.map((r) => r.name)).toEqual(["good1", "bad", "good2"]);
    expect(results[1]).toEqual({ name: "bad", probe_status: "unreachable", reachable: false, reason: "connection_refused", probe_error: "boom" });
    expect(results[0].probe_status).toBe("success");
    expect(results[2].probe_status).toBe("success");
  });

  it("bounds in-flight probes to the given concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    broker.probeCluster = (name: string): Promise<ProbeResult> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<ProbeResult>((resolve) => {
        setTimeout(() => {
          active -= 1;
          resolve({ name, probe_status: "success", reachable: true, server_version: "unknown" });
        }, 5);
      });
    };

    const names = ["a", "b", "c", "d", "e"];
    const results = await broker.probeClusters(names, { concurrency: 2 });

    expect(maxActive).toBe(2); // never more than the cap in flight at once
    expect(results.map((r) => r.name)).toEqual(names); // order still preserved
  });

  it("folds an acquire failure into probe_failed/credential (never a rejected batch)", async () => {
    // FakeTransport.getClusterCredential throws when no payload is registered —
    // i.e. the kubeconfig can't even be fetched. That is a local/credential
    // problem, NOT a statement about the cluster.
    transport.clusters = [{ name: "c1", is_production: true }];
    await broker.refreshClusters();
    const [result] = await broker.probeClusters(["c1"]);
    expect(result.probe_status).toBe("probe_failed");
    if (result.probe_status === "probe_failed") {
      expect(result.reason).toBe("credential");
      expect(result).not.toHaveProperty("reachable");
    }
  });
});

describe("classifyKubectlProbeError — evidence-based classification", () => {
  // A killed child with a positive network error in stderr is a real network
  // failure; without such evidence it is a local timeout of unknown reachability.
  const killed = (message: string): Error =>
    Object.assign(new Error(message), { killed: true });
  const withCode = (message: string, code: string): Error =>
    Object.assign(new Error(message), { code });

  type Expectation = {
    probe_status: ProbeResult["probe_status"];
    reason?: string;
    reachable?: true | false | "absent";
  };

  const cases: Array<{ desc: string; err: Error; stderr: string; expect: Expectation }> = [
    {
      desc: "ENOENT — kubectl binary missing",
      err: withCode("spawn kubectl ENOENT", "ENOENT"),
      stderr: "",
      expect: { probe_status: "probe_failed", reason: "kubectl_missing", reachable: "absent" },
    },
    {
      desc: "EACCES — kubectl not executable",
      err: withCode("spawn kubectl EACCES", "EACCES"),
      stderr: "",
      expect: { probe_status: "probe_failed", reason: "kubectl_missing", reachable: "absent" },
    },
    {
      desc: "localhost:8080 fallback — missing/empty kubeconfig",
      err: new Error("exit 1"),
      stderr: "The connection to the server localhost:8080 was refused - did you specify the right host or port?",
      expect: { probe_status: "probe_failed", reason: "kubeconfig", reachable: "absent" },
    },
    {
      desc: "no configuration provided — invalid kubeconfig",
      err: new Error("exit 1"),
      stderr: "error: no configuration has been provided, try setting KUBERNETES_MASTER environment variable",
      expect: { probe_status: "probe_failed", reason: "kubeconfig", reachable: "absent" },
    },
    {
      desc: "no context is currently set — kubeconfig",
      err: new Error("exit 1"),
      stderr: 'error: no context is currently set, use "kubectl config use-context <context>" to select a new one',
      expect: { probe_status: "probe_failed", reason: "kubeconfig", reachable: "absent" },
    },
    {
      desc: "hung exec credential plugin — kubeconfig (request never left the host)",
      err: new Error("exit 1"),
      stderr: "error: getting credentials: exec: executable aws-iam-authenticator not found",
      expect: { probe_status: "probe_failed", reason: "kubeconfig", reachable: "absent" },
    },
    {
      desc: "401 Unauthorized — auth, server answered so reachable:true",
      err: new Error("exit 1"),
      stderr: "error: You must be logged in to the server (Unauthorized)",
      expect: { probe_status: "probe_failed", reason: "auth", reachable: true },
    },
    {
      desc: "403 Forbidden — authz, server answered so reachable:true",
      err: new Error("exit 1"),
      stderr: 'Error from server (Forbidden): pods is forbidden: User "x" cannot list resource "pods"',
      expect: { probe_status: "probe_failed", reason: "authz", reachable: true },
    },
    {
      desc: "404 NotFound — endpoint answered but NOT proof of a healthy API (no reachable)",
      err: new Error("exit 1"),
      stderr: "Error from server (NotFound): the server could not find the requested resource",
      expect: { probe_status: "probe_failed", reason: "endpoint", reachable: "absent" },
    },
    {
      desc: "x509 — certificate validation failure, TLS not completed (no reachable)",
      err: new Error("exit 1"),
      stderr: "Unable to connect to the server: x509: certificate signed by unknown authority",
      expect: { probe_status: "probe_failed", reason: "tls_cert", reachable: "absent" },
    },
    {
      desc: "DNS — hostname did not resolve",
      err: new Error("exit 1"),
      stderr: 'Unable to connect to the server: dial tcp: lookup api.example.com on 10.0.0.1:53: no such host',
      expect: { probe_status: "unreachable", reason: "dns", reachable: false },
    },
    {
      desc: "connection refused — real API server host:port",
      err: new Error("exit 1"),
      stderr: "The connection to the server 10.0.0.5:6443 was refused - did you specify the right host or port?",
      expect: { probe_status: "unreachable", reason: "connection_refused", reachable: false },
    },
    {
      desc: "connection reset",
      err: new Error("exit 1"),
      stderr: "Unable to connect to the server: read tcp 10.0.0.9:443: connection reset by peer",
      expect: { probe_status: "unreachable", reason: "connection_reset", reachable: false },
    },
    {
      desc: "no route to host",
      err: new Error("exit 1"),
      stderr: "Unable to connect to the server: dial tcp 10.0.0.5:6443: connect: no route to host",
      expect: { probe_status: "unreachable", reason: "network", reachable: false },
    },
    {
      desc: "client-go request timeout — positive network-timeout evidence",
      err: new Error("exit 1"),
      stderr: "Unable to connect to the server: net/http: request canceled (Client.Timeout exceeded) i/o timeout",
      expect: { probe_status: "unreachable", reason: "timeout", reachable: false },
    },
    {
      desc: "child killed with client-go timeout evidence — evidence wins, unreachable",
      err: killed("Command failed"),
      stderr: "Unable to connect to the server: context deadline exceeded",
      expect: { probe_status: "unreachable", reason: "timeout", reachable: false },
    },
    {
      desc: "child killed WITHOUT network evidence — local timeout, reachability unknown",
      err: killed("Command was killed with SIGTERM"),
      stderr: "",
      expect: { probe_status: "probe_failed", reason: "timeout", reachable: "absent" },
    },
    {
      desc: "unrecognised stderr — unknown, no reachability claim",
      err: new Error("exit 1"),
      stderr: "error: some brand new kubectl failure we have never seen",
      expect: { probe_status: "probe_failed", reason: "unknown", reachable: "absent" },
    },
  ];

  for (const c of cases) {
    it(c.desc, () => {
      const r = classifyKubectlProbeError("c1", c.err, c.stderr);
      expect(r.name).toBe("c1");
      expect(r.probe_status).toBe(c.expect.probe_status);
      if (c.expect.reason !== undefined && r.probe_status !== "success") {
        expect(r.reason).toBe(c.expect.reason);
      }
      if (c.expect.reachable === "absent") {
        expect(r).not.toHaveProperty("reachable");
      } else if (c.expect.reachable !== undefined) {
        expect((r as { reachable?: boolean }).reachable).toBe(c.expect.reachable);
      }
      // Every non-success result carries a non-empty probe_error.
      if (r.probe_status !== "success") {
        expect(typeof r.probe_error).toBe("string");
        expect(r.probe_error.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("withProbeTimeout — aborts timed-out work before it reaches kubectl", () => {
  it("resolves with probe_failed/timeout and never starts post-timeout work", async () => {
    let startedWorkAfterTimeout = false;
    const result = await withProbeTimeout(
      "c1",
      async (signal) => {
        // Simulate a credential fetch that outlives the probe timeout.
        await new Promise((r) => setTimeout(r, 40));
        if (signal.aborted) {
          // Correct: the guard prevents spawning kubectl after the timeout.
          return { name: "c1", probe_status: "probe_failed", reason: "credential", probe_error: "aborted before kubectl" };
        }
        startedWorkAfterTimeout = true;
        return { name: "c1", probe_status: "success", reachable: true, server_version: "v1" };
      },
      10,
    );
    expect(result.probe_status).toBe("probe_failed");
    if (result.probe_status === "probe_failed") expect(result.reason).toBe("timeout");
    // Let the late operation settle and confirm it took the aborted branch.
    await new Promise((r) => setTimeout(r, 60));
    expect(startedWorkAfterTimeout).toBe(false);
  });

  it("returns the operation result verbatim when it finishes before the timeout", async () => {
    const result = await withProbeTimeout(
      "c1",
      async () => ({ name: "c1", probe_status: "success", reachable: true, server_version: "v1.30.0" }),
      1000,
    );
    expect(result).toEqual({ name: "c1", probe_status: "success", reachable: true, server_version: "v1.30.0" });
  });

  it("probeCluster does not run kubectl once the probe has timed out fetching credentials", async () => {
    // ensureCluster resolves a (fake) path AFTER the probe timeout. If the guard
    // is wired, probeKubeconfig is never called — so the reason stays `timeout`,
    // NOT `kubectl_missing`/`unknown` (which is what a real kubectl spawn against
    // a bogus path with no kubectl on PATH would produce).
    broker.ensureCluster = (name: string): Promise<ClusterLocalInfo> =>
      new Promise((res) =>
        setTimeout(() => res({ meta: { name, is_production: false }, path: "/definitely/not/a/real/kubeconfig" }), 40),
      );
    const [result] = await broker.probeClusters(["c1"], { timeoutMs: 10 });
    expect(result.probe_status).toBe("probe_failed");
    if (result.probe_status === "probe_failed") expect(result.reason).toBe("timeout");
    await new Promise((r) => setTimeout(r, 60)); // let the late ensureCluster settle
  });
});
