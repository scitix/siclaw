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

/**
 * Version of the AgentBox inventory and Runtime observation envelope.
 *
 * 3 adds `tiers`. The bump is load-bearing rather than cosmetic: `tiers` is
 * reported on EVERY successful turn, nulls included, so on a v3 box an absent
 * field cannot happen and a present one with two nulls means "ran, no tiers". A
 * consumer needs the version to tell that apart from a v2 box, which says nothing
 * either way. Without it, "this box is not tiering" and "this box is too old to
 * say" are the same observation.
 */
export const AGENT_SYNC_STATUS_SCHEMA_VERSION = 3;

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
  /**
   * Sub-agent model tiering, as the latest successful turn actually held it.
   *
   * The box implements tiering entirely on the turn path and, until this field,
   * said nothing about it anywhere — it ran correctly without being able to state
   * that it had. The two channels arrive independently (menu over tools sync,
   * candidates on the prompt), and every way that pairing fails is SILENT: falling
   * back is the documented behaviour for missing tier state, so a dropped channel
   * costs nothing observable except that no child ever runs on a tier.
   *
   * Reported as two revisions rather than one fingerprint, because which one is
   * missing is the diagnosis:
   *   both null            no tiering configured for this agent
   *   menu, no candidates  the prompt path is not forwarding them — the lead is
   *                        offered a tier that can never resolve
   *   candidates, no menu  the tools channel is stale; the lead was never offered
   *                        the tier whose credentials it holds
   *   equal revisions      tiering is live end to end on this box
   *   differing revisions  the two channels are on different config versions
   *
   * Emitted on every successful turn INCLUDING when both are null. A field that
   * appeared only when tiering worked would make a box that lost its tiers
   * indistinguishable from one released before this existed, which is the exact
   * ambiguity the reporting is for.
   */
  tiers?: {
    /** Revision of the menu the session's tool schema was built from. */
    menuRevision: string | null;
    /** Revision of the candidates the turn carried. */
    candidatesRevision: string | null;
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
  const tiers = record(root.tiers);
  /** A revision is 64 lowercase hex; anything else is not a revision. */
  const revision = (value: unknown): string | null =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
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
    // Preserved whenever the box sent the object, even with both revisions null:
    // that IS the report ("ran a turn, held no tiers"). Dropping it would restore
    // the ambiguity with a box too old to report at all.
    ...(tiers
      ? { tiers: {
          menuRevision: revision(tiers.menuRevision),
          candidatesRevision: revision(tiers.candidatesRevision),
          observedAt: typeof tiers.observedAt === "string" ? tiers.observedAt : "",
        } }
      : root.tiers === null ? { tiers: null } : {}),
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
