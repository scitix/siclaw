/**
 * CredentialBroker — AgentBox-side cache + local materialization for cluster
 * credentials. Sits between tools and the gateway's CredentialService.
 *
 * Responsibilities:
 *   1. list()    — fetch all clusters bound to this agent and populate the
 *                  in-memory registry with metadata.
 *   2. acquire() — fetch a single cluster's kubeconfig, atomically write it
 *                  to disk, and record the file path in the registry.
 *   3. ensure()  — async entry point used by cmd-exec tools. Guarantees that
 *                  a cluster has been acquired (triggers acquire() if missing).
 *   4. probe()   — bypass the cache, force a fresh acquire, and run
 *                  `kubectl version` for a connectivity check.
 *   5. getLocalInfo() / listLocalInfo() — synchronous readers used by
 *                  kubeconfig-resolver. They MUST return populated entries
 *                  only; callers that read before ensure() will see undefined.
 *
 * The registry is a plain Map. The broker is a per-AgentBox singleton, so
 * the map is scoped to one session/user; no cross-user leakage.
 *
 * IMPORTANT: when a cached credential TTL expires we unlink the file on disk
 * and clear the `path` in the registry, but we keep the metadata. That way
 * list-style readers still see the cluster; a subsequent acquire will
 * refresh the path without losing contextual info.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  CredentialTransport,
  ClusterMeta,
  CredentialPayload,
} from "./credential-transport.js";

export type { ClusterMeta, CredentialPayload };

export interface CredentialFile {
  name: string;
  content: string;
  mode?: number;
}

export interface CredentialResponse extends CredentialPayload {}

export interface ClusterLocalInfo extends ClusterMeta {
  /** Absolute path to the materialized kubeconfig (undefined if not acquired). */
  path?: string;
  /** File paths tied to this credential; cleaned on evict. */
  filePaths?: string[];
  /** When the cached credential expires; undefined if metadata-only. */
  expiresAt?: number;
}

