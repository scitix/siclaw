/**
 * CredentialBroker — AgentBox-side cache + local materialization for cluster
 * and host credentials. Sits between tools and the gateway's CredentialService.
 *
 * Internally factors a generic ResourceRegistry<TMeta> that owns the registry
 * Map, file materialization (with optional setgid shared-group permissions),
 * TTL eviction and disposal. The broker holds one registry per resource kind
 * (cluster + host) and exposes a kind-specific public API:
 *   listClusters / acquireCluster / ensureCluster / probeCluster / ...
 *   listHosts    / acquireHost    / ensureHost    / ...
 *
 * Cluster-only specifics:
 *   - acquireCluster supports cache-hit reconstruction (reconstructResponse)
 *     because kubeconfig-resolver's sync API needs cache hits to never touch
 *     the transport.
 *   - probeCluster runs `kubectl version` for connectivity check.
 *
 * Host has no synchronous consumer in this PR (no host_* tools yet), so:
 *   - acquireHost does NOT implement cache reconstruction; every call goes
 *     through the transport.
 *   - HostLocalInfo.path is intentionally undefined; consumers must walk
 *     filePaths if they need the credential file path.
 *
 * The broker is a per-AgentBox singleton (per (userId, agentId) in K8s mode;
 * per-process in TUI). LocalSpawner already gives each user/agent its own
 * credentialsDir, so cross-user leakage is impossible.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ConcurrencyLimiter } from "../core/concurrency-limiter.js";
import type {
  CredentialTransport,
  ClusterMeta,
  HostMeta,
  CredentialPayload,
  HostListResult,
} from "./credential-transport.js";
import type { ChainHop, ChainHopMeta, ClusterMetaEntry } from "../shared/credential-types.js";

export type { ClusterMeta, HostMeta, CredentialPayload, HostListResult };

export interface CredentialFile {
  name: string;
  content: string;
  mode?: number;
}

export interface CredentialResponse extends CredentialPayload {}

export interface LocalInfo<TMeta extends { name: string }> {
  meta: TMeta;
  /** Main file path, set by the caller (cluster computes from filePaths). */
  path?: string;
  /** The credential's OWN materialized file paths (target host only — NOT the
   * bastion hop files, which live in jumpChain). Unlinked on evict. */
  filePaths?: string[];
  /**
   * Materialized bastion chain (host only), ordered [outermost … nearest].
   * Each hop's files are materialized under isolated paths kept OUT of
   * filePaths (so target file-suffix lookups never match a hop file); tracked
   * for eviction alongside filePaths. The Runtime builds the SshTarget.jumpHost
   * chain from this — no per-hop credential.get recursion.
   */
  jumpChain?: Array<{ meta: ChainHopMeta; filePaths: string[] }>;
  /** When the cached credential expires; undefined if metadata-only. */
  expiresAt?: number;
}

export type ClusterLocalInfo = LocalInfo<ClusterMeta>;
export type HostLocalInfo = LocalInfo<HostMeta>;

/**
 * Why `unreachable` was concluded — the API server could not be contacted at the
 * network layer. Every one of these is a statement ABOUT THE CLUSTER.
 */
export type UnreachableReason =
  | "connection_refused" // TCP RST — nothing listening / firewalled at the API server host:port
  | "dns"                // the API server hostname did not resolve
  | "network"            // no route / network unreachable / generic transport failure
  | "connection_reset"   // peer reset / EOF / broken pipe mid-request
  | "timeout";           // i/o timeout / context deadline / TLS handshake timeout

/**
 * Why `probe_failed` was concluded. NONE of these say the cluster is down — they
 * are LOCAL tooling, kubeconfig, credential, or auth/trust problems (or an
 * operation timeout that never reached a verdict). Surfacing the specific reason
 * stops a caller from reading "probe failed" as "cluster is unreachable".
 */
export type ProbeFailedReason =
  | "kubectl_missing" // kubectl binary absent / not executable (local tooling)
  | "kubeconfig"      // kubeconfig empty/invalid/no server/bad context/authinfo (local config)
  | "credential"      // the kubeconfig could not even be acquired from the gateway
  | "auth"            // API server ANSWERED and rejected the identity (401 Unauthorized)
  | "authz"           // API server ANSWERED but RBAC denied the request (403 Forbidden)
  | "endpoint"        // an HTTP endpoint answered 404 (NotFound) — proves SOMETHING replied,
                      // but a wrong server URL or an intermediary can produce this too, so it
                      // is NOT proof of a healthy Kubernetes API. Reachability stays unknown.
  | "tls_cert"        // server reached at TCP but its certificate is untrusted/expired/mismatched
  | "timeout"         // the probe operation itself did not return in time — verdict unknown
  | "unknown";        // kubectl failed for a reason we cannot confidently attribute

export type ProbeResult =
  | { name: string; probe_status: "success"; reachable: true; server_version: string }
  | { name: string; probe_status: "unreachable"; reachable: false; reason: UnreachableReason; probe_error: string }
  // probe_failed carries reachable:true ONLY for auth (401) and authz (403) — the
  // API server both ANSWERED and adjudicated the identity/RBAC, which is proof the
  // cluster IS reachable; the problem is this side's credentials/RBAC, not a down
  // cluster. Every other reason omits reachable: a local/config/timeout failure
  // never established reachability; tls_cert reached TCP but not a full HTTP
  // exchange; and a 404 (`endpoint`) only proves *an* HTTP responder answered,
  // which a misrouted URL or intermediary can fake — not a healthy K8s API.
  | { name: string; probe_status: "probe_failed"; reason: ProbeFailedReason; reachable?: true; probe_error: string };

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes (unused; payload carries ttl)
void DEFAULT_TTL_MS;

