/**
 * Shared provider presets used by both first-run wizard and /setup extension.
 */

import type { ProviderConfig } from "./config.js";

export interface ProviderPreset {
  label: string;
  /** Auto-derived provider name for settings.json key */
  name: string;
  baseUrl: string;
  api: string;
  models: ProviderConfig["models"];
  needsBaseUrl?: boolean;
}

export const PRESETS: ProviderPreset[] = [
  {
    label: "OpenAI (GPT-4o, GPT-4o-mini)",
    name: "openai",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    models: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
        compat: { supportsDeveloperRole: true, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o-mini",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
        compat: { supportsDeveloperRole: true, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
      },
    ],
  },
  {
    label: "Anthropic (Claude Sonnet 4, Claude Opus 4)",
    name: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic",
    models: [
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16000,
        compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
      },
      {
        id: "claude-opus-4-20250514",
        name: "Claude Opus 4",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16000,
        compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
      },
    ],
  },
  {
    label: "Compatible API (Qwen, DeepSeek, Kimi, Ollama, etc.)",
    name: "compatible",
    baseUrl: "",
    api: "openai-completions",
    needsBaseUrl: true,
    models: [
      {
        id: "default",
        name: "Default Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
        compat: { supportsDeveloperRole: true, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
      },
    ],
  },
];