export interface ProbeResult {
  name: string;
  reachable: boolean;
  server_version?: string;
  probe_error?: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class CredentialBroker {
  private readonly registry = new Map<string, ClusterLocalInfo>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly credentialsDir: string;

  constructor(
    private readonly transport: CredentialTransport,
    credentialsDir?: string,
  ) {
    this.credentialsDir = credentialsDir || path.resolve(process.cwd(), ".siclaw/credentials");
    fs.mkdirSync(this.credentialsDir, { recursive: true });
    this.cleanupTimer = setInterval(() => this.evictExpired(), 60_000);
  }

  // ──────────────────────────────────────────────────────────
  // Async API
  // ──────────────────────────────────────────────────────────

  /**
   * Fetch metadata for all clusters bound to this agent and sync the registry
   * authoritatively: upsert anything the gateway still returns, and drop
   * anything it no longer does (so unbinding a cluster in the Portal
   * disappears from cluster_list on the next call). Dropped entries have
   * their materialized files unlinked. Does NOT eagerly acquire kubeconfigs.
   */
  async list(): Promise<ClusterMeta[]> {
    const clusters = await this.transport.listClusters();
    const keep = new Set(clusters.map((c) => c.name));

    // Drop anything the gateway no longer lists.
    for (const [name, entry] of this.registry) {
      if (keep.has(name)) continue;
      if (entry.filePaths) {
        for (const fp of entry.filePaths) {
          try { fs.unlinkSync(fp); } catch { /* already gone */ }
        }
      }
      this.registry.delete(name);
    }

    // Upsert the current set, preserving already-acquired paths.
    for (const meta of clusters) {
      const existing = this.registry.get(meta.name);
      this.registry.set(meta.name, {
        ...meta,
        path: existing?.path,
        filePaths: existing?.filePaths,
        expiresAt: existing?.expiresAt,
      });
    }
    return clusters;
  }

  /**
   * Fetch a single cluster's kubeconfig and materialize it to disk.
   * Returns cached entry if still valid (unless bypassCache).
   */
  async acquire(
    source: "cluster",
    sourceId: string,
    purpose: string,
    options: { bypassCache?: boolean } = {},
  ): Promise<CredentialResponse> {
    if (source !== "cluster") {
      throw new Error(`Only "cluster" source is supported; got "${source}"`);
    }

    const cached = this.registry.get(sourceId);
    if (
      !options.bypassCache &&
      cached?.path &&
      cached.expiresAt !== undefined &&
      cached.expiresAt > Date.now()
    ) {
      return this.reconstructResponse(cached);
    }

    const response = await this.transport.getClusterCredential(sourceId, purpose);
    const filePaths = this.materializeFiles(response.credential.name, response.credential.files);
    const mainKubeconfig = filePaths.find((p) => p.endsWith(".kubeconfig")) ?? filePaths[0];

    // Preserve metadata from a prior list() call (description, contexts, etc.)
    // that an acquire-shaped response may not carry.
    const fromResponse = inferMetaFromResponse(response);
    const ttlMs = (response.credential.ttl_seconds ?? 300) * 1000;
    this.registry.set(response.credential.name, {
      ...fromResponse,
      ...(cached ?? {}),
      name: response.credential.name,
      path: mainKubeconfig,
      filePaths,
      expiresAt: Date.now() + ttlMs,
    });

    console.log(
      `[credential-broker] acquired "${response.credential.name}" ` +
      `(ttl=${ttlMs / 1000}s, files=${filePaths.length})`,
    );

    return response;
  }

  /**
   * Ensure a cluster has been acquired at least once (path available).
   * Triggers acquire() if missing or expired. Called by the central
   * ensureKubeconfigsForCommand helper before a synchronous resolve.
   */
  async ensure(clusterName: string, purpose = "ensure"): Promise<ClusterLocalInfo> {
    const existing = this.registry.get(clusterName);
    if (
      existing?.path &&
      existing.expiresAt !== undefined &&
      existing.expiresAt > Date.now() &&
      fs.existsSync(existing.path)
    ) {
      return existing;
    }
    await this.acquire("cluster", clusterName, purpose);
    const refreshed = this.registry.get(clusterName);
    if (!refreshed?.path) {
      throw new Error(`Broker.ensure(${clusterName}) completed but path is missing`);
    }
    return refreshed;
  }

  /**
   * Force a cache-bypassing acquire and probe the cluster connectivity with
   * `kubectl version`. Used by the cluster_probe tool.
   */
  async probe(clusterName: string): Promise<ProbeResult> {
    try {
      await this.acquire("cluster", clusterName, "cluster_probe", { bypassCache: true });
    } catch (err) {
      return {
        name: clusterName,
        reachable: false,
        probe_error: err instanceof Error ? err.message : String(err),
      };
    }
    const info = this.registry.get(clusterName);
    if (!info?.path) {
      return {
        name: clusterName,
        reachable: false,
        probe_error: "kubeconfig path missing after acquire",
      };
    }
    return probeKubeconfig(clusterName, info.path);
  }

  // ──────────────────────────────────────────────────────────
  // Sync API (for kubeconfig-resolver)
  // ──────────────────────────────────────────────────────────

  getLocalInfo(clusterName: string): ClusterLocalInfo | undefined {
    return this.registry.get(clusterName);
  }

  listLocalInfo(): ClusterLocalInfo[] {
    return Array.from(this.registry.values());
  }

  // ──────────────────────────────────────────────────────────
  // Housekeeping
  // ──────────────────────────────────────────────────────────

  /** Remove expired file paths from the registry and disk. Metadata is kept. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.registry) {
      if (!entry.expiresAt || entry.expiresAt > now) continue;
      if (entry.filePaths) {
        for (const fp of entry.filePaths) {
          try { fs.unlinkSync(fp); } catch { /* already gone */ }
        }
      }
      this.registry.set(key, {
        ...entry,
        path: undefined,
        filePaths: undefined,
        expiresAt: undefined,
      });
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    for (const entry of this.registry.values()) {
      if (entry.filePaths) {
        for (const fp of entry.filePaths) {
          try { fs.unlinkSync(fp); } catch { /* best-effort */ }
        }
      }
    }
    this.registry.clear();
  }

  // ──────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────

  private materializeFiles(credentialName: string, files: CredentialFile[]): string[] {
    // Sanitize the credential name before it becomes part of a file path.
    // `path.basename` alone is not enough — ".." or slashes inside would still
    // land in `<dir>/<..>.xxx`. Strip anything that isn't a safe name char.
    const safeName = path.basename(credentialName).replace(/[^A-Za-z0-9._-]/g, "_");
    if (!safeName || safeName === "." || safeName === "..") {
      console.warn(`[credential-broker] unsafe credential name blocked: "${credentialName}"`);
      return [];
    }
    const sharedGid = resolveSharedGroupGid();
    const paths: string[] = [];
    for (const file of files) {
      const safeFile = path.basename(file.name);
      const filePath = path.join(this.credentialsDir, `${safeName}.${safeFile}`);
      // Defense-in-depth: ensure the resolved path is still under credentialsDir.
      const rel = path.relative(this.credentialsDir, filePath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        console.warn(`[credential-broker] path traversal blocked: ${filePath}`);
        continue;
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmpPath = filePath + ".new";
      // In K8s mode the AgentBox runs as `agentbox` (uid 1000) and kubectl runs
      // as `sandbox` (uid 1001) with setgid `kubecred`. For kubectl to read the
      // kubeconfig we must give the kubecred group read access. The Dockerfile
      // already sets the credentials dir to group kubecred with mode 0750, but
      // newly-created files default to the creator's primary group (agentbox),
      // so we explicitly chgrp to kubecred and use mode 0640.
      const desiredMode = sharedGid !== null ? 0o640 : (file.mode ?? 0o600);
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

  private reconstructResponse(cached: ClusterLocalInfo): CredentialResponse {
    if (!cached.filePaths || cached.filePaths.length === 0) {
      throw new Error(`Cache hit for "${cached.name}" has no file paths`);
    }
    const files: CredentialFile[] = cached.filePaths.map((fp) => ({
      name: path.basename(fp),
      content: fs.readFileSync(fp, "utf-8"),
      mode: 0o600,
    }));
    return {
      credential: {
        name: cached.name,
        type: "kubeconfig",
        files,
        ttl_seconds: cached.expiresAt ? Math.max(0, Math.floor((cached.expiresAt - Date.now()) / 1000)) : 300,
      },
    };
  }
}

/**
 * Resolve the numeric gid of the shared credential group (`kubecred` by
 * default). kubectl is setgid'd to this group in Dockerfile.agentbox so that
 * the sandbox uid can read credential files via group permission. Returns
 * null in environments where the group doesn't exist (Local mode, TUI).
 *
 * Result is cached across calls — /etc/group is read at most once per group.
 */
const groupGidCache = new Map<string, number | null>();

function resolveSharedGroupGid(): number | null {
  const groupName = process.env.SICLAW_CREDENTIAL_GROUP || "kubecred";
  if (groupGidCache.has(groupName)) return groupGidCache.get(groupName) ?? null;
  let gid: number | null = null;
  try {
    const content = fs.readFileSync("/etc/group", "utf-8");
    for (const line of content.split("\n")) {
      const [name, , gidStr] = line.split(":");
      if (name === groupName) {
        const parsed = Number.parseInt(gidStr, 10);
        if (Number.isFinite(parsed)) gid = parsed;
        break;
      }
    }
  } catch {
    gid = null;
  }
  groupGidCache.set(groupName, gid);
  return gid;
}

function inferMetaFromResponse(response: CredentialResponse): ClusterMeta {
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
