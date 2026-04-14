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

export interface ClusterMeta {
  name: string;
  description?: string;
  api_server?: string;
  is_production: boolean;
  contexts?: Array<{ name: string; cluster?: string; namespace?: string }>;
  current_context?: string;
  debug_image?: string;
}

export interface CredentialFile {
  name: string;
  content: string;
  mode?: number;
}

export interface CredentialPayload {
  credential: {
    name: string;
    type: string;
    files: CredentialFile[];
    metadata?: Record<string, unknown>;
    ttl_seconds?: number;
  };
  audit_id?: string;
}

/**
 * Gateway-side credential resolution contract. Implemented by gateway modules
 * (LocalDbCredentialService, ExternalCredentialService) and consumed both by
 * HTTP handlers (credential-proxy) and by the in-process DirectCallTransport.
 */
export interface CredentialService {
  listClusters(identity: Identity): Promise<ClusterMeta[]>;
  getClusterCredential(
    identity: Identity,
    clusterName: string,
    purpose: string,
  ): Promise<CredentialPayload>;
}
