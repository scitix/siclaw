/**
 * CredentialService — forwards all credential requests to the adapter API.
 *
 * Runtime delegates to the management server (Portal or Upstream) via
 * config.serverUrl. The management server handles credential storage,
 * decryption, and agent binding validation.
 */

import http from "node:http";
import https from "node:https";
import type { RuntimeConfig } from "./config.js";
import type {
  Identity,
  ClusterMeta,
  HostMeta,
  CredentialPayload,
} from "../shared/credential-types.js";

export class CredentialService {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
  ) {}

  async listClusters(identity: Identity): Promise<ClusterMeta[]> {
    const body = await this.post("/api/internal/siclaw/credential-list", identity, { kind: "cluster" });
    const parsed = JSON.parse(body) as { clusters?: ClusterMeta[] };
    if (!Array.isArray(parsed.clusters)) {
      throw new Error("Adapter credential-list returned malformed cluster list response");
    }
    return parsed.clusters;
  }

  async listHosts(identity: Identity): Promise<HostMeta[]> {
    const body = await this.post("/api/internal/siclaw/credential-list", identity, { kind: "host" });
    const parsed = JSON.parse(body) as { hosts?: HostMeta[] };
    if (!Array.isArray(parsed.hosts)) {
      throw new Error("Adapter credential-list returned malformed host list response");
    }
    return parsed.hosts;
  }

  async getClusterCredential(identity: Identity, clusterName: string, purpose: string): Promise<CredentialPayload> {
    const body = await this.post("/api/internal/siclaw/credential-request", identity, {
      source: "cluster", source_id: clusterName, purpose,
    });
    return JSON.parse(body) as CredentialPayload;
  }

  async getHostCredential(identity: Identity, hostName: string, purpose: string): Promise<CredentialPayload> {
    const body = await this.post("/api/internal/siclaw/credential-request", identity, {
      source: "host", source_id: hostName, purpose,
    });
    return JSON.parse(body) as CredentialPayload;
  }

  private post(path: string, identity: Identity, jsonBody: unknown): Promise<string> {
    const url = new URL(this.serverUrl.replace(/\/$/, "") + path);
    const transport = url.protocol === "https:" ? https : http;
    const data = JSON.stringify(jsonBody);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data).toString(),
      "X-Auth-Token": this.token,
      "X-Cert-User-Id": identity.userId,
      "X-Cert-Agent-Id": identity.agentId,
      "X-Cert-Org-Id": identity.orgId ?? "",
      "X-Cert-Box-Id": identity.boxId ?? "",
    };

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
              reject(new Error(`Adapter ${path} returned ${status}: ${buf}`));
              return;
            }
            resolve(buf);
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("Adapter credential request timeout")));
      req.write(data);
      req.end();
    });
  }
}

export class CredentialNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "CredentialNotFoundError"; }
}

export function createCredentialService(config: RuntimeConfig): CredentialService {
  if (!config.serverUrl) {
    throw new Error("[credential-service] SICLAW_SERVER_URL is required");
  }
  console.log(`[credential-service] backend: adapter (${config.serverUrl})`);
  return new CredentialService(config.serverUrl, config.portalSecret);
}
