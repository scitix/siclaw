/**
 * AgentBox type definitions.
 *
 * An agent's boxes are shared by every user who addresses that agent; per-user state
 * is carried in the request's sessionId, not in the pod identity. No userId here.
 * An agent may run several boxes — see `AgentBoxConfig.instance`.
 */

/** AgentBox status */
export type AgentBoxStatus = "starting" | "running" | "stopping" | "stopped" | "error";

/** AgentBox configuration */
export interface AgentBoxConfig {
  /** Agent ID — the pod identity; also the cert CN. For a capability box (e.g. a
   *  KB compile run) this is the run id (the run is a job, not a long-lived agent). */
  agentId: string;
  /** Organization ID — for RBAC scoping in Upstream Adapter */
  orgId?: string;
  /** BoxProfile name selecting the box shape + tool/trust envelope (see
   *  box-profile.ts). undefined → the default "agent" profile (a normal agentbox).
   *  Replaces the old `boxType` flag — a capability = a profile, not a fork. */
  profile?: string;
  /** Optional explicit image override (wins over the profile's image; used by tests/local). */
  image?: string;
  /** Allowed tools list for this agent (null = all) */
  allowedTools?: string[] | null;
  /** Environment variables */
  env?: Record<string, string>;
  /**
   * Resource override. `cpu`/`memory` set BOTH request and limit;
   * `cpuRequest`/`memoryRequest` set only the request (burstable shape) —
   * same semantics as BoxProfile.resources.
   */
  resources?: {
    cpu?: string;
    memory?: string;
    cpuRequest?: string;
    memoryRequest?: string;
  };
  /**
   * Per-agent session/memory persistence override.
   * - true  → mount the shared PVC (session JSONL + memory survive pod restarts)
   * - false → use emptyDir (session cleared on pod restart/idle release)
   * - undefined → fall back to the spawner's global persistence config
   * Only honored by K8sSpawner; ignored by Local/Process spawners.
   */
  persistence?: boolean;
  /**
   * Which replica of the agent this box is. Defaults to 0.
   *
   * Instance 0 keeps the historic unsuffixed pod name, so an agent that never scales
   * past one box is byte-identical to before this existed. The value is also stamped
   * as the `instance` label, which is what anything reading the index should use — the
   * name is not parseable back into an index.
   */
  instance?: number;
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
  /**
   * When the mTLS certificate this pod mounts expires, read from its `<prefix>/cert-exp`
   * label (K8s only).
   *
   * Undefined means UNKNOWN, not "never": pods created before the label existed carry no
   * such label, and the manager must read that as fresh — the same trap the CA fingerprint
   * fell into once, where a missing label read as "signed by a CA we no longer trust" and
   * every box was drained on sight.
   *
   * Needed as well as {@link caFingerprint} because a certificate goes bad in two
   * independent ways: the CA that signed it can be rotated, or the leaf can simply run
   * out. The second is invisible to a fingerprint comparison.
   */
  certExpiresAt?: Date;
  /**
   * The box's process ended without being asked to — a crash, an OOM kill, an eviction.
   *
   * Distinct from ending cleanly (idle self-destruct, or a shutdown the runtime asked
   * for), which is a pod doing what it was told. Only the unasked-for kind should bring
   * a replacement back: replacing the other kind fights the feature that removed it and
   * churns a pod nobody is using.
   */
  exitedUnexpectedly?: boolean;
  /** BoxProfile name this pod was spawned with (from its label; "agent" if absent).
   *  Used by the manager to refuse reusing a pod whose profile no longer matches
   *  the requested one — otherwise a profile change silently reuses the old-shaped
   *  box (image/tools/volumes), breaking the "different scenario = different box"
   *  isolation. */
  profile?: string;
  /** Replica index from the pod's `instance` label; 0 when absent (pre-replica pods). */
  instance?: number;
  /** Image the pod is actually running — compared against the configured one to
   *  detect a box left behind by a deploy. Pod reuse historically ignored this,
   *  which is why a new AgentBox image never took effect on its own. */
  image?: string;
}

/** AgentBox handle, used for subsequent operations */
export interface AgentBoxHandle {
  boxId: string;
  endpoint: string;
  agentId: string;
}
