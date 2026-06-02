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
  /** Stable host id. Populated by host search as a selection handle; absent on
   *  the dial path (credential.get) where the broker keys by name. */
  id?: string;
  name: string;
  description?: string;
  ip: string;
  port: number;
  username: string;
  /**
   * "managed" = the target stores no credential of its own; the last hop
   * authenticates with a private key discovered on the jump host (bastion).
   * Requires jump_host. See ADR-013.
   */
  auth_type: "password" | "key" | "managed";
  is_production: boolean;
  /**
   * Name of the next-hop jump host (bastion), if this host is reached through a
   * ProxyJump chain. A neutral host-name reference — the management server
   * resolves any internal id to the host's name before sending. Absent for
   * directly-reachable hosts. Chains resolve recursively (depth capped at 3).
   */
  jump_host?: string;
}

export interface CredentialFile {
  name: string;
  content: string;
  mode?: number;
}

/**
 * A page of `host_list` results (when a query / pagination is supplied).
 * Metadata only — never secrets. `total` is the full match count (for "narrow
 * your query" hints); `next_cursor` is an opaque pagination cursor, null when
 * exhausted.
 */
export interface HostListResult {
  hosts: HostMeta[];
  total: number;
  next_cursor: string | null;
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
