import { getDb } from "../gateway/db.js";
import { safeParseJson } from "../gateway/dialect-helpers.js";
import { buildProviderModelDescriptor } from "../core/model-compat.js";
import {
  normalizeCandidates,
  normalizeModelRoutePolicy,
  type ModelRouteCandidate,
  type ModelRoutePolicy,
} from "../core/model-routing.js";

export interface PrimaryModelRef {
  provider: string;
  modelId: string;
}

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string | null;
  api_type: string;
}

interface ModelRow {
  model_id: string;
  name: string | null;
  reasoning: number | boolean;
  vision: number | boolean;
  context_window: number;
  max_tokens: number;
}

export function encodeModelRoutingForDb(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = normalizeModelRoutePolicy(value);
  if (!normalized) {
    throw new Error("model_routing must be null or a valid ordered_fallback policy");
  }
  return JSON.stringify(stripRuntimeCandidateConfig(normalized));
}

export async function resolveAgentModelRouting(
  raw: unknown,
  primary: PrimaryModelRef,
): Promise<ModelRoutePolicy | undefined> {
  const policy = normalizeModelRoutePolicy(safeParseJson(raw, null));
  if (!policy) return undefined;
  if (policy.enabled !== true) return policy;

  const candidates = normalizeCandidates([
    { provider: primary.provider, modelId: primary.modelId },
    ...(policy.candidates ?? []),
  ]);
  const configs = await loadProviderConfigs([...new Set(candidates.map((c) => c.provider))]);
  const hydratedCandidates: ModelRouteCandidate[] = candidates.map((candidate) => ({
    ...candidate,
    modelConfig: configs.get(candidate.provider) ?? candidate.modelConfig,
  }));

  return {
    ...policy,
    candidates: hydratedCandidates,
  };
}

export function resolveSnapshotModelRouting(
  raw: unknown,
  primary: PrimaryModelRef,
  providers: Record<string, Record<string, unknown>>,
): ModelRoutePolicy | undefined {
  const policy = normalizeModelRoutePolicy(safeParseJson(raw, null));
  if (!policy) return undefined;
  if (policy.enabled !== true) return policy;

  return {
    ...policy,
    candidates: normalizeCandidates([
      { provider: primary.provider, modelId: primary.modelId },
      ...(policy.candidates ?? []),
    ]).map((candidate) => ({
      ...candidate,
      modelConfig: providers[candidate.provider] ?? candidate.modelConfig,
    })),
  };
}

async function loadProviderConfigs(providerNames: string[]): Promise<Map<string, Record<string, unknown>>> {
  const db = getDb();
  const out = new Map<string, Record<string, unknown>>();
  for (const providerName of providerNames) {
    const [providerRows] = await db.query<ProviderRow[]>(
      "SELECT id, name, base_url, api_key, api_type FROM model_providers WHERE name = ? LIMIT 1",
      [providerName],
    );
    const provider = providerRows[0];
    if (!provider) continue;

    const [modelRows] = await db.query<ModelRow[]>(
      "SELECT model_id, name, reasoning, vision, context_window, max_tokens FROM model_entries WHERE provider_id = ?",
      [provider.id],
    );
    out.set(provider.name, {
      name: provider.name,
      baseUrl: provider.base_url,
      apiKey: provider.api_key ?? "",
      api: provider.api_type,
      authHeader: true,
      models: modelRows.map((model) =>
        buildProviderModelDescriptor(model, { api: provider.api_type, baseUrl: provider.base_url }),
      ),
    });
  }
  return out;
}

function stripRuntimeCandidateConfig(policy: ModelRoutePolicy): ModelRoutePolicy {
  if (!policy.candidates) return policy;
  return {
    ...policy,
    candidates: policy.candidates.map((candidate) => ({
      provider: candidate.provider,
      modelId: candidate.modelId,
      ...(candidate.label ? { label: candidate.label } : {}),
    })),
  };
}
