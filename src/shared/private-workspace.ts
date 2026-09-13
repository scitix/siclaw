/** Private persistence protocol. No credentials or caller-selected object paths. */
export const PRIVATE_WORKSPACE_PATH = "/api/internal/private-workspace";
export const WORKSPACE_OBJECT_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_MAX_OBJECTS = 4096;

export interface WorkspaceObjectRef {
  id: string;
  spaceId: string;
  storageBackendId: string;
  key: string;
  versionId: string;
  sha256: string;
  size: number;
}

export interface WorkspaceBinding {
  spaceId: string;
  workspaceId: string;
  revision: number;
  epoch: number;
  placementEpoch: number;
  generation: number;
  leaseUntil: number;
  manifest: WorkspaceObjectRef | null;
}

export interface PrivateSpaceIdentity {
  spaceId: string;
  userId: string;
  orgId: string;
  agentId: string;
}

export interface WorkspaceCommit extends WorkspaceBinding {
  operationId: string;
  manifestId: string;
  objectIds: string[];
}

export type WorkspaceRequest = {
  action: "acquire" | "renew" | "release" | "put" | "get" | "commit" | "learn" | "memory_search";
  sessionId: string;
  incarnation: string;
  binding?: WorkspaceBinding;
  commit?: WorkspaceCommit;
  objectId?: string;
  data?: string;
  query?: string;
};

export interface PrivateMemorySource {
  validateExecution?(): Promise<void>;
  search(query: string): Promise<{ records: Array<{ id: string; kind: string; text: string; sourceSessionId: string; sourceEntryId: string; expiresAt: number }> }>;
}

export function privateWorkspaceEnabled(): boolean {
  const mode = process.env.SICLAW_WORKSPACE_MODE;
  if (mode && mode !== "local" && mode !== "remote") throw new Error("Invalid SICLAW_WORKSPACE_MODE");
  return mode === "remote";
}

export function validPrivateId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
}
