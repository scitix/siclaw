/**
 * Unified configuration loader for AgentBox / TUI.
 *
 * Priority (highest → lowest):
 * 1. Environment variables: SICLAW_API_KEY, SICLAW_BASE_URL, SICLAW_MODEL
 * 2. settings.json (plain values — no $VAR indirection)
 */

import fs from "node:fs";
import path from "node:path";
import { loadMcpServersConfig } from "./mcp-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderModelCompat {
  supportsDeveloperRole?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsToolUse?: boolean;
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
    skillsDir: ".siclaw/skills",
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
// Environment variable overrides
// ---------------------------------------------------------------------------

/**
 * Apply environment variable overrides (highest priority).
 *
 * Supports two naming conventions (shorter takes precedence):
 * - SICLAW_API_KEY  / SICLAW_LLM_API_KEY
 * - SICLAW_BASE_URL / SICLAW_LLM_BASE_URL
 * - SICLAW_MODEL    / SICLAW_LLM_MODEL
 *
 * If env vars are set but no provider exists in settings.json,
 * creates a default provider automatically.
 */
function applyEnvOverrides(config: SiclawConfig): void {
  const envApiKey = process.env.SICLAW_API_KEY ?? process.env.SICLAW_LLM_API_KEY;
  const envBaseUrl = process.env.SICLAW_BASE_URL ?? process.env.SICLAW_LLM_BASE_URL;
  const envModel = process.env.SICLAW_MODEL ?? process.env.SICLAW_LLM_MODEL;

  if (!envApiKey && !envBaseUrl && !envModel) return;

  let providerName = config.default?.provider ?? Object.keys(config.providers)[0];

  // No provider in config — create one from env vars
  if (!providerName || !config.providers[providerName]) {
    providerName = "default";
    config.providers[providerName] = {
      baseUrl: envBaseUrl ?? "",
      apiKey: envApiKey ?? "",
      api: "openai-completions",
      authHeader: true,
      models: [{
        id: envModel ?? "default",
        name: envModel ?? "default",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
        compat: { supportsDeveloperRole: true, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
      }],
    };
    return;
  }

  // Override existing provider fields
  const provider = config.providers[providerName];
  if (envApiKey) provider.apiKey = envApiKey;
  if (envBaseUrl) provider.baseUrl = envBaseUrl;
  if (envModel) {
    if (!config.default) config.default = { provider: providerName, modelId: envModel };
    else config.default.modelId = envModel;
  }
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
 * Uses SICLAW_CONFIG_DIR env var if set, otherwise `.siclaw/config` relative to cwd.
 */
export function getConfigPath(): string {
  if (process.env.SICLAW_CONFIG_DIR) {
    return path.resolve(process.env.SICLAW_CONFIG_DIR, "settings.json");
  }
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

  // Environment variable overrides (highest priority)
  applyEnvOverrides(cached);

  // Environment variable overrides (used by process-spawner / k8s-spawner)
  if (process.env.SICLAW_AGENTBOX_PORT) {
    cached.server.port = parseInt(process.env.SICLAW_AGENTBOX_PORT, 10);
  }
  if (process.env.SICLAW_USER_DATA_DIR) {
    cached.paths.userDataDir = process.env.SICLAW_USER_DATA_DIR;
  }
  if (process.env.SICLAW_SKILLS_DIR) {
    cached.paths.skillsDir = process.env.SICLAW_SKILLS_DIR;
  }
  if (process.env.SICLAW_CREDENTIALS_DIR) {
    cached.paths.credentialsDir = process.env.SICLAW_CREDENTIALS_DIR;
  }
  if (process.env.SICLAW_GATEWAY_URL) {
    cached.server.gatewayUrl = process.env.SICLAW_GATEWAY_URL;
  }

  // Merge MCP servers from SICLAW_MCP_DIR (NFS) or local config
  if (Object.keys(cached.mcpServers).length === 0) {
    const mcpConfig = loadMcpServersConfig();
    if (mcpConfig?.mcpServers) {
      cached.mcpServers = mcpConfig.mcpServers;
    }
  }

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

  // baseUrl is required for embedding API calls; without it, fall back to FTS-only
  if (!baseUrl) return null;

  return { baseUrl, apiKey, model, dimensions };
}

/**
 * Validate LLM configuration and return a list of warning messages.
 * Returns an empty array if everything looks good.
 */
export function validateLlmConfig(): string[] {
  const config = loadConfig();
  const warnings: string[] = [];

  const providerEntries = Object.entries(config.providers);
  if (providerEntries.length === 0) {
    warnings.push("No LLM providers configured. Run `siclaw --setup` or edit .siclaw/config/settings.json.");
    return warnings;
  }

  const defaultProviderName = config.default?.provider ?? providerEntries[0][0];
  const provider = config.providers[defaultProviderName];

  if (!provider) {
    warnings.push(`Default provider "${defaultProviderName}" not found in providers config.`);
    return warnings;
  }

  if (!provider.apiKey) {
    warnings.push(
      `Provider "${defaultProviderName}" has no apiKey. ` +
      `Set SICLAW_API_KEY env var or run \`siclaw --setup\`.`,
    );
  }

  if (!provider.baseUrl) {
    warnings.push(`Provider "${defaultProviderName}" has no baseUrl configured.`);
  }

  if (provider.models.length === 0) {
    warnings.push(`Provider "${defaultProviderName}" has no models configured.`);
  }

  return warnings;
}
