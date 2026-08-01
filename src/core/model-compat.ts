import type { ProviderModelCompat } from "./config.js";

export interface ProviderCompatInput {
  api?: string | null;
  baseUrl?: string | null;
}

/** Raw `model_entries` row shape needed to build a model descriptor. */
export interface ProviderModelRow {
  model_id: string;
  name?: string | null;
  reasoning?: unknown;
  vision?: unknown;
  context_window: number;
  max_tokens: number;
  /** Wire protocol this model speaks. Required; see `resolveModelApi`. */
  api_type?: string | null;
  /** Explicit `maxTokensField` override; NULL/empty = infer. */
  max_tokens_field?: string | null;
}

/**
 * The per-MODEL half of compat resolution.
 *
 * `compat` describes the wire shape of a request, and wire shape is a property
 * of the model, not of the endpoint it happens to be served from: one gateway
 * serves gpt-5 (which rejects `max_tokens`) next to DeepSeek (which requires
 * it). Every caller must therefore say which model it is building for.
 */
export interface ModelCompatInput {
  id: string;
  maxTokensField?: string | null;
}

/** The two field names pi can emit — see MaxTokensField below. */
export type MaxTokensField = "max_tokens" | "max_completion_tokens";

export function isValidMaxTokensField(value: unknown): value is MaxTokensField {
  return value === "max_tokens" || value === "max_completion_tokens";
}

/**
 * Whether `modelId` names an OpenAI reasoning family, which rejects the legacy
 * `max_tokens` field and requires `max_completion_tokens`.
 *
 * Same shape as sicore's `isReasoningModel` (sicore/pkg/llm/openai.go), which
 * was added after the identical 400 from the same gateway. This is a NAMING
 * CONVENTION, so it is only the fallback: an explicit `max_tokens_field` on the
 * model row always wins, which is what covers renamed ids on aggregator
 * gateways and families that ship after this code does.
 */
export function looksLikeOpenAiReasoningModel(modelId: string): boolean {
  let id = modelId.trim().toLowerCase();
  // Aggregators namespace ids as `vendor/model`; judge on the model part.
  const slash = id.lastIndexOf("/");
  if (slash >= 0) id = id.slice(slash + 1);
  id = id.replaceAll("-", "");
  return id.startsWith("gpt5") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4");
}

/**
 * Decide which request field carries the output-token cap for one model.
 *
 * Validation is a strict WHITELIST rather than the passthrough used for
 * provider api ids. pi types this field as a two-member union
 * (`pi-coding-agent` model-registry: `Type.Union([max_completion_tokens,
 * max_tokens])`), so an unrecognised value doesn't degrade — it fails the
 * provider's schema and drops the model out of the registry entirely, which
 * surfaces as "model not found" rather than as a field error.
 */
export function resolveMaxTokensField(
  model: ModelCompatInput,
  provider: ProviderCompatInput,
): MaxTokensField {
  const explicit = (model.maxTokensField ?? "").trim();
  if (isValidMaxTokensField(explicit)) return explicit;

  // Anthropic's messages API always names the field `max_tokens`, and pi's
  // anthropic path ignores this setting entirely — never infer a switch there.
  if (!usesChatCompletions(provider) || !looksLikeOpenAiReasoningModel(model.id)) return "max_tokens";
  return "max_completion_tokens";
}

/** Build the model half of a compat input from a raw `model_entries` row. */
export function modelCompatInputFromRow(row: ProviderModelRow): ModelCompatInput {
  return { id: row.model_id, maxTokensField: row.max_tokens_field };
}

/**
 * Judged on the RESOLVED api. Callers pass the model's own protocol (see
 * `buildProviderModelDescriptor`), so on a mixed gateway this answers per model
 * rather than per endpoint.
 */
function usesChatCompletions(provider: ProviderCompatInput): boolean {
  return normalizeProviderApi(provider.api) === "openai-completions";
}

