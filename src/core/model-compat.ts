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
  /** Per-model protocol override; null/empty = inherit the provider's api. */
  api_type?: string | null;
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
 * Resolve the wire protocol a single model speaks: its own `api_type` when set,
 * else the provider's. `isOverride` tells the caller whether the model actually
 * overrode — see `buildProviderModelDescriptor` for why that distinction is
 * load-bearing.
 *
 * Two details in the guard are deliberate and must not be "simplified":
 *
 * 1. `.trim()` before the truthiness test — a whitespace-only value inherits
 *    rather than being passed through as an api id.
 * 2. `||`, never `??` — `normalizeProviderApi("")` returns "openai-completions"
 *    (the no-value fallback), so `row.api_type ?? provider.api` would turn an
 *    empty-string column into a HARD OpenAI override, silently un-inheriting an
 *    anthropic-messages provider. `??` only guards null/undefined; '' sails
 *    through it. The DB coerces '' to NULL on write (siclaw-api.ts), but this
 *    guard also covers rows written by anything else.
 */
export function resolveModelApi(
  row: ProviderModelRow,
  provider: ProviderCompatInput,
): { api: string; isOverride: boolean } {
  const override = (row.api_type ?? "").trim();
  return { api: normalizeProviderApi(override || provider.api), isOverride: override !== "" };
}

function isOfficialOpenAIBaseUrl(baseUrl?: string | null): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

export function defaultProviderModelCompat(provider: ProviderCompatInput): Required<
  Pick<ProviderModelCompat, "supportsDeveloperRole" | "supportsUsageInStreaming" | "maxTokensField">
> {
  const api = (provider.api ?? "").toLowerCase();
  const usesChatCompletions = api === "openai" || api === "openai-completions";

  return {
    supportsDeveloperRole: usesChatCompletions && isOfficialOpenAIBaseUrl(provider.baseUrl),
    supportsUsageInStreaming: true,
    maxTokensField: "max_tokens",
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
 * `api` is emitted ONLY when the model overrides the provider. pi resolves
 * `modelDef.api ?? providerConfig.api`, so an absent key is exactly equivalent
 * to the provider value — while emitting an empty string would be actively
 * harmful: pi's `if (!api) continue` drops such a model from the registry
 * entirely, surfacing as "model not found" rather than a protocol error.
 * Omitting on inherit makes that state unreachable by construction, and keeps
 * settings.json following a later provider-level api_type change.
 *
 * `compat` is derived from the EFFECTIVE api, not the provider's: compat
 * describes the wire protocol (`supportsDeveloperRole` keys off
 * chat-completions, `maxTokensField` is protocol-shaped), so once `api` is
 * per-model, compat is per-model by definition.
 */
export function buildProviderModelDescriptor(
  row: ProviderModelRow,
  provider: ProviderCompatInput,
) {
  const { api, isOverride } = resolveModelApi(row, provider);
  return {
    id: row.model_id,
    name: row.name ?? row.model_id,
    ...(isOverride ? { api } : {}),
    reasoning: !!row.reasoning,
    input: (row.vision ? ["text", "image"] : ["text"]) as string[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    compat: defaultProviderModelCompat({ api, baseUrl: provider.baseUrl }),
  };
}
