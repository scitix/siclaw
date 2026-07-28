export type KnowledgeMaterializedCapability = {
  kind: "materialized";
  contract: "knowledge.materialize/v1";
  rootPath?: string;
};

export type KnowledgeRetrieveCapability = {
  kind: "retrieve";
  contract: "knowledge.retrieve/v1";
  features?: string[];
  indexVersion?: string;
  status?: "ready" | "degraded" | "not_ready";
};

export type KnowledgeCapability =
  | KnowledgeMaterializedCapability
  | KnowledgeRetrieveCapability;

export interface KnowledgeRuntimeBinding {
  repoId: string;
  name: string;
  description?: string;
  version: string;
  capabilities: KnowledgeCapability[];
}

export interface KnowledgeRetrieveRequest {
  query: string;
  repoIds?: string[];
  filters?: Record<string, unknown>;
  topK?: number;
}

export interface KnowledgeEvidence {
  repoId: string;
  sourceId: string;
  title: string;
  content: string;
  score?: number;
  citation?: Record<string, unknown>;
  indexVersion?: string;
}

export interface KnowledgeEvidenceSet {
  retrievalId: string;
  evidence: KnowledgeEvidence[];
}

export type KnowledgeRetrieveExecutor = (
  request: KnowledgeRetrieveRequest,
  signal?: AbortSignal,
) => Promise<KnowledgeEvidenceSet>;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeCapability(value: unknown): KnowledgeCapability | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "materialized" && raw.contract === "knowledge.materialize/v1") {
    return {
      kind: "materialized",
      contract: "knowledge.materialize/v1",
      ...(optionalString(raw.rootPath) ? { rootPath: optionalString(raw.rootPath) } : {}),
    };
  }
  if (raw.kind === "retrieve" && raw.contract === "knowledge.retrieve/v1") {
    const features = Array.isArray(raw.features)
      ? raw.features.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : undefined;
    const status = raw.status === "ready" || raw.status === "degraded" || raw.status === "not_ready"
      ? raw.status
      : undefined;
    return {
      kind: "retrieve",
      contract: "knowledge.retrieve/v1",
      ...(features?.length ? { features } : {}),
      ...(optionalString(raw.indexVersion) ? { indexVersion: optionalString(raw.indexVersion) } : {}),
      ...(status ? { status } : {}),
    };
  }
  return null;
}

/**
 * Treat the Gateway payload and on-disk manifest as untrusted wire data.
 * Unknown future capabilities are ignored so an older Runtime can still use
 * the capabilities it understands without inventing behavior.
 */
export function normalizeKnowledgeRuntimeBindings(value: unknown): KnowledgeRuntimeBinding[] {
  if (!Array.isArray(value)) return [];
  const result: KnowledgeRuntimeBinding[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const repoId = optionalString(raw.repoId);
    const name = optionalString(raw.name);
    if (!repoId || !name || seen.has(repoId)) continue;
    const capabilities = Array.isArray(raw.capabilities)
      ? raw.capabilities.map(normalizeCapability).filter((cap): cap is KnowledgeCapability => cap !== null)
      : [];
    if (capabilities.length === 0) continue;
    seen.add(repoId);
    result.push({
      repoId,
      name,
      description: optionalString(raw.description),
      version: optionalString(raw.version) ?? "unknown",
      capabilities,
    });
  }
  return result;
}
