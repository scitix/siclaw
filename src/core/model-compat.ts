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
 * the runtime `input` capability list. Keeping it centralized prevents the
 * descriptor-construction drift that hardcoded `input: ["text"]` causes across
 * the (6+) production paths that hydrate model bindings — a vision model whose
 * `input` was missed would have its image request silently filtered by
 * model-routing's `filterCandidatesForPromptMedia`.
 */
export function buildProviderModelDescriptor(
  row: ProviderModelRow,
  provider: ProviderCompatInput,
) {
  return {
    id: row.model_id,
    name: row.name ?? row.model_id,
    reasoning: !!row.reasoning,
    input: (row.vision ? ["text", "image"] : ["text"]) as string[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    compat: defaultProviderModelCompat({ api: provider.api, baseUrl: provider.baseUrl }),
  };
}
