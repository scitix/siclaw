/**
 * CredentialService — gateway-side authoritative layer for cluster credentials.
 *
 * Two implementations, chosen by config at startup:
 *   - LocalDbCredentialService:  queries clusters + agent_clusters in the gateway DB
 *   - ExternalCredentialService: forwards to a third-party credential provider
 *
 * The HTTP proxy (credential-proxy.ts) and the in-process DirectCallTransport
 * used by LocalSpawner both delegate here. All queries are scoped to an
 * Identity (userId + agentId) — the service never returns data across agents.
 */

import http from "node:http";
import https from "node:https";
import yaml from "js-yaml";
import type { RuntimeConfig } from "./config.js";
import {
  listClustersForAgent,
  getClusterByNameForAgent,
} from "./clusters-dao.js";
import type {
  Identity,
  ClusterMeta,
  CredentialPayload,
  CredentialService,
} from "../shared/credential-types.js";

export type { Identity, ClusterMeta, CredentialPayload, CredentialService } from "../shared/credential-types.js";

// ---------------------------------------------------------------------------
// Local DB implementation
// ---------------------------------------------------------------------------

export class LocalDbCredentialService implements CredentialService {
  async listClusters(identity: Identity): Promise<ClusterMeta[]> {
    // One query fetches metadata + kubeconfig; we parse contexts in-process.
    // We never return kubeconfig to the caller — it stays within this layer.
    const rows = await listClustersForAgent(identity.agentId);
    return rows.map((r) => {
      const parsed = r.kubeconfig ? parseKubeconfigMeta(r.kubeconfig) : {};
      const meta: ClusterMeta = {
        name: r.name,
        is_production: !!r.is_production,
        ...(r.description ? { description: r.description } : {}),
        ...(r.api_server ? { api_server: r.api_server } : {}),
        ...(r.debug_image ? { debug_image: r.debug_image } : {}),
        ...parsed,
      };
      return meta;
    });
  }

  async getClusterCredential(
    identity: Identity,
    clusterName: string,
    _purpose: string,
  ): Promise<CredentialPayload> {
    const row = await getClusterByNameForAgent(identity.agentId, clusterName);
    if (!row) {
      throw new CredentialNotFoundError(
        `Cluster "${clusterName}" not found or agent ${identity.agentId} is not bound to it`,
      );
    }
    if (!row.kubeconfig) {
      throw new Error(`Cluster "${clusterName}" has no kubeconfig stored`);
    }
    return {
      credential: {
        name: row.name,
        type: "kubeconfig",
        files: [{ name: `${row.name}.kubeconfig`, content: row.kubeconfig, mode: 0o600 }],
        metadata: {
          ...(row.api_server ? { api_server: row.api_server } : {}),
          ...(row.debug_image ? { debug_image: row.debug_image } : {}),
          ...parseKubeconfigMeta(row.kubeconfig),
        },
        ttl_seconds: 300,
      },
    };
  }
}

function parseKubeconfigMeta(kubeconfigYaml: string): Partial<ClusterMeta> {
  const kc = yaml.load(kubeconfigYaml) as Record<string, unknown> | null;
  if (!kc || typeof kc !== "object") return {};
  const rawContexts = (kc.contexts as Array<{ name: string; context?: { cluster?: string; namespace?: string } }>) ?? [];
  const contexts = rawContexts.map((c) => ({
    name: c.name,
    ...(c.context?.cluster ? { cluster: c.context.cluster } : {}),
    ...(c.context?.namespace ? { namespace: c.context.namespace } : {}),
  }));
  const current = kc["current-context"] as string | undefined;
  return {
    ...(contexts.length > 0 ? { contexts } : {}),
    ...(current ? { current_context: current } : {}),
  };
}

// ---------------------------------------------------------------------------
// External provider implementation
// ---------------------------------------------------------------------------

/**
 * Forwards credential requests to a configured external provider.
 *
 * Expected provider contract:
 *   POST {baseUrl}/credential-list
 *        headers: X-Auth-Token, X-Cert-User-Id, X-Cert-Agent-Id, ...
 *        body:    {}
 *        200:     { clusters: ClusterMeta[] }
 *   POST {baseUrl}/credential-request
 *        headers: X-Auth-Token, X-Cert-User-Id, X-Cert-Agent-Id, ...
 *        body:    { source: "cluster", source_id: <name>, purpose: <string> }
 *        200:     CredentialPayload
 *
 * Fail-fast: if the provider returns non-2xx, we throw — no local fallback.
 */
export class ExternalCredentialService implements CredentialService {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async listClusters(identity: Identity): Promise<ClusterMeta[]> {
    const body = await this.post("/credential-list", identity, {});
    const parsed = JSON.parse(body) as { clusters?: ClusterMeta[] };
    if (!Array.isArray(parsed.clusters)) {
      throw new Error("External credential provider returned malformed list response");
    }
    return parsed.clusters;
  }

  async getClusterCredential(
    identity: Identity,
    clusterName: string,
    purpose: string,
  ): Promise<CredentialPayload> {
    const body = await this.post("/credential-request", identity, {
      source: "cluster",
      source_id: clusterName,
      purpose,
    });
    return JSON.parse(body) as CredentialPayload;
  }

  private post(path: string, identity: Identity, jsonBody: unknown): Promise<string> {
    const url = new URL(this.baseUrl.replace(/\/$/, "") + path);
    const transport = url.protocol === "https:" ? https : http;
    const data = JSON.stringify(jsonBody);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data).toString(),
      "X-Cert-User-Id": identity.userId,
      "X-Cert-Agent-Id": identity.agentId,
      "X-Cert-Org-Id": identity.orgId ?? "",
      "X-Cert-Box-Id": identity.boxId ?? "",
    };
    if (this.token) headers["X-Auth-Token"] = this.token;

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + url.search,
          method: "POST",
          headers,
          timeout: 10_000,
        },
        (res) => {
          let buf = "";
          res.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
          res.on("end", () => {
            const status = res.statusCode ?? 502;
            if (status < 200 || status >= 300) {
              reject(new Error(`External credential provider ${path} returned ${status}: ${buf}`));
              return;
            }
            resolve(buf);
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("External credential provider timeout")));
      req.write(data);
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCredentialService(config: RuntimeConfig): CredentialService {
  if (config.externalCredentialUrl) {
    console.log(`[credential-service] backend: external (${config.externalCredentialUrl})`);
    return new ExternalCredentialService(
      config.externalCredentialUrl,
      config.externalCredentialToken,
    );
  }
  console.log("[credential-service] backend: local-db");
  return new LocalDbCredentialService();
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CredentialNotFoundError extends Error {
  readonly code = "CREDENTIAL_NOT_FOUND";
}