/**
 * Map legacy provider api names to the pi-ai API-provider registry's canonical
 * ids. pi looks a model's `api` up in its registry verbatim ("anthropic" is a
 * provider slug there, not an api — only "anthropic-messages" is registered),
 * so any legacy value reaching a model config fails the whole turn with
 * "No API provider registered for api: …". Portal DB rows and settings.json
 * written before this mapping existed carry the legacy names; normalizing at
 * read time keeps them working without a data migration.
 */
const LEGACY_API_ALIASES: Record<string, string> = {
  anthropic: "anthropic-messages",
  openai: "openai-completions",
};

export function normalizeProviderApi(api: string | null | undefined): string {
  const raw = (api ?? "").trim();
  if (!raw) return "openai-completions";
  return LEGACY_API_ALIASES[raw.toLowerCase()] ?? raw;
}

/**
 * The wire protocol a model speaks.
 *
 * This is a PER-MODEL attribute — one endpoint can serve OpenAI-protocol and
 * Claude-protocol models side by side, so there is no meaningful provider-wide
 * answer and `model_entries.api_type` is required. `provider.api` remains only
 * as a read-time floor for rows written before the column was backfilled (a
 * legacy SQLite file, where the NOT NULL tightening is a no-op).
 */
export function resolveModelApi(
  row: ProviderModelRow,
  provider: ProviderCompatInput,
): string {
  return normalizeProviderApi((row.api_type ?? "").trim() || provider.api);
}


function isOfficialOpenAIBaseUrl(baseUrl?: string | null): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * `model` is REQUIRED, not optional. `maxTokensField` was a per-provider
 * constant for most of this repo's life, which is exactly how a per-model
 * attribute ended up hardcoded: the function that decided it could not see
 * which model it was deciding for. Making the parameter mandatory turns a new
 * call site that hasn't thought about it into a compile error.
 */
export function defaultProviderModelCompat(
  provider: ProviderCompatInput,
  model: ModelCompatInput,
): Required<
  Pick<ProviderModelCompat, "supportsDeveloperRole" | "supportsUsageInStreaming" | "maxTokensField">
> {
  return {
    supportsDeveloperRole: usesChatCompletions(provider) && isOfficialOpenAIBaseUrl(provider.baseUrl),
    supportsUsageInStreaming: true,
    // Always emitted, never omitted: omitting hands the decision back to pi's
    // own base-URL heuristic, and this value is precisely what we mean to state
    // explicitly.
    maxTokensField: resolveMaxTokensField(model, provider),
  };
}

/**
 * Build a single `ProviderModelConfig` descriptor from a `model_entries` row.
 *
 * This is the SINGLE place that translates the persisted `vision` boolean into
 * the runtime `input` capability list, and the single place that resolves a
 * model's wire protocol. Keeping it centralized prevents the
 * descriptor-construction drift that hardcoded `input: ["text"]` causes across
 * the (6+) production paths that hydrate model bindings — a vision model whose
 * `input` was missed would have its image request silently filtered by
 * model-routing's `filterCandidatesForPromptMedia`.
 *
 * `api` is ALWAYS emitted. pi would fall back to the provider's value if the
 * key were absent, but protocol is a per-model property here, so stating it
 * explicitly is what keeps the two layers from disagreeing — and it means
 * nothing downstream has to reason about which layer won.
 *
 * `compat` derives from that same api: compat describes the wire protocol
 * (`supportsDeveloperRole` keys off chat-completions, `maxTokensField` is
 * protocol-shaped), so it is per-model for the same reason.
 */
export function buildProviderModelDescriptor(
  row: ProviderModelRow,
  provider: ProviderCompatInput,
) {
  const api = resolveModelApi(row, provider);
  return {
    id: row.model_id,
    name: row.name ?? row.model_id,
    api,
    reasoning: !!row.reasoning,
    input: (row.vision ? ["text", "image"] : ["text"]) as string[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    // `api` (already resolved per-model), not `provider.api`: every compat
    // field describes the wire protocol, so both halves must agree on which
    // protocol this particular model speaks.
    compat: defaultProviderModelCompat({ api, baseUrl: provider.baseUrl }, modelCompatInputFromRow(row)),
  };
}
