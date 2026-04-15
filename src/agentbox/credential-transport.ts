/**
 * CredentialTransport — HTTP transport for AgentBox to reach the
 * gateway's credential endpoints.
 *
 * Single implementation used by both K8s and Local mode. In K8s mode
 * the GatewayClient uses mTLS; in Local mode it uses plain HTTPS with
 * a locally-issued certificate. The CredentialBroker is transport-agnostic.
 */

import type { GatewayClient } from "./gateway-client.js";
import type {
  ClusterMeta,
  HostMeta,
  CredentialPayload,
} from "../shared/credential-types.js";

export type { ClusterMeta, HostMeta, CredentialPayload };

export interface CredentialTransport {
  listClusters(): Promise<ClusterMeta[]>;
  listHosts(): Promise<HostMeta[]>;
  getClusterCredential(name: string, purpose: string): Promise<CredentialPayload>;
  getHostCredential(name: string, purpose: string): Promise<CredentialPayload>;
}

interface GatewayClientLike {
  request(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown>;
}

export class HttpTransport implements CredentialTransport {
  private readonly client: GatewayClientLike;

  constructor(gateway: GatewayClient | GatewayClientLike) {
    this.client = "toClientLike" in gateway ? gateway.toClientLike() : gateway;
  }

  async listClusters(): Promise<ClusterMeta[]> {
    const res = await this.client.request(
      "/api/internal/credential-list",
      "POST",
      { kind: "cluster" },
    ) as { clusters?: ClusterMeta[] };
    if (!Array.isArray(res.clusters)) {
      throw new Error("Gateway returned malformed credential-list (cluster) response");
    }
    return res.clusters;
  }

  async listHosts(): Promise<HostMeta[]> {
    const res = await this.client.request(
      "/api/internal/credential-list",
      "POST",
      { kind: "host" },
    ) as { hosts?: HostMeta[] };
    if (!Array.isArray(res.hosts)) {
      throw new Error("Gateway returned malformed credential-list (host) response");
    }
    return res.hosts;
  }

  async getClusterCredential(name: string, purpose: string): Promise<CredentialPayload> {
    return this.client.request(
      "/api/internal/credential-request",
      "POST",
      { source: "cluster", source_id: name, purpose },
    ) as Promise<CredentialPayload>;
  }

  async getHostCredential(name: string, purpose: string): Promise<CredentialPayload> {
    return this.client.request(
      "/api/internal/credential-request",
      "POST",
      { source: "host", source_id: name, purpose },
    ) as Promise<CredentialPayload>;
  }
}
