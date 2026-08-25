/**
 * Cross-process contract for the inventory an AgentBox has materialized.
 *
 * AgentBox serves this payload and Runtime relays it, so both processes must
 * compile against one shape even though their images can be released
 * independently.
 */
export interface ObservedKnowledgeRepo {
  id: string;
  name: string;
  version: number;
  sha256: string;
  fileCount?: number | null;
}

export interface BoxSyncStatus {
  knowledge: {
    syncedAt: string | null;
    repos: ObservedKnowledgeRepo[];
  };
  skills: { names: string[] };
  mcp: { names: string[] };
  /** Last release model that completed a successful turn in this box. */
  model?: {
    releaseId: string;
    modelFingerprint: string;
    observedAt: string;
  } | null;
}
