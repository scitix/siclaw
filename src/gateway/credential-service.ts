/**
 * CredentialService — forwards all credential requests via FrontendWsClient RPC.
 *
 * Runtime delegates to the management server (Portal or Upstream) via
 * persistent WebSocket RPC. The management server handles credential storage,
 * decryption, and agent binding validation.
 */

import type { FrontendWsClient } from "./frontend-ws-client.js";
import type {
  Identity,
  ClusterMeta,
  HostMeta,
  CredentialPayload,
} from "../shared/credential-types.js";

export class CredentialService {
  constructor(
    private readonly frontendClient: FrontendWsClient,
  ) {}

  async listClusters(identity: Identity): Promise<ClusterMeta[]> {
    const data = await this.frontendClient.request("credential.list", {
      kind: "cluster",
      userId: identity.userId,
      agentId: identity.agentId,
      orgId: identity.orgId ?? "",
      boxId: identity.boxId ?? "",
    }) as { clusters?: ClusterMeta[] };
    if (!Array.isArray(data.clusters)) {
      throw new Error("Adapter credential-list returned malformed cluster list response");
    }
    return data.clusters;
  }

  async listHosts(identity: Identity): Promise<HostMeta[]> {
    const data = await this.frontendClient.request("credential.list", {
      kind: "host",
      userId: identity.userId,
      agentId: identity.agentId,
      orgId: identity.orgId ?? "",
      boxId: identity.boxId ?? "",
    }) as { hosts?: HostMeta[] };
    if (!Array.isArray(data.hosts)) {
      throw new Error("Adapter credential-list returned malformed host list response");
    }
    return data.hosts;
  }

  async getClusterCredential(identity: Identity, clusterName: string, purpose: string): Promise<CredentialPayload> {
    return this.frontendClient.request("credential.get", {
      source: "cluster", source_id: clusterName, purpose,
      userId: identity.userId,
      agentId: identity.agentId,
      orgId: identity.orgId ?? "",
      boxId: identity.boxId ?? "",
    }) as Promise<CredentialPayload>;
  }

  async getHostCredential(identity: Identity, hostName: string, purpose: string): Promise<CredentialPayload> {
    return this.frontendClient.request("credential.get", {
      source: "host", source_id: hostName, purpose,
      userId: identity.userId,
      agentId: identity.agentId,
      orgId: identity.orgId ?? "",
      boxId: identity.boxId ?? "",
    }) as Promise<CredentialPayload>;
  }
}

export class CredentialNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "CredentialNotFoundError"; }
}

export function createCredentialService(frontendClient: FrontendWsClient): CredentialService {
  console.log(`[credential-service] backend: FrontendWsClient RPC`);
  return new CredentialService(frontendClient);
}
