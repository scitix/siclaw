/**
 * Credential Broker — on-demand credential acquisition for AgentBox tools.
 *
 * Flow (integration spec §5.4):
 *   Tool needs credential (e.g., kubectl needs kubeconfig)
 *   → broker.acquire("cluster", "c-001", "kubectl get nodes")
 *     → mTLS POST to Runtime /api/internal/credential-request
 *       → Runtime forwards to Upstream Adapter (with cert identity)
 *         → RBAC check → decrypt → audit → return
 *     → Write credential files to disk
 *     → Cache in memory (TTL-based)
 *   → Tool uses credential files
 *   → TTL expires → files cleaned up
 *
 * Identity is embedded in the mTLS certificate (cannot be spoofed).
 * The broker only controls WHAT to request (source, source_id, purpose).
 */

import fs from "node:fs";
import path from "node:path";
import type { GatewayClient } from "./gateway-client.js";

export interface CredentialFile {
  name: string;
  content: string;
  mode?: number;
}

export interface CredentialResponse {
  credential: {
    name: string;
    type: string;
    files: CredentialFile[];
    metadata?: Record<string, unknown>;
    ttl_seconds?: number;
  };
  audit_id?: string;
}

interface CachedCredential {
  response: CredentialResponse;
  filePaths: string[];
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class CredentialBroker {
  private cache = new Map<string, CachedCredential>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private credentialsDir: string;

  constructor(
    private client: GatewayClient,
    credentialsDir?: string,
  ) {
    this.credentialsDir = credentialsDir || path.resolve(process.cwd(), ".siclaw/credentials");
    fs.mkdirSync(this.credentialsDir, { recursive: true });

    // Periodic cleanup of expired credentials
    this.cleanupTimer = setInterval(() => this.evictExpired(), 60_000);
  }

  /**
   * Acquire a credential. Returns cached version if still valid,
   * otherwise fetches from Runtime → Upstream Adapter.
   */
  async acquire(
    source: "cluster" | "host" | "credential",
    sourceId: string,
    purpose: string,
  ): Promise<CredentialResponse> {
    const cacheKey = `${source}:${sourceId}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.response;
    }

    // Fetch from Runtime (which proxies to Upstream Adapter)
    const response = await this.client.toClientLike().request(
      "/api/internal/credential-request",
      "POST",
      { source, source_id: sourceId, purpose },
    ) as CredentialResponse;

    // Write credential files to disk
    const filePaths = this.materializeFiles(response.credential.name, response.credential.files);

    // Cache with TTL
    const ttlMs = (response.credential.ttl_seconds ?? 300) * 1000;
    this.cache.set(cacheKey, {
      response,
      filePaths,
      expiresAt: Date.now() + ttlMs,
    });

    console.log(`[credential-broker] Acquired credential "${response.credential.name}" (type=${response.credential.type}, ttl=${ttlMs / 1000}s, files=${filePaths.length})`);

    return response;
  }

  /**
   * Get the path where a credential file was written.
   * Returns undefined if the credential hasn't been acquired.
   */
  getFilePath(credentialName: string, fileName: string): string {
    return path.join(this.credentialsDir, `${credentialName}.${fileName}`);
  }

  /** Write credential files to disk atomically (.new → rename). */
  private materializeFiles(credentialName: string, files: CredentialFile[]): string[] {
    const paths: string[] = [];
    for (const file of files) {
      const filePath = path.join(this.credentialsDir, file.name);
      const dir = path.dirname(filePath);
      if (!dir.startsWith(this.credentialsDir)) {
        console.warn(`[credential-broker] Path traversal blocked: ${filePath}`);
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = filePath + ".new";
      fs.writeFileSync(tmpPath, file.content, { mode: file.mode ?? 0o600 });
      fs.renameSync(tmpPath, filePath);
      paths.push(filePath);
    }
    return paths;
  }

  /** Remove expired credentials from cache and disk. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, cached] of this.cache) {
      if (cached.expiresAt <= now) {
        for (const fp of cached.filePaths) {
          try { fs.unlinkSync(fp); } catch { /* already gone */ }
        }
        this.cache.delete(key);
      }
    }
  }

  /** Clean up all credentials and stop the cleanup timer. */
  dispose(): void {
    clearInterval(this.cleanupTimer);
    for (const cached of this.cache.values()) {
      for (const fp of cached.filePaths) {
        try { fs.unlinkSync(fp); } catch { /* best-effort */ }
      }
    }
    this.cache.clear();
  }
}
