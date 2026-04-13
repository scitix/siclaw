/**
 * AgentBox type definitions
 */

/** AgentBox status */
export type AgentBoxStatus = "starting" | "running" | "stopping" | "stopped" | "error";

/** AgentBox configuration */
export interface AgentBoxConfig {
  userId: string;
  /** Agent ID — each AgentBox serves one agent (composite cache key with userId) */
  agentId?: string;
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
  /** Pod environment type — encoded in mTLS cert, determines credential/skill scoping */
  podEnv?: "prod" | "dev" | "test";
}

/** AgentBox information */
export interface AgentBoxInfo {
  boxId: string;
  userId: string;
  /** Agent ID this box serves (from K8s label or cache key) */
  agentId?: string;
  status: AgentBoxStatus;
  endpoint: string;
  createdAt: Date;
  lastActiveAt: Date;
}

/** AgentBox handle, used for subsequent operations */
export interface AgentBoxHandle {
  boxId: string;
  userId: string;
  endpoint: string;
  /** Agent ID this box serves */
  agentId?: string;
}
