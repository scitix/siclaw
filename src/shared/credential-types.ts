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
  agentId: string;
  orgId?: string;
  boxId?: string;
  /**
   * Opaque per-request tenant key for downstream audit / scoping. Runtime
   * resolves it to a concrete user via its session registry before calling
   * Upstream. AgentBox and its transports treat this as an opaque string.
   */
  sessionId?: string;
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
