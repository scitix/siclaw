import type { ProviderModelCompat } from "./config.js";

export interface ProviderCompatInput {
  api?: string | null;
  baseUrl?: string | null;
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