interface RegistryOptions {
  /** File mode applied at write time (e.g. 0o640 for shared-group, 0o600 owner-only). */
  fileMode: number;
  /** Optional unix group name to chgrp newly-written files (e.g. "kubecred", "hostcred"). */
  sharedGroup?: string;
}

// ---------------------------------------------------------------------------
// ResourceRegistry — generic cache + materialization for one resource kind
// ---------------------------------------------------------------------------

class ResourceRegistry<TMeta extends { name: string }> {
  private readonly map = new Map<string, LocalInfo<TMeta>>();
  private readonly subdirAbs: string;

  constructor(
    private readonly subdir: string,                  // "clusters" | "hosts"
    private readonly credentialsDir: string,
    private readonly opts: RegistryOptions,
  ) {
    this.subdirAbs = path.join(credentialsDir, subdir);
    fs.mkdirSync(this.subdirAbs, { recursive: true });
  }

  /**
   * Reconcile registry against a full snapshot of metas: upsert what's in the
   * snapshot, prune what isn't (unlinking materialized files for the dropped
   * entries), preserve already-acquired paths/expiry for entries that remain.
   *
   * Contract: `metas` MUST be a full snapshot. Do NOT pass paged/filtered
   * results — the prune step will drop any entry not in `metas`. If pagination
   * is ever needed at the broker level, the service layer must aggregate
   * before calling here.
   */
  reconcileFullList(metas: TMeta[]): TMeta[] {
    const keep = new Set(metas.map((m) => m.name));

    // Drop anything not in the snapshot, unlinking materialized files.
    for (const [name, entry] of this.map) {
      if (keep.has(name)) continue;
      this.unlinkEntry(entry);
      this.map.delete(name);
    }

    // Upsert, preserving prior path/expiry/chain for existing entries.
    for (const meta of metas) {
      const existing = this.map.get(meta.name);
      this.map.set(meta.name, {
        meta,
        path: existing?.path,
        filePaths: existing?.filePaths,
        jumpChain: existing?.jumpChain,
        expiresAt: existing?.expiresAt,
      });
    }
    return metas;
  }

  /** Upsert a single meta entry without prune (used after acquire-shaped fetches). */
  upsertMeta(meta: TMeta): void {
    const existing = this.map.get(meta.name);
    this.map.set(meta.name, {
      meta,
      path: existing?.path,
      filePaths: existing?.filePaths,
      jumpChain: existing?.jumpChain,
      expiresAt: existing?.expiresAt,
    });
  }

  /**
   * Atomically write all `files` under `<credentialsDir>/<subdir>/<name>.<file>`.
   * Returns the list of written file paths. Does NOT compute a "main" path;
   * callers decide which file is primary (cluster picks `.kubeconfig`).
   */
  setMaterialized(name: string, meta: TMeta, files: CredentialFile[], ttlMs: number, chain?: ChainHop[]): string[] {
    // Sanitize the credential name before it becomes part of a file path.
    // path.basename alone is not enough — ".." or slashes inside would still
    // land in <dir>/<..>.xxx. Strip anything that isn't a safe name char.
    const safeName = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
    if (!safeName || safeName === "." || safeName === "..") {
      console.warn(`[credential-broker] unsafe credential name blocked: "${name}"`);
      return [];
    }

    const paths = this.writeFiles(safeName, files);

    // Materialize each bastion hop under an isolated per-hop prefix
    // (<name>.hop<i>.<file>) so identically-named files (host.key/…) don't
    // collide with the target's or each other. Kept OUT of filePaths so the
    // target's file-suffix lookups in ssh-client never match a hop file;
    // tracked for eviction via unlinkEntry. See jump-chain design §6.3.
    let jumpChain: Array<{ meta: ChainHopMeta; filePaths: string[] }> | undefined;
    if (chain && chain.length > 0) {
      jumpChain = chain.map((hop, i) => ({
        meta: hop.metadata,
        filePaths: this.writeFiles(`${safeName}.hop${i}`, hop.files),
      }));
    }

    const existing = this.map.get(name);
    this.map.set(name, {
      meta,
      path: existing?.path, // caller may overwrite via setMainPath
      filePaths: paths,
      jumpChain,
      expiresAt: Date.now() + ttlMs,
    });
    return paths;
  }

  /**
   * Atomically write `files` under `<subdir>/<prefix>.<file>` with the
   * registry's mode / shared-group policy. Returns the written paths. Shared by
   * the target credential and each materialized jump_chain hop.
   */
  private writeFiles(prefix: string, files: CredentialFile[]): string[] {
    const sharedGid = this.opts.sharedGroup
      ? resolveGroupGid(this.opts.sharedGroup)
      : null;
    const desiredMode = sharedGid !== null ? this.opts.fileMode : 0o600;
    const paths: string[] = [];

    for (const file of files) {
      const safeFile = path.basename(file.name);
      const filePath = path.join(this.subdirAbs, `${prefix}.${safeFile}`);
      // Defense-in-depth: ensure the resolved path is still under subdirAbs.
      const rel = path.relative(this.subdirAbs, filePath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        console.warn(`[credential-broker] path traversal blocked: ${filePath}`);
        continue;
      }
      const tmpPath = filePath + ".new";
      // K8s mode: kubectl/ssh runs as `sandbox` (uid 1001) which is a member
      // of the kubecred / hostcred group; the file needs group-read.
      // Local mode: sharedGroup gid resolves to null → fall back to 0600.
      fs.writeFileSync(tmpPath, file.content, { mode: desiredMode });
      if (sharedGid !== null) {
        try {
          fs.chownSync(tmpPath, -1, sharedGid);
        } catch (err) {
          console.warn(`[credential-broker] chgrp failed for ${tmpPath}:`, err);
        }
      }
      fs.renameSync(tmpPath, filePath);
      paths.push(filePath);
    }
    return paths;
  }

