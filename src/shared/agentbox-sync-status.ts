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

/** Version of the AgentBox inventory and Runtime observation envelope. */
export const AGENT_SYNC_STATUS_SCHEMA_VERSION = 2;

export interface BoxSyncStatus {
  /** Preserve the box-reported version during rolling upgrades. */
  schemaVersion: number;
  knowledge: {
    syncedAt: string | null;
    repos: ObservedKnowledgeRepo[];
  };
  skills: { names: string[] };
  mcp: { names: string[] };
  /** Harness configuration that completed the latest successful turn. */
  harness?: {
    agentType: string;
    /** Configured Agent prompt/template, excluding stable platform instructions. */
    systemPromptTemplate: string | null;
    skillNames: string[];
    skillDigests: Record<string, string>;
    toolNames: string[];
    observedAt: string;
  } | null;
  /** Last release model that completed a successful turn in this box. */
  model?: {
    releaseId: string;
    modelFingerprint: string;
    observedAt: string;
  } | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Normalize an independently released AgentBox's JSON before Runtime uses it. */
export function normalizeBoxSyncStatus(value: unknown): BoxSyncStatus {
  const root = record(value);
  if (!root) throw new Error("invalid AgentBox sync status");

  const knowledge = record(root.knowledge);
  const repos = Array.isArray(knowledge?.repos)
    ? knowledge.repos.flatMap((item): ObservedKnowledgeRepo[] => {
        const repo = record(item);
        if (!repo || typeof repo.id !== "string" || typeof repo.name !== "string" ||
            typeof repo.version !== "number" || typeof repo.sha256 !== "string") return [];
        return [{
          id: repo.id,
          name: repo.name,
          version: repo.version,
          sha256: repo.sha256,
          ...(typeof repo.fileCount === "number" || repo.fileCount === null
            ? { fileCount: repo.fileCount }
            : {}),
        }];
      })
    : [];

  const harness = record(root.harness);
  const skillDigests = record(harness?.skillDigests);
  const normalizedDigests: Record<string, string> = {};
  for (const [name, digest] of Object.entries(skillDigests ?? {})) {
    if (typeof digest === "string") normalizedDigests[name] = digest;
  }

  const model = record(root.model);
  return {
    schemaVersion: typeof root.schemaVersion === "number" && Number.isFinite(root.schemaVersion)
      ? root.schemaVersion
      : 0,
    knowledge: {
      syncedAt: typeof knowledge?.syncedAt === "string" ? knowledge.syncedAt : null,
      repos,
    },
    skills: { names: strings(record(root.skills)?.names) },
    mcp: { names: strings(record(root.mcp)?.names) },
    ...(harness && typeof harness.agentType === "string"
      ? { harness: {
          agentType: harness.agentType,
          // This is the configured Agent prompt/template, not the final compiled
          // platform prompt. Keep the wire name for backward compatibility.
          systemPromptTemplate: typeof harness.systemPromptTemplate === "string"
            ? harness.systemPromptTemplate
            : null,
          skillNames: strings(harness.skillNames),
          skillDigests: normalizedDigests,
          toolNames: strings(harness.toolNames),
          observedAt: typeof harness.observedAt === "string" ? harness.observedAt : "",
        } }
      : root.harness === null ? { harness: null } : {}),
    ...(model && typeof model.releaseId === "string" && typeof model.modelFingerprint === "string"
      ? { model: {
          releaseId: model.releaseId,
          modelFingerprint: model.modelFingerprint,
          observedAt: typeof model.observedAt === "string" ? model.observedAt : "",
        } }
      : root.model === null ? { model: null } : {}),
  };
}

export type BoxSyncObservation =
  | {
      boxId: string;
      available: true;
      status: BoxSyncStatus;
    }
  | {
      boxId: string;
      available: false;
      reason: "unsupported" | "query_failed";
    };
