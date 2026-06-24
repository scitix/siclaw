/**
 * AgentBox type definitions.
 *
 * One AgentBox pod per agent. The pod is shared by every user who addresses
 * that agent; per-user state is carried in the request's sessionId, not in
 * the pod identity. No userId here.
 */

/** AgentBox status */
export type AgentBoxStatus = "starting" | "running" | "stopping" | "stopped" | "error";

/** AgentBox configuration */
export interface AgentBoxConfig {
  /** Agent ID — the pod identity; also the cert CN. */
  agentId: string;
  /** Organization ID — for RBAC scoping in Upstream Adapter */
  orgId?: string;
  /** Allowed tools list for this agent (null = all) */
  allowedTools?: string[] | null;
  /** Environment variables */
  env?: Record<string, string>;
  /** Resource limits */
  resources?: {
    cpu?: string;
    memory?: string;
  };
  /**
   * Per-agent session/memory persistence override.
   * - true  → mount the shared PVC (session JSONL + memory survive pod restarts)
   * - false → use emptyDir (session cleared on pod restart/idle release)
   * - undefined → fall back to the spawner's global persistence config
   * Only honored by K8sSpawner; ignored by Local/Process spawners.
   */
  persistence?: boolean;
}

/** AgentBox information */
export interface AgentBoxInfo {
  boxId: string;
  agentId: string;
  status: AgentBoxStatus;
  endpoint: string;
  createdAt: Date;
  lastActiveAt: Date;
  /**
   * Fingerprint of the CA that signed this pod's mTLS cert, read from the
   * pod's `<prefix>/ca-fp` label (K8s only; undefined for spawners that don't
   * stamp it). The manager refuses to reuse a pod whose fingerprint no longer
   * matches the runtime's current CA — see AgentBoxManager.getOrCreateK8s.
   */
  caFingerprint?: string;
}

/** AgentBox handle, used for subsequent operations */
export interface AgentBoxHandle {
  boxId: string;
  endpoint: string;
  agentId: string;
}