  setMainPath(name: string, mainPath: string | undefined): void {
    const entry = this.map.get(name);
    if (!entry) return;
    entry.path = mainPath;
  }

  get(name: string): LocalInfo<TMeta> | undefined {
    return this.map.get(name);
  }

  list(): LocalInfo<TMeta>[] {
    return Array.from(this.map.values());
  }

  /** Remove expired file paths from disk and clear path/expiresAt. Metadata is kept. */
  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (!entry.expiresAt || entry.expiresAt > now) continue;
      this.unlinkEntry(entry);
      this.map.set(key, {
        meta: entry.meta,
        path: undefined,
        filePaths: undefined,
        jumpChain: undefined,
        expiresAt: undefined,
      });
    }
  }

  /**
   * Force-invalidate the materialized credential of EVERY entry, regardless of
   * TTL: unlink files (incl. jump_chain hops) and clear path/filePaths/
   * jumpChain/expiresAt, keeping metadata. The next ensure*() re-acquires from
   * source. Used on a config/credential-change reload so an edited host/cluster
   * cannot keep serving its stale (pre-edit) credential within its TTL window.
   * Same shape as evictExpired() minus the expiry guard.
   */
  invalidateAll(): void {
    for (const [key, entry] of this.map) {
      this.unlinkEntry(entry);
      this.map.set(key, {
        meta: entry.meta,
        path: undefined,
        filePaths: undefined,
        jumpChain: undefined,
        expiresAt: undefined,
      });
    }
  }

  dispose(): void {
    for (const entry of this.map.values()) {
      this.unlinkEntry(entry);
    }
    this.map.clear();
  }

  /** Unlink a credential's own files AND its materialized jump_chain hop files. */
  private unlinkEntry(entry: LocalInfo<TMeta>): void {
    this.unlinkFiles(entry.filePaths);
    if (entry.jumpChain) {
      for (const hop of entry.jumpChain) this.unlinkFiles(hop.filePaths);
    }
  }

  private unlinkFiles(filePaths: string[] | undefined): void {
    if (!filePaths) return;
    for (const fp of filePaths) {
      try { fs.unlinkSync(fp); } catch { /* already gone */ }
    }
  }
}

// ---------------------------------------------------------------------------
// CredentialBroker — public API per resource kind
// ---------------------------------------------------------------------------

export class CredentialBroker {
  private readonly clusters: ResourceRegistry<ClusterMeta>;
  private readonly hosts: ResourceRegistry<HostMeta>;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  // Readiness flags — true once refreshClusters/refreshHosts has succeeded at
  // least once. Lets tool consumers distinguish "no resources bound" (Map
  // empty, flag true) from "not yet initialized" (Map empty, flag false).
  // Flags are NOT reset on refresh failure: we keep the last-good Map for
  // sync reads rather than force every tool call to await Gateway.
  private clustersInitialized = false;
  private hostsInitialized = false;

  // Inflight Promise dedup — concurrent refresh callers (tool lazy-fill +
  // notify endpoint) share one transport round-trip.
  private clusterRefreshInflight: Promise<ClusterMeta[]> | null = null;
  private hostRefreshInflight: Promise<HostMeta[]> | null = null;

  constructor(
    private readonly transport: CredentialTransport,
    credentialsDir?: string,
  ) {
    const dir = credentialsDir || path.resolve(process.cwd(), ".siclaw/credentials");
    fs.mkdirSync(dir, { recursive: true });
    this.clusters = new ResourceRegistry<ClusterMeta>("clusters", dir, {
      fileMode: 0o640,
      sharedGroup: "kubecred",
    });
    this.hosts = new ResourceRegistry<HostMeta>("hosts", dir, {
      fileMode: 0o640,
      sharedGroup: "hostcred",
    });
    this.cleanupTimer = setInterval(() => {
      this.clusters.evictExpired();
      this.hosts.evictExpired();
    }, 60_000);
  }

  // ──────────────────────────────────────────────────────────
  // Cluster API
  // ──────────────────────────────────────────────────────────

  /**
   * Refresh metadata for all clusters bound to this agent and reconcile the
   * registry authoritatively. Does NOT eagerly acquire kubeconfigs.
   *
   * Inflight dedup: concurrent callers share the in-progress transport call
   * rather than each issue their own. Readiness flag is set to true on
   * success and left unchanged on failure (see class docs).
   */
  async refreshClusters(): Promise<ClusterMeta[]> {
    if (this.clusterRefreshInflight) return this.clusterRefreshInflight;
    this.clusterRefreshInflight = (async () => {
      try {
        const metas = await this.transport.listClusters();
        const result = this.clusters.reconcileFullList(metas);
        this.clustersInitialized = true;
        return result;
      } finally {
        this.clusterRefreshInflight = null;
      }
    })();
    return this.clusterRefreshInflight;
  }

  /** Synchronous read of the cluster metadata Map. Empty if never refreshed. */
  getClustersLocal(): ClusterMeta[] {
    return this.clusters.list().map((info) => info.meta);
  }

  /** true once refreshClusters() has succeeded at least once. */
  isClustersReady(): boolean {
    return this.clustersInitialized;
  }

