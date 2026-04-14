/**
 * CredentialTransport — abstracts the channel AgentBox uses to reach the
 * gateway-side CredentialService.
 *
 * Two implementations:
 *   - HttpMtlsTransport:  K8s mode. Calls the gateway's mTLS HTTP endpoints
 *     (/api/internal/credential-{list,request}). Identity is carried by the
 *     client certificate and cannot be spoofed by the caller.
 *   - DirectCallTransport: Local mode. Holds an in-process reference to the
 *     CredentialService and an Identity injected by LocalSpawner. Used when
 *     AgentBox runs inside the same process as the gateway.
 *
 * The CredentialBroker is transport-agnostic; everything K8s- or local-specific
 * is hidden behind this interface.
 */

import type { GatewayClient } from "./gateway-client.js";
import type {
  ClusterMeta,
  CredentialPayload,
  CredentialService,
  Identity,
} from "../shared/credential-types.js";

export type { ClusterMeta, CredentialPayload };

export interface CredentialTransport {
  listClusters(): Promise<ClusterMeta[]>;
  getClusterCredential(name: string, purpose: string): Promise<CredentialPayload>;
}

// ---------------------------------------------------------------------------
// HTTP / mTLS transport (K8s mode)
// ---------------------------------------------------------------------------

interface GatewayClientLike {
  request(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown>;
}

export class HttpMtlsTransport implements CredentialTransport {
  private readonly client: GatewayClientLike;

  constructor(gateway: GatewayClient | GatewayClientLike) {
    this.client = "toClientLike" in gateway ? gateway.toClientLike() : gateway;
  }

  async listClusters(): Promise<ClusterMeta[]> {
    const res = await this.client.request("/api/internal/credential-list", "POST", {}) as {
      clusters?: ClusterMeta[];
    };
    if (!Array.isArray(res.clusters)) {
      throw new Error("Gateway returned malformed credential-list response");
    }
    return res.clusters;
  }

  async getClusterCredential(name: string, purpose: string): Promise<CredentialPayload> {
    const res = await this.client.request(
      "/api/internal/credential-request",
      "POST",
      { source: "cluster", source_id: name, purpose },
    ) as CredentialPayload;
    return res;
  }
}

// ---------------------------------------------------------------------------
// Direct in-process transport (Local mode)
// ---------------------------------------------------------------------------

export class DirectCallTransport implements CredentialTransport {
  constructor(
    private readonly service: CredentialService,
    private readonly identity: Identity,
  ) {}

  listClusters(): Promise<ClusterMeta[]> {
    return this.service.listClusters(this.identity);
  }

  getClusterCredential(name: string, purpose: string): Promise<CredentialPayload> {
    return this.service.getClusterCredential(this.identity, name, purpose);
  }
}
