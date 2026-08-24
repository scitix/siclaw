import crypto from "node:crypto";
import { getDb } from "../gateway/db.js";
import { safeParseJson } from "../gateway/dialect-helpers.js";
import { buildProviderModelDescriptor, normalizeProviderApi } from "../core/model-compat.js";
import {
  normalizeCandidates,
  normalizeModelRoutePolicy,
  type ModelRouteCandidate,
  type ModelRoutePolicy,
} from "../core/model-routing.js";
import {
  canonicalTierConfig,
  type SubagentTierCandidates,
  type SubagentTierConfigEntry,
  type SubagentTierMenu,
} from "../core/subagent-models.js";

/** The one hash used for tier revisions, so every producer agrees. */
export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

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
  /** Per-model protocol override; null = inherit ProviderRow.api_type. */
  api_type: string | null;
  max_tokens_field: string | null;
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
      "SELECT model_id, name, reasoning, vision, context_window, max_tokens, api_type, max_tokens_field, compat_overrides FROM model_entries WHERE provider_id = ?",
      [provider.id],
    );
    const providerApi = normalizeProviderApi(provider.api_type);
    out.set(provider.name, {
      name: provider.name,
      baseUrl: provider.base_url,
      apiKey: provider.api_key ?? "",
      api: providerApi,
      authHeader: true,
      models: modelRows.map((model) =>
        buildProviderModelDescriptor(model, { api: providerApi, baseUrl: provider.base_url }),
      ),
    });
  }
  return out;
}

/**
 * Resolve an agent's stored tier config into the two wire payloads.
 *
 * ONE resolver for every Standalone binding-production path (`chat-gateway`, the
 * `config.getModelBinding` handler, and the CLI snapshot). Three hand-rolled
 * copies is how one of them ends up without a revision, or without the column,
 * and the failure is silent — tiering just never engages there.
 *
 * The revision is a SHA-256 over the canonical, order-normalized config, so the
 * menu and the candidates always agree when they describe the same configuration
 * regardless of which path produced them. That agreement is the whole point:
 * `resolveTierSelection` refuses to honour a tier whose two channels disagree.
 *
 * Returns `{menu: null, candidates: null}` when the agent has no tiers, or when a
 * tier names a provider this deployment cannot resolve — a partially-resolvable
 * list is not shipped half-applied, because a menu entry with no candidate behind
 * it reads to the lead as an offer it cannot fulfil.
 */
export async function resolveAgentSubagentTiers(raw: unknown): Promise<{
  menu: SubagentTierMenu | null;
  candidates: SubagentTierCandidates | null;
}> {
  const entries = safeParseJson<SubagentTierConfigEntry[]>(raw, [] as SubagentTierConfigEntry[]);
  if (!Array.isArray(entries) || entries.length === 0) return { menu: null, candidates: null };

  const configs = await loadProviderConfigs([...new Set(entries.map((e) => e.provider))]);

  const items: SubagentTierMenu["items"] = [];
  const candidates: SubagentTierCandidates["candidates"] = [];
  for (const entry of entries) {
    const modelConfig = configs.get(entry.provider);
    if (!modelConfig) return { menu: null, candidates: null };
    // The provider existing is not enough — the MODEL must still be in it. A model
    // deleted or renamed after the tier list was written leaves a dangling
    // reference, and shipping it would advertise a tier whose candidate the child
    // then cannot resolve. Catching it here turns a per-child fallback into a
    // whole-list "not configured", which is the honest state.
    const models = Array.isArray((modelConfig as { models?: unknown }).models)
      ? (modelConfig as { models: Array<{ id?: unknown }> }).models
      : [];
    if (!models.some((m) => m?.id === entry.modelId)) return { menu: null, candidates: null };
    items.push({ tier: entry.tier, whenToUse: entry.whenToUse });
    candidates.push({
      tier: entry.tier,
      provider: entry.provider,
      modelId: entry.modelId,
      modelConfig,
    });
  }

  // Same canonical form the menu projection uses, so both sides agree.
  const revision = sha256Hex(canonicalTierConfig(entries));

  return { menu: { revision, items }, candidates: { revision, candidates } };
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
