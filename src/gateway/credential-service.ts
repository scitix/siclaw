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

  private async rpcParams(identity: Identity, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    // AgentBox is user-unaware — it doesn't know the caller's userId. Runtime
    // recovers the attribution from the session registry (populated at chat
    // entry, with a Portal RPC fallback for cache misses) so Upstream still
    // sees a concrete userId for audit purposes.
    //
    // Cross-agent attribution is rejected: if AgentBox A (cert agentId=A)
    // passes a session_id whose owner agentId=B, we refuse rather than
    // silently audit B's user as the caller. Unknown sessions degrade to
    // empty userId (graceful, same as pre-fallback behaviour).
    let userId = "";
    if (identity.sessionId) {
      const owner = await this.registry.get(identity.sessionId);
      if (owner) {
        if (owner.agentId !== identity.agentId) {
          throw new SessionOwnershipError(
            `session ${identity.sessionId} belongs to agent ${owner.agentId}, not ${identity.agentId}`,
          );
        }
        userId = owner.userId;
      }
    }
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
      await this.rpcParams(identity, { kind: "cluster" }),
    ) as { clusters?: ClusterMeta[] };
    if (!Array.isArray(data.clusters)) {
      throw new Error("Adapter credential-list returned malformed cluster list response");
    }
    return data.clusters;
  }

  async listHosts(identity: Identity): Promise<HostMeta[]> {
    const data = await this.frontendClient.request(
      "credential.list",
      await this.rpcParams(identity, { kind: "host" }),
    ) as { hosts?: HostMeta[] };
    if (!Array.isArray(data.hosts)) {
      throw new Error("Adapter credential-list returned malformed host list response");
    }
    return data.hosts;
  }

  async getClusterCredential(identity: Identity, clusterName: string, purpose: string): Promise<CredentialPayload> {
    return this.frontendClient.request(
      "credential.get",
      await this.rpcParams(identity, { source: "cluster", source_id: clusterName, purpose }),
    ) as Promise<CredentialPayload>;
  }

  async getHostCredential(identity: Identity, hostName: string, purpose: string): Promise<CredentialPayload> {
    return this.frontendClient.request(
      "credential.get",
      await this.rpcParams(identity, { source: "host", source_id: hostName, purpose }),
    ) as Promise<CredentialPayload>;
  }
}

export class CredentialNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "CredentialNotFoundError"; }
}

/**
 * Thrown when a credential request carries a sessionId that resolves to a
 * different agent than the calling cert. credential-proxy translates this
 * into HTTP 403 — never falls through to the upstream RPC, which would
 * otherwise audit the wrong user.
 */
export class SessionOwnershipError extends Error {
  constructor(message: string) { super(message); this.name = "SessionOwnershipError"; }
}

export function createCredentialService(frontendClient: FrontendWsClient): CredentialService {
  console.log(`[credential-service] backend: FrontendWsClient RPC`);
  return new CredentialService(frontendClient);
}
