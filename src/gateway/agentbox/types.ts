/**
 * AgentBox type definitions
 */

/** AgentBox status */
export type AgentBoxStatus = "starting" | "running" | "stopping" | "stopped" | "error";

/** AgentBox configuration */
export interface AgentBoxConfig {
  userId: string;
  /** Workspace ID (composite cache key with userId) */
  workspaceId?: string;
  /** Allowed tools list for this workspace (null = all) */
  allowedTools?: string[] | null;
  /** Optional kubeconfig content (base64) */
  kubeconfigBase64?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Resource limits */
  resources?: {
    cpu?: string;
    memory?: string;
  };
  /** Pod environment type — determines which skills are available via bundle API */
  podEnv?: "prod" | "dev";
}

/** AgentBox information */
export interface AgentBoxInfo {
  boxId: string;
  userId: string;
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
}
