/** Private persistence protocol. No credentials or caller-selected object paths. */
export const PRIVATE_WORKSPACE_PATH = "/api/internal/private-workspace";
export const WORKSPACE_OBJECT_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_MAX_OBJECTS = 4096;

/** HTTP/transport classification only; never carry private upstream error bodies.
 * Kept in shared because the isolated AgentBox image does not include lib.
 */
export class WorkspaceTransportError extends Error {
  readonly retriable: boolean;
  constructor(readonly status?: number) {
    super(status == null ? "Private workspace transport is unavailable" : "Private workspace is unavailable or its execution changed");
    this.name = "WorkspaceTransportError";
    this.retriable = status == null || status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

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
  action: "acquire" | "renew" | "release" | "put" | "get" | "commit" | "learn" | "memory_search" | "memory_read";
  sessionId: string;
  incarnation: string;
  binding?: WorkspaceBinding;
  commit?: WorkspaceCommit;
  objectId?: string;
  data?: string;
  search?: MemorySearchRequest;
  read?: MemoryReadRequest;
};

/** Virtual document paths never designate files, object keys, or skills. */
export interface MemorySearchRequest {
  queries: string[];
  match_mode?: "any" | "all";
  scope?: string;
  cursor?: string;
  context_lines?: number;
  max_results?: number;
}
export interface MemorySearchMatch {
  path: string;
  kind: string;
  scope?: string;
  claim?: string;
  content: string;
  content_start_line_number: number;
  truncated: boolean;
  matched_queries: string[];
  source_session_id: string;
  source_entry_id: string;
  created_at: number;
  expires_at: number;
}
export interface MemorySearchPage {
  matches: MemorySearchMatch[];
  next_cursor?: string;
  truncated: boolean;
  enabled: boolean;
}
export interface MemoryReadRequest {
  path: string;
  line_offset?: number;
  max_lines?: number;
  char_offset?: number;
}
export interface MemoryReadPage {
  path: string;
  found: boolean;
  content: string;
  start_line_number: number;
  next_char_offset?: number;
  truncated: boolean;
  source_session_id?: string;
  source_entry_id?: string;
  created_at?: number;
  expires_at?: number;
}
export interface PrivateMemorySource {
  validateExecution?(): Promise<void>;
  search(request: MemorySearchRequest): Promise<MemorySearchPage>;
  read(request: MemoryReadRequest): Promise<MemoryReadPage>;
}

export function privateWorkspaceEnabled(): boolean {
  const mode = process.env.SICLAW_WORKSPACE_MODE;
  if (mode && mode !== "local" && mode !== "remote") throw new Error("Invalid SICLAW_WORKSPACE_MODE");
  return mode === "remote";
}

export function validPrivateId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
}
