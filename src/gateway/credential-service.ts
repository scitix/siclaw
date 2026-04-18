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
import { sessionRegistry, type SessionRegistry } from "./session-registry.js";

export class CredentialService {
  constructor(
    private readonly frontendClient: FrontendWsClient,
    private readonly registry: SessionRegistry = sessionRegistry,
  ) {}

  private rpcParams(identity: Identity, extra: Record<string, unknown> = {}): Record<string, unknown> {
    // AgentBox is user-unaware — it doesn't know the caller's userId. Runtime
    // recovers the attribution from the session registry (populated at chat
    // entry) so Upstream still sees a concrete userId for audit purposes.
    const userId = this.registry.resolveUser(identity.sessionId);
    return {
      userId,
      agentId: identity.agentId,
      orgId: identity.orgId ?? "",
      boxId: identity.boxId ?? "",
      sessionId: identity.sessionId ?? "",
      ...extra,
    };
  }

  async listClusters(identity: Identity): Promise<ClusterMeta[]> {
    const data = await this.frontendClient.request(
      "credential.list",
      this.rpcParams(identity, { kind: "cluster" }),
    ) as { clusters?: ClusterMeta[] };
    if (!Array.isArray(data.clusters)) {
      throw new Error("Adapter credential-list returned malformed cluster list response");
    }
    return data.clusters;
  }

  async listHosts(identity: Identity): Promise<HostMeta[]> {
    const data = await this.frontendClient.request(
      "credential.list",
      this.rpcParams(identity, { kind: "host" }),
    ) as { hosts?: HostMeta[] };
    if (!Array.isArray(data.hosts)) {
      throw new Error("Adapter credential-list returned malformed host list response");
    }
    return data.hosts;
  }

  async getClusterCredential(identity: Identity, clusterName: string, purpose: string): Promise<CredentialPayload> {
    return this.frontendClient.request(
      "credential.get",
      this.rpcParams(identity, { source: "cluster", source_id: clusterName, purpose }),
    ) as Promise<CredentialPayload>;
  }

  async getHostCredential(identity: Identity, hostName: string, purpose: string): Promise<CredentialPayload> {
    return this.frontendClient.request(
      "credential.get",
      this.rpcParams(identity, { source: "host", source_id: hostName, purpose }),
    ) as Promise<CredentialPayload>;
  }
}

export class CredentialNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "CredentialNotFoundError"; }
}

export function createCredentialService(frontendClient: FrontendWsClient): CredentialService {
  console.log(`[credential-service] backend: FrontendWsClient RPC`);
  return new CredentialService(frontendClient);
}