  /**
   * Fetch a single cluster's kubeconfig and materialize it to disk.
   * Returns cached entry if still valid (unless bypassCache).
   */
  async acquireCluster(
    sourceId: string,
    purpose: string,
    options: { bypassCache?: boolean } = {},
  ): Promise<CredentialResponse> {
    const cached = this.clusters.get(sourceId);
    if (
      !options.bypassCache &&
      cached?.path &&
      cached.expiresAt !== undefined &&
      cached.expiresAt > Date.now()
    ) {
      return reconstructClusterResponse(cached);
    }

    const response = await this.transport.getClusterCredential(sourceId, purpose);
    const meta = mergeClusterMeta(cached?.meta, response);
    const ttlMs = (response.credential.ttl_seconds ?? 300) * 1000;
    const filePaths = this.clusters.setMaterialized(response.credential.name, meta, response.credential.files, ttlMs);
    const mainKubeconfig = filePaths.find((p) => p.endsWith(".kubeconfig")) ?? filePaths[0];
    this.clusters.setMainPath(response.credential.name, mainKubeconfig);

    console.log(
      `[credential-broker] acquired cluster "${response.credential.name}" ` +
      `(ttl=${ttlMs / 1000}s, files=${filePaths.length})`,
    );
    return response;
  }

  /**
   * Ensure a cluster has been acquired at least once (path available).
   * Triggers acquireCluster if missing or expired. Used by the
   * ensureClusterForTool helper before a synchronous resolve.
   */
  async ensureCluster(clusterName: string, purpose = "ensure"): Promise<ClusterLocalInfo> {
    const existing = this.clusters.get(clusterName);
    if (
      existing?.path &&
      existing.expiresAt !== undefined &&
      existing.expiresAt > Date.now() &&
      fs.existsSync(existing.path)
    ) {
      return existing;
    }
    await this.acquireCluster(clusterName, purpose);
    const refreshed = this.clusters.get(clusterName);
    if (!refreshed?.path) {
      throw new Error(`Broker.ensureCluster(${clusterName}) completed but path is missing`);
    }
    return refreshed;
  }

