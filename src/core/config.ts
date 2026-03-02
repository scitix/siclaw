/**
 * Unified configuration loader for AgentBox / TUI.
 *
 * All configuration is read from `.siclaw/config/settings.json`.
 * Zero process.env reads — everything comes from the file with sensible defaults.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderModelCompat {
  supportsDeveloperRole?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: string;
  thinkingFormat?: string;
}

export interface ProviderModelConfig {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: ProviderModelCompat;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  api?: string;
  authHeader?: boolean;
  models: ProviderModelConfig[];
}

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

export interface SiclawConfig {
  providers: Record<string, ProviderConfig>;
  default?: { provider: string; modelId: string };
  embedding?: EmbeddingConfig;
  paths: { userDataDir: string; skillsDir: string; credentialsDir: string };
  server: { port: number; gatewayUrl: string };
  debugImage: string;
  allowedTools: string[] | null;
  mcpServers: Record<string, unknown>;
  debug: boolean;
  userId: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: SiclawConfig = {
  providers: {},
  paths: {
    userDataDir: ".siclaw/user-data",
    skillsDir: "skills",
    credentialsDir: ".siclaw/credentials",
  },
  server: { port: 3000, gatewayUrl: "" },
  debugImage: "busybox:latest",
  allowedTools: null,
  mcpServers: {},
  debug: false,
  userId: "default",
};

// ---------------------------------------------------------------------------
// Deep merge utility
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(override)) {
    const baseVal = result[key];
    const overVal = override[key];
    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overVal);
    } else {
      result[key] = overVal;
    }
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// Singleton cache
// ---------------------------------------------------------------------------

let cached: SiclawConfig | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the path to settings.json.
 * Looks for `.siclaw/config/settings.json` relative to cwd.
 */
export function getConfigPath(): string {
  return path.resolve(process.cwd(), ".siclaw", "config", "settings.json");
}

/**
 * Load configuration from `.siclaw/config/settings.json`, merging with defaults.
 * Result is cached — subsequent calls return the same object.
 */
export function loadConfig(): SiclawConfig {
  if (cached) return cached;

  const configPath = getConfigPath();
  let fileConfig: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (err) {
      console.warn(`[config] Failed to parse ${configPath}:`, err);
    }
  }

  cached = deepMerge(DEFAULTS as unknown as Record<string, unknown>, fileConfig) as unknown as SiclawConfig;
  return cached;
}

/**
 * Force-reload configuration from disk (clears the cache).
 */
export function reloadConfig(): SiclawConfig {
  cached = null;
  return loadConfig();
}

/**
 * Overwrite the settings.json file on disk and reload the cache.
 */
export function writeConfig(config: SiclawConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  cached = null;
}

/**
 * Get the resolved default LLM provider + model.
 *
 * Resolution order:
 * 1. `config.default.provider` / `config.default.modelId` if set
 * 2. First provider's first model
 *
 * Returns null if no providers are configured.
 */
export function getDefaultLlm(): { baseUrl: string; apiKey: string; authHeader: boolean; api: string; model: ProviderModelConfig } | null {
  const config = loadConfig();
  const providerEntries = Object.entries(config.providers);
  if (providerEntries.length === 0) return null;

  let providerName: string;
  let modelId: string | undefined;

  if (config.default?.provider) {
    providerName = config.default.provider;
    modelId = config.default.modelId;
  } else {
    providerName = providerEntries[0][0];
  }

  const provider = config.providers[providerName];
  if (!provider || provider.models.length === 0) return null;

  const model = modelId
    ? provider.models.find((m) => m.id === modelId) ?? provider.models[0]
    : provider.models[0];

  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    authHeader: provider.authHeader ?? true,
    api: provider.api ?? "openai-completions",
    model,
  };
}

/**
 * Get embedding configuration.
 *
 * Falls back to the default provider's apiKey if `embedding.apiKey` is empty.
 * Returns null if no embedding config and no default provider.
 */
export function getEmbeddingConfig(): EmbeddingConfig | null {
  const config = loadConfig();

  const baseUrl = config.embedding?.baseUrl ?? "";
  const model = config.embedding?.model ?? "BAAI/bge-m3";
  const dimensions = config.embedding?.dimensions ?? 1024;

  // apiKey: explicit embedding key → default provider key → empty
  let apiKey = config.embedding?.apiKey ?? "";
  if (!apiKey) {
    const defaultLlm = getDefaultLlm();
    if (defaultLlm) apiKey = defaultLlm.apiKey;
  }

  // If no baseUrl and no apiKey, embeddings are effectively unconfigured
  if (!baseUrl && !apiKey) return null;

  return { baseUrl, apiKey, model, dimensions };
}
