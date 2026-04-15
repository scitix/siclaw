/**
 * Shared credential types.
 *
 * Live in `src/shared/` so that both the gateway build (which owns
 * CredentialService implementations) and the agentbox build (which owns the
 * CredentialBroker / transports) can import them. Putting them under
 * `src/gateway/` broke the agentbox tsc include list.
 *
 * Only POD interfaces here — no runtime code, no node-specific deps.
 */

export interface Identity {
  userId: string;
  agentId: string;
  orgId?: string;
  boxId?: string;
}

export type ResourceKind = "cluster" | "host";

export interface ClusterMeta {
  name: string;
  description?: string;
  api_server?: string;
  is_production: boolean;
  contexts?: Array<{ name: string; cluster?: string; namespace?: string }>;
  current_context?: string;
  debug_image?: string;
}

export interface HostMeta {
  name: string;
  description?: string;
  ip: string;
  port: number;
  username: string;
  auth_type: "password" | "key";
  is_production: boolean;
}

export interface CredentialFile {
  name: string;
  content: string;
  mode?: number;
}

export interface CredentialPayload {
  credential: {
    name: string;
    type: "kubeconfig" | "ssh";
    files: CredentialFile[];
    metadata?: Record<string, unknown>;
    ttl_seconds?: number;
  };
  audit_id?: string;
}

/**
 * Credential service contract — consumed by credential-proxy, DirectCallTransport,
 * LocalSpawner. Single implementation in gateway/credential-service.ts calls
 * the adapter API (Portal or Upstream).
 */
export interface CredentialService {
  listClusters(identity: Identity): Promise<ClusterMeta[]>;
  listHosts(identity: Identity): Promise<HostMeta[]>;
  getClusterCredential(identity: Identity, clusterName: string, purpose: string): Promise<CredentialPayload>;
  getHostCredential(identity: Identity, hostName: string, purpose: string): Promise<CredentialPayload>;
}