  /**
   * Probe a single cluster's connectivity with `kubectl version`.
   *
   * Reuses the cached kubeconfig when still valid (ensureCluster), acquiring
   * only on miss/expiry — a reachability check does not need FRESH credentials,
   * and reuse avoids a credential.get round-trip on every probe (also warming
   * the cache for the kubectl/script tools that follow). Any acquire failure
   * (unbound, credential error) is folded into probe_failed rather than thrown,
   * so a batch probe never fails as a whole or misreports a local failure as a
   * Kubernetes API reachability failure.
   */
  async probeCluster(clusterName: string, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
    // A probe is diagnostic work, not a general credential/tool request. Keep
    // it bounded so a stalled Runtime/Portal RPC cannot make cluster_list look
    // hung until the normal 30s RPC timeout expires. On timeout the signal is
    // aborted; we check it before spawning kubectl so a slow credential fetch
    // that outlives the timeout can NEVER continue into post-timeout kubectl work.
    return withProbeTimeout(clusterName, async (signal) => {
      let info: ClusterLocalInfo;
      try {
        info = await this.ensureCluster(clusterName, "cluster_probe");
      } catch (err) {
        return {
          name: clusterName,
          probe_status: "probe_failed",
          reason: "credential",
          probe_error: `could not acquire kubeconfig: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // The credential fetch may have taken longer than the probe timeout. If we
      // have already timed out, do NOT spawn kubectl — the caller was handed a
      // timeout result and a late kubectl here would be unbounded work outside the
      // concurrency limiter's slot.
      if (signal.aborted) {
        return {
          name: clusterName,
          probe_status: "probe_failed",
          reason: "timeout",
          probe_error: "probe timed out during credential acquisition; kubectl was not started",
        };
      }
      if (!info?.path) {
        return {
          name: clusterName,
          probe_status: "probe_failed",
          reason: "credential",
          probe_error: "kubeconfig path missing after acquire",
        };
      }
      return probeKubeconfig(clusterName, info.path, signal);
    }, opts.timeoutMs);
  }

  /**
   * Probe several clusters concurrently, bounded so an agent with many bound
   * clusters can't spawn an unbounded fan-out of kubectl processes. Each probe
   * is independent — a per-cluster failure yields an unreachable or probe_failed
   * result in place, never a rejected batch. Results preserve input order.
   */
  async probeClusters(
    clusterNames: string[],
    opts: { concurrency?: number; timeoutMs?: number } = {},
  ): Promise<ProbeResult[]> {
    const limiter = new ConcurrencyLimiter(opts.concurrency ?? 8);
    return Promise.all(
      clusterNames.map((name) => limiter.run(() => this.probeCluster(name, { timeoutMs: opts.timeoutMs }))),
    );
  }

  getClusterLocalInfo(clusterName: string): ClusterLocalInfo | undefined {
    return this.clusters.get(clusterName);
  }

  listClustersLocalInfo(): ClusterLocalInfo[] {
    return this.clusters.list();
  }

  // ──────────────────────────────────────────────────────────
  // Host API
  // ──────────────────────────────────────────────────────────

  /**
   * Refresh metadata for all hosts bound to this agent and reconcile the
   * registry authoritatively. Mirrors refreshClusters — see its docstring.
   */
  async refreshHosts(): Promise<HostMeta[]> {
    if (this.hostRefreshInflight) return this.hostRefreshInflight;
    this.hostRefreshInflight = (async () => {
      try {
        const metas = await this.transport.listHosts();
        const result = this.hosts.reconcileFullList(metas);
        this.hostsInitialized = true;
        return result;
      } finally {
        this.hostRefreshInflight = null;
      }
    })();
    return this.hostRefreshInflight;
  }

  /** Synchronous read of the host metadata Map. Empty if never refreshed. */
  getHostsLocal(): HostMeta[] {
    return this.hosts.list().map((info) => info.meta);
  }

  /**
   * Filtered + paginated host_list (name/ip/description). Bypasses the registry
   * entirely — does NOT reconcile or cache — so it can't violate the full-snapshot
   * contract of refreshHosts/reconcileFullList. Used by the host_list tool
   * (metadata only, no credentials).
   */
  async queryHosts(query: string, opts?: { limit?: number; cursor?: string }): Promise<HostListResult> {
    return this.transport.queryHosts(query, opts);
  }

  /** true once refreshHosts() has succeeded at least once. */
  isHostsReady(): boolean {
    return this.hostsInitialized;
  }

  /**
   * Drop every host's materialized credential (files + jump_chain + expiry),
   * keeping metadata. Forces the next ensureHost() to re-acquire via
   * credential.get. Call this on a host config/credential-change reload —
   * refreshHosts() alone only reconciles metadata and PRESERVES the materialized
   * credential for still-bound hosts, so an edited host would otherwise keep
   * dialing its stale (pre-edit) ip/auth/jump_chain until the TTL lapses.
   */
  invalidateHostCredentials(): void {
    this.hosts.invalidateAll();
  }

  /** Cluster analogue of invalidateHostCredentials — drop cached kubeconfigs. */
  invalidateClusterCredentials(): void {
    this.clusters.invalidateAll();
  }

  /**
   * Refresh both cluster and host metadata in parallel. Used by the
   * notify endpoint so that a single POST refills both Maps.
   */
  async refreshAll(): Promise<{ clusters: number; hosts: number }> {
    const [c, h] = await Promise.all([this.refreshClusters(), this.refreshHosts()]);
    return { clusters: c.length, hosts: h.length };
  }

  /**
   * Fetch a single host's credential and materialize it to disk. Unlike
   * acquireCluster, this does NOT do cache-hit reconstruction — there is no
   * synchronous consumer in this PR that requires it. Every call walks the
   * transport. Cache-hit semantics can be added when host_* tools land.
   */
  async acquireHost(
    sourceId: string,
    purpose: string,
    _options: { bypassCache?: boolean } = {},
  ): Promise<CredentialResponse> {
    const response = await this.transport.getHostCredential(sourceId, purpose);
    const cached = this.hosts.get(sourceId);
    const meta = mergeHostMeta(cached?.meta, response, sourceId);
    const ttlMs = (response.credential.ttl_seconds ?? 300) * 1000;
    const filePaths = this.hosts.setMaterialized(
      response.credential.name, meta, response.credential.files, ttlMs,
      response.credential.jump_chain,
    );
    // Host has no "main path" concept (no sync consumer). filePaths are enough.

    const hopCount = response.credential.jump_chain?.length ?? 0;
    console.log(
      `[credential-broker] acquired host "${response.credential.name}" ` +
      `(ttl=${ttlMs / 1000}s, files=${filePaths.length}, jump_hops=${hopCount})`,
    );
    return response;
  }

  /**
   * Ensure a host has been acquired at least once and its files exist on disk.
   * Triggers acquireHost if missing or expired.
   */
  async ensureHost(hostName: string, purpose = "ensure"): Promise<HostLocalInfo> {
    const existing = this.hosts.get(hostName);
    // Managed hosts have no key/password file (the key is sourced from the
    // bastion at dial time), so file existence isn't a freshness/materialization
    // requirement for them — TTL alone governs.
    const existingManaged = existing?.meta?.auth_type === "managed";
    const fresh = existing?.expiresAt !== undefined
      && existing.expiresAt > Date.now()
      && (existingManaged || (existing.filePaths?.every((fp) => fs.existsSync(fp)) ?? false));
    if (existing && fresh) return existing;
    const response = await this.acquireHost(hostName, purpose);
    // Registry is keyed by credential.name. When the caller's handle isn't the
    // name (e.g. a host id), get(hostName) misses — fall back to the just-
    // acquired response's name before failing. See jump-chain design §6.2.
    const refreshed = this.hosts.get(hostName) ?? this.hosts.get(response.credential.name);
    if (!refreshed) {
      throw new Error(`Broker.ensureHost(${hostName}) completed but host not in registry`);
    }
    if (refreshed.meta?.auth_type !== "managed" && (!refreshed.filePaths || refreshed.filePaths.length === 0)) {
      throw new Error(`Broker.ensureHost(${hostName}) completed but no files materialized`);
    }
    return refreshed;
  }

  getHostLocalInfo(hostName: string): HostLocalInfo | undefined {
    return this.hosts.get(hostName);
  }

  listHostsLocalInfo(): HostLocalInfo[] {
    return this.hosts.list();
  }

  // ──────────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────────

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.clusters.dispose();
    this.hosts.dispose();
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the numeric gid of a unix group (e.g. "kubecred", "hostcred"). In
 * K8s mode kubectl / future ssh wrappers are setgid'd to one of these groups
 * so the sandbox uid can read credential files via group permission. Returns
 * null when the group doesn't exist (Local mode, TUI).
 *
 * Result is cached across calls — /etc/group is read at most once per group.
 */
const groupGidCache = new Map<string, number | null>();

function resolveGroupGid(groupName: string): number | null {
  const overrideEnv = `SICLAW_${groupName.toUpperCase()}_GROUP`;
  const effective = process.env[overrideEnv] ?? groupName;
  if (groupGidCache.has(effective)) return groupGidCache.get(effective) ?? null;
  let gid: number | null = null;
  try {
    const content = fs.readFileSync("/etc/group", "utf-8");
    for (const line of content.split("\n")) {
      const [name, , gidStr] = line.split(":");
      if (name === effective) {
        const parsed = Number.parseInt(gidStr, 10);
        if (Number.isFinite(parsed)) gid = parsed;
        break;
      }
    }
  } catch {
    gid = null;
  }
  groupGidCache.set(effective, gid);
  return gid;
}

function mergeClusterMeta(prev: ClusterMeta | undefined, response: CredentialResponse): ClusterMeta {
  const inferred = inferClusterMetaFromResponse(response);
  return { ...inferred, ...(prev ?? {}), name: response.credential.name };
}

function mergeHostMeta(prev: HostMeta | undefined, response: CredentialResponse, fallbackName: string): HostMeta {
  const inferred = inferHostMetaFromResponse(response, fallbackName);
  return { ...inferred, ...(prev ?? {}), name: response.credential.name };
}

function inferClusterMetaFromResponse(response: CredentialResponse): ClusterMeta {
  const metadata = (response.credential.metadata ?? {}) as Record<string, unknown>;
  const meta: ClusterMeta = {
    name: response.credential.name,
    is_production: !!(metadata.is_production ?? false),
  };
  if (typeof metadata.description === "string") meta.description = metadata.description;
  if (typeof metadata.api_server === "string") meta.api_server = metadata.api_server;
  if (typeof metadata.debug_image === "string") meta.debug_image = metadata.debug_image;
  if (Array.isArray(metadata.contexts)) meta.contexts = metadata.contexts as ClusterMeta["contexts"];
  if (typeof metadata.current_context === "string") meta.current_context = metadata.current_context;
  if (Array.isArray(metadata.meta)) {
    const entries = (metadata.meta as unknown[]).filter(
      (e): e is ClusterMetaEntry =>
        !!e && typeof e === "object" &&
        typeof (e as ClusterMetaEntry).key === "string" &&
        typeof (e as ClusterMetaEntry).value === "string",
    );
    if (entries.length > 0) meta.meta = entries;
  }
  return meta;
}

function inferHostMetaFromResponse(response: CredentialResponse, fallbackName: string): HostMeta {
  const metadata = (response.credential.metadata ?? {}) as Record<string, unknown>;
  const name = response.credential.name || fallbackName;
  // Fail-fast on missing required metadata. The service contract guarantees
  // these fields; any absence is a bug somewhere upstream and silent defaults
  // would corrupt downstream callers (e.g. classifying a prod host as test).
  const ip = metadata.ip;
  const port = metadata.port;
  const username = metadata.username;
  const authType = metadata.auth_type;
  const isProduction = metadata.is_production;
  if (typeof ip !== "string" || ip.length === 0) {
    throw new Error(`Host "${name}" credential payload missing required metadata.ip`);
  }
  if (typeof port !== "number") {
    throw new Error(`Host "${name}" credential payload missing required metadata.port`);
  }
  if (typeof username !== "string" || username.length === 0) {
    throw new Error(`Host "${name}" credential payload missing required metadata.username`);
  }
  if (authType !== "password" && authType !== "key" && authType !== "managed") {
    throw new Error(`Host "${name}" credential payload metadata.auth_type must be "password", "key", or "managed", got ${JSON.stringify(authType)}`);
  }
  // Managed hosts carry no key/password file (the key is sourced from the
  // bastion at dial time); they require a jump — satisfied by EITHER the
  // server-pre-resolved jump_chain (new protocol) OR metadata.jump_host (legacy
  // name-recursion). See jump-chain design §6.6.
  if (authType === "managed") {
    const hasChain = Array.isArray(response.credential.jump_chain) && response.credential.jump_chain.length > 0;
    const hasJumpName = typeof metadata.jump_host === "string" && metadata.jump_host.length > 0;
    if (!hasChain && !hasJumpName) {
      throw new Error(`Host "${name}" has auth_type="managed" but no jump_chain or metadata.jump_host`);
    }
  }
  if (typeof isProduction !== "boolean") {
    throw new Error(`Host "${name}" credential payload missing required metadata.is_production`);
  }
  return {
    name,
    ip,
    port,
    username,
    auth_type: authType,
    is_production: isProduction,
    ...(typeof metadata.description === "string" ? { description: metadata.description } : {}),
    // Optional: name of the next-hop bastion for a ProxyJump chain. The
    // management server resolves any internal id to the host name before
    // sending; acquireSshTarget recurses on it. Absent for direct hosts.
    ...(typeof metadata.jump_host === "string" && metadata.jump_host.length > 0
      ? { jump_host: metadata.jump_host }
      : {}),
  };
}

function reconstructClusterResponse(cached: ClusterLocalInfo): CredentialResponse {
  if (!cached.filePaths || cached.filePaths.length === 0) {
    throw new Error(`Cache hit for cluster "${cached.meta.name}" has no file paths`);
  }
  const files: CredentialFile[] = cached.filePaths.map((fp) => ({
    name: path.basename(fp).replace(`${cached.meta.name}.`, ""),
    content: fs.readFileSync(fp, "utf-8"),
    mode: 0o640,
  }));
  return {
    credential: {
      name: cached.meta.name,
      type: "kubeconfig",
      files,
      ttl_seconds: cached.expiresAt
        ? Math.max(0, Math.floor((cached.expiresAt - Date.now()) / 1000))
        : 300,
    },
  };
}

function probeErrorText(err: Error, stderr: string | Buffer): string {
  // kubectl/client-go writes the useful API, TLS, auth, and kubeconfig errors to
  // stderr. Keep the complete bounded message; selecting only one line loses the
  // actual Kubernetes failure behind child_process's generic wrapper.
  const kubeError = String(stderr).trim();
  if (kubeError) return kubeError.slice(0, 2000);
  const message = err.message.trim();
  return (message || "kubectl probe failed").slice(0, 2000);
}

/**
 * Map a failed `kubectl version` invocation to a three-state ProbeResult with a
 * structured `reason`. The ORDER of the checks matters — several classes of
 * failure share substrings, and getting the precedence wrong is exactly what
 * makes a caller hallucinate a healthy cluster as "down" (or vice-versa):
 *
 *   1. spawn errors (ENOENT/EACCES)  → kubectl_missing   (local tooling)
 *   2. localhost:8080 refusal        → kubeconfig        (client-go's no-config
 *      fallback host — the REAL API server was never contacted, so this must be
 *      caught BEFORE the generic "connection refused" network rule)
 *   3. other kubeconfig/context errors → kubeconfig      (local config)
 *   4. 401 Unauthorized              → auth (reachable)  (server adjudicated identity)
 *   4b. 403 Forbidden                → authz (reachable) (server adjudicated RBAC)
 *   4c. 404 NotFound                 → endpoint          (an HTTP responder answered,
 *      but a wrong URL/intermediary can too — no reachability claim)
 *   5. x509 / cert validation        → tls_cert          (TCP reached, TLS failed)
 *   6. POSITIVE network-layer evidence → unreachable     (statement about cluster)
 *   7. child killed, no such evidence  → timeout (probe_failed) — our execFile
 *      timeout may have killed a hung LOCAL exec credential plugin before any
 *      request left the machine, so reachability is unknown (NOT unreachable)
 *   8. anything else                 → unknown           (report, don't guess)
 */
export function classifyKubectlProbeError(
  name: string,
  err: Error,
  stderr: string | Buffer = "",
): ProbeResult {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return { name, probe_status: "probe_failed", reason: "kubectl_missing", probe_error: "kubectl executable not found on PATH — local tooling problem, says nothing about the cluster" };
  }
  if (code === "EACCES") {
    return { name, probe_status: "probe_failed", reason: "kubectl_missing", probe_error: "kubectl exists but is not executable — local tooling problem, says nothing about the cluster" };
  }

  const probeError = probeErrorText(err, stderr);
  const text = probeError.toLowerCase();

  // (2)+(3) Local kubeconfig problems. localhost:8080 / 127.0.0.1:8080 is the
  // client-go default when the kubeconfig has no usable server/context, so a
  // refusal there is LOCAL — a real cluster shows its own host:port and falls
  // through to the network rules below. Do NOT key on "did you specify the right
  // host or port" — kubectl appends that to genuine refusals too.
  if (
    /localhost:8080|127\.0\.0\.1:8080/.test(text)
    // kubeconfig / context / authinfo problems that never leave this machine.
    // A local exec/authProvider credential plugin ("getting credentials: exec:
    // <plugin> not found", "no auth provider found") fails BEFORE any request is
    // sent, so it is a kubeconfig problem here — NOT proof the server answered.
    || /no configuration has been provided|invalid configuration|error loading config|unable to (read|load).*config|missing or incomplete configuration|context ".*" does not exist|no such context|no context is currently set|current-context|no auth provider found|getting credentials|exec: executable .* (not found|failed)|exec plugin/.test(text)
  ) {
    return { name, probe_status: "probe_failed", reason: "kubeconfig", probe_error: probeError };
  }

  // (4) 401 Unauthorized: the API server ANSWERED and rejected the identity.
  // The HTTP response is proof the cluster is reachable — reachable:true.
  if (/unauthorized|must be logged in|asked for the client to provide credentials/.test(text)) {
    return { name, probe_status: "probe_failed", reason: "auth", reachable: true, probe_error: probeError };
  }

  // (4b) 403 Forbidden from the server: TCP + TLS + HTTP all succeeded and the
  // API server adjudicated RBAC. A proof-of-reachability response — reachable:true.
  // Distinct from `auth` so callers can tell an identity (401) from an RBAC (403)
  // denial. NotFound is deliberately NOT matched here (see 4c).
  if (/error from server \(forbidden\)|is forbidden: user/.test(text)) {
    return { name, probe_status: "probe_failed", reason: "authz", reachable: true, probe_error: probeError };
  }

  // (4c) 404 NotFound: an HTTP endpoint answered, but that is weaker evidence than
  // a 401/403. A wrong server URL, a stale/misrouted context, or an intermediary
  // (proxy/load balancer) can all return 404 without the Kubernetes API server
  // ever adjudicating the request. Report it as an endpoint/config problem WITHOUT
  // claiming the cluster is up — reachable is omitted.
  if (/error from server \(notfound\)|the server could not find the requested resource/.test(text)) {
    return { name, probe_status: "probe_failed", reason: "endpoint", probe_error: probeError };
  }

  // (5) TLS certificate validation: server reached at TCP but the TLS exchange
  // failed (untrusted/expired/mismatched cert). A trust/config problem, not down.
  // TLS never completed, so we do NOT claim reachable.
  if (/x509|certificate signed by unknown authority|certificate has expired|certificate is valid for|failed to verify certificate|cannot validate certificate/.test(text)) {
    return { name, probe_status: "probe_failed", reason: "tls_cert", probe_error: probeError };
  }

  // (6) Genuine network-layer unreachability — a statement about the cluster.
  // These require POSITIVE evidence in stderr; a killed child alone is NOT enough
  // (see (7)). client-go's own request/handshake timeout is such positive
  // evidence, so it stays here — distinct from our local execFile kill.
  if (/timed out|i\/o timeout|context deadline exceeded|tls handshake timeout|request timeout|deadline exceeded/.test(text)) {
    return { name, probe_status: "unreachable", reachable: false, reason: "timeout", probe_error: probeError };
  }
  if (/no such host|server misbehaving|lookup .* on |name resolution|temporary failure in name resolution/.test(text)) {
    return { name, probe_status: "unreachable", reachable: false, reason: "dns", probe_error: probeError };
  }
  // kubectl's own phrasing is "The connection to the server <host:port> was
  // refused - did you specify the right host or port?" (client-go's ECONNREFUSED
  // wrapper), which does NOT contain the substring "connection refused" — match
  // it explicitly alongside the lower-level go phrasings. The localhost:8080
  // variant of this message was already peeled off as `kubeconfig` above.
  if (/connection refused|actively refused|the connection to the server .* was refused/.test(text)) {
    return { name, probe_status: "unreachable", reachable: false, reason: "connection_refused", probe_error: probeError };
  }
  if (/connection reset|broken pipe|unexpected eof|\beof\b/.test(text)) {
    return { name, probe_status: "unreachable", reachable: false, reason: "connection_reset", probe_error: probeError };
  }
  if (/network is unreachable|no route to host|host is unreachable|unable to connect to the server/.test(text)) {
    return { name, probe_status: "unreachable", reachable: false, reason: "network", probe_error: probeError };
  }

  // (7) The child was killed (our execFile timeout fired) with NO network-layer
  // evidence in stderr. The kill can also hit a hung LOCAL exec credential plugin
  // that never sent a request, so we cannot say the API server was unreachable.
  // Classify as a probe_failed/timeout with UNKNOWN reachability (reachable omitted)
  // — never as `unreachable`, which would let a stuck local plugin masquerade as a
  // down cluster.
  const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
  if (killed) {
    return {
      name,
      probe_status: "probe_failed",
      reason: "timeout",
      probe_error: `${probeError} (the local kubectl probe was killed by our timeout with no network-layer error — reachability unknown)`,
    };
  }

  // (8) kubectl ran but failed for a reason we cannot confidently attribute to
  // the cluster. Report stderr verbatim WITHOUT claiming unreachability.
  return { name, probe_status: "probe_failed", reason: "unknown", probe_error: probeError };
}

export const PROBE_TOTAL_TIMEOUT_MS = 7_000;

/**
 * Bound `operation` to `timeoutMs`. On timeout we resolve promptly with a
 * probe_failed/timeout result AND abort the shared AbortSignal handed to
 * `operation`, so timed-out work cannot continue into kubectl: `operation`
 * checks `signal.aborted` before spawning, and a kubectl child launched with
 * this signal is killed when it fires. The aborted operation settles in the
 * background and its late result is discarded (the guard below is idempotent).
 *
 * Because timed-out work is aborted rather than left running, releasing the
 * concurrency-limiter slot early (in probeClusters) no longer leaks kubectl
 * processes — the bounded fan-out holds.
 *
 * `timeoutMs` is injectable for tests; production callers use the default.
 */
export function withProbeTimeout(
  name: string,
  operation: (signal: AbortSignal) => Promise<ProbeResult>,
  timeoutMs: number = PROBE_TOTAL_TIMEOUT_MS,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish({
        name,
        probe_status: "probe_failed",
        reason: "timeout",
        probe_error: `cluster probe timed out after ${timeoutMs}ms (credential fetch or kubectl probe did not return — cluster reachability unknown)`,
      });
    }, timeoutMs);
    timer.unref?.();
    operation(controller.signal).then(
      (result) => finish(result),
      (err: unknown) => {
        // A rejection caused by our own abort is expected — the timeout result
        // has already been delivered, so finish() is a no-op here.
        finish({
          name,
          probe_status: "probe_failed",
          reason: "unknown",
          probe_error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  });
}

function probeKubeconfig(name: string, kubeconfigPath: string, signal?: AbortSignal): Promise<ProbeResult> {
  return new Promise((resolve) => {
    // Guard: the probe may have already timed out while the kubeconfig was being
    // fetched. Do not spawn kubectl after the abort.
    if (signal?.aborted) {
      resolve({
        name,
        probe_status: "probe_failed",
        reason: "timeout",
        probe_error: "probe timed out before kubectl was spawned; reachability unknown",
      });
      return;
    }
    execFile(
      "kubectl",
      ["version", "--output=json", `--kubeconfig=${kubeconfigPath}`, "--request-timeout=3s"],
      // Pass the abort signal so a still-running kubectl is killed the moment the
      // total-probe timeout fires (Node sends SIGTERM); `timeout` is the local
      // per-invocation ceiling.
      { timeout: 5000, signal },
      (err, stdout, stderr) => {
        if (err) {
          resolve(classifyKubectlProbeError(name, err, stderr));
          return;
        }
        try {
          const info = JSON.parse(stdout);
          const ver = info.serverVersion?.gitVersion ?? "unknown";
          resolve({ name, probe_status: "success", reachable: true, server_version: ver });
        } catch {
          resolve({ name, probe_status: "success", reachable: true, server_version: "unknown" });
        }
      },
    );
  });
}
