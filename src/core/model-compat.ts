/**
 * Model compatibility auto-inference.
 *
 * When users add models, they shouldn't need to know internal details like
 * thinkingFormat. This module infers compat defaults from model ID and
 * provider base URL patterns.
 *
 * Explicit DB config always takes priority — inference only fills undefined fields.
 */

export interface InferredCompat {
  thinkingFormat?: string;
  maxTokensField?: string;
  supportsDeveloperRole?: boolean;
  supportsUsageInStreaming?: boolean;
}

interface CompatRule {
  /** Match against model ID (case-insensitive) */
  modelPattern?: RegExp;
  /** Match against provider base URL (case-insensitive) */
  urlPattern?: RegExp;
  /** Compat fields to apply when matched */
  compat: InferredCompat;
}

/**
 * Known model/provider patterns and their compat defaults.
 * Order matters — first match wins.
 */
const COMPAT_RULES: CompatRule[] = [
  // Moonshot / Kimi — uses Qwen-style enable_thinking
  {
    modelPattern: /kimi|moonshot/i,
    compat: { thinkingFormat: "qwen", maxTokensField: "max_tokens" },
  },
  {
    urlPattern: /moonshot\.cn|moonshot\.ai/i,
    compat: { thinkingFormat: "qwen", maxTokensField: "max_tokens" },
  },
  // Qwen / DashScope — uses enable_thinking
  {
    modelPattern: /qwen/i,
    compat: { thinkingFormat: "qwen" },
  },
  {
    urlPattern: /dashscope/i,
    compat: { thinkingFormat: "qwen" },
  },
  // DeepSeek — uses OpenAI-style reasoning_effort
  {
    modelPattern: /deepseek/i,
    compat: { thinkingFormat: "openai" },
  },
  {
    urlPattern: /deepseek\.com/i,
    compat: { thinkingFormat: "openai" },
  },
];

/**
 * Infer compat defaults for a model based on its ID and provider base URL.
 * Returns only the fields that should be filled in — caller merges with
 * explicit config (explicit values take priority).
 */
export function inferModelCompat(modelId: string, baseUrl: string): InferredCompat {
  for (const rule of COMPAT_RULES) {
    const modelMatch = !rule.modelPattern || rule.modelPattern.test(modelId);
    const urlMatch = !rule.urlPattern || rule.urlPattern.test(baseUrl);
    // Rule must have at least one pattern, and all specified patterns must match
    if ((rule.modelPattern || rule.urlPattern) && modelMatch && urlMatch) {
      return rule.compat;
    }
  }
  return {};
}

/**
 * Merge inferred compat with explicit (DB) compat.
 * Explicit values always win — inference only fills undefined fields.
 */
export function mergeCompat(
  explicit: Record<string, unknown>,
  modelId: string,
  baseUrl: string,
): Record<string, unknown> {
  const inferred = inferModelCompat(modelId, baseUrl);
  const merged = { ...explicit };
  for (const [key, value] of Object.entries(inferred)) {
    if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}
