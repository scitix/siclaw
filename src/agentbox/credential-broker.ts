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
import type {
  CredentialTransport,
  ClusterMeta,
  HostMeta,
  CredentialPayload,
} from "./credential-transport.js";

export type { ClusterMeta, HostMeta, CredentialPayload };

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
  /** All materialized file paths tied to this credential; unlinked on evict. */
  filePaths?: string[];
  /** When the cached credential expires; undefined if metadata-only. */
  expiresAt?: number;
}

export type ClusterLocalInfo = LocalInfo<ClusterMeta>;
export type HostLocalInfo = LocalInfo<HostMeta>;

export interface ProbeResult {
  name: string;
  reachable: boolean;
  server_version?: string;
  probe_error?: string;
}

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
      this.unlinkFiles(entry.filePaths);
      this.map.delete(name);
    }

    // Upsert, preserving prior path/expiry for existing entries.
    for (const meta of metas) {
      const existing = this.map.get(meta.name);
      this.map.set(meta.name, {
        meta,
        path: existing?.path,
        filePaths: existing?.filePaths,
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
      expiresAt: existing?.expiresAt,
    });
  }

  /**
   * Atomically write all `files` under `<credentialsDir>/<subdir>/<name>.<file>`.
   * Returns the list of written file paths. Does NOT compute a "main" path;
   * callers decide which file is primary (cluster picks `.kubeconfig`).
   */
  setMaterialized(name: string, meta: TMeta, files: CredentialFile[], ttlMs: number): string[] {
    // Sanitize the credential name before it becomes part of a file path.
    // path.basename alone is not enough — ".." or slashes inside would still
    // land in <dir>/<..>.xxx. Strip anything that isn't a safe name char.
    const safeName = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
    if (!safeName || safeName === "." || safeName === "..") {
      console.warn(`[credential-broker] unsafe credential name blocked: "${name}"`);
      return [];
    }

    const sharedGid = this.opts.sharedGroup
      ? resolveGroupGid(this.opts.sharedGroup)
      : null;
    const desiredMode = sharedGid !== null ? this.opts.fileMode : 0o600;
    const paths: string[] = [];

    for (const file of files) {
      const safeFile = path.basename(file.name);
      const filePath = path.join(this.subdirAbs, `${safeName}.${safeFile}`);
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

    const existing = this.map.get(name);
    this.map.set(name, {
      meta,
      path: existing?.path, // caller may overwrite via setMainPath
      filePaths: paths,
      expiresAt: Date.now() + ttlMs,
    });
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
      this.unlinkFiles(entry.filePaths);
      this.map.set(key, {
        meta: entry.meta,
        path: undefined,
        filePaths: undefined,
        expiresAt: undefined,
      });
    }
  }

  dispose(): void {
    for (const entry of this.map.values()) {
      this.unlinkFiles(entry.filePaths);
    }
    this.map.clear();
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
   * Triggers acquireCluster if missing or expired. Used by the central
   * ensureKubeconfigsForCommand helper before a synchronous resolve.
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
   * Force a cache-bypassing acquire and probe the cluster connectivity with
   * `kubectl version`. Used by the cluster_probe tool.
   */
  async probeCluster(clusterName: string): Promise<ProbeResult> {
    try {
      await this.acquireCluster(clusterName, "cluster_probe", { bypassCache: true });
    } catch (err) {
      return {
        name: clusterName,
        reachable: false,
        probe_error: err instanceof Error ? err.message : String(err),
      };
    }
    const info = this.clusters.get(clusterName);
    if (!info?.path) {
      return {
        name: clusterName,
        reachable: false,
        probe_error: "kubeconfig path missing after acquire",
      };
    }
    return probeKubeconfig(clusterName, info.path);
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

  /** true once refreshHosts() has succeeded at least once. */
  isHostsReady(): boolean {
    return this.hostsInitialized;
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
    const filePaths = this.hosts.setMaterialized(response.credential.name, meta, response.credential.files, ttlMs);
    // Host has no "main path" concept (no sync consumer). filePaths are enough.

    console.log(
      `[credential-broker] acquired host "${response.credential.name}" ` +
      `(ttl=${ttlMs / 1000}s, files=${filePaths.length})`,
    );
    return response;
  }

  /**
   * Ensure a host has been acquired at least once and its files exist on disk.
   * Triggers acquireHost if missing or expired.
   */
  async ensureHost(hostName: string, purpose = "ensure"): Promise<HostLocalInfo> {
    const existing = this.hosts.get(hostName);
    const fresh = existing?.expiresAt !== undefined
      && existing.expiresAt > Date.now()
      && (existing.filePaths?.every((fp) => fs.existsSync(fp)) ?? false);
    if (existing && fresh) return existing;
    await this.acquireHost(hostName, purpose);
    const refreshed = this.hosts.get(hostName);
    if (!refreshed?.filePaths || refreshed.filePaths.length === 0) {
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
  if (authType !== "password" && authType !== "key") {
    throw new Error(`Host "${name}" credential payload metadata.auth_type must be "password" or "key", got ${JSON.stringify(authType)}`);
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

function probeKubeconfig(name: string, kubeconfigPath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(
      "kubectl",
      ["version", "--output=json", `--kubeconfig=${kubeconfigPath}`, "--request-timeout=3s"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          const msg = err.message?.includes("timed out")
            ? "connection timeout"
            : err.message?.split("\n")[0] ?? "unknown error";
          resolve({ name, reachable: false, probe_error: msg });
          return;
        }
        try {
          const info = JSON.parse(stdout);
          const ver = info.serverVersion?.gitVersion ?? "unknown";
          resolve({ name, reachable: true, server_version: ver });
        } catch {
          resolve({ name, reachable: true, server_version: "unknown" });
        }
      },
    );
  });
}
