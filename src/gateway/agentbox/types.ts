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
  /** Agent ID — the pod identity; also the cert CN. For a compile box this is
   *  the compile run id (the run is a job, not a long-lived agent). */
  agentId: string;
  /** Organization ID — for RBAC scoping in Upstream Adapter */
  orgId?: string;
  /** Box flavor. "agent" (default) = normal agentbox; "compile" = a KB compile
   *  box (different image, writable /work volume, driven by the compile protocol). */
  boxType?: "agent" | "compile";
  /** Optional image override. Compile boxes default to $SICLAW_COMPILE_BOX_IMAGE. */
  image?: string;
  /** Allowed tools list for this agent (null = all) */
  allowedTools?: string[] | null;
  /** Environment variables */
  env?: Record<string, string>;
  /** Resource limits */
  resources?: {
    cpu?: string;
    memory?: string;
  };
}

/** AgentBox information */
export interface AgentBoxInfo {
  boxId: string;
  agentId: string;
  status: AgentBoxStatus;
  endpoint: string;
  createdAt: Date;
  lastActiveAt: Date;
}

/** AgentBox handle, used for subsequent operations */
export interface AgentBoxHandle {
  boxId: string;
  endpoint: string;
  agentId: string;
}
