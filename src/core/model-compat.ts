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
