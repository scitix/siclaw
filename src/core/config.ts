/**
 * Unified configuration loader for AgentBox / TUI.
 *
 * Configuration is read from `.siclaw/config/settings.json` with support for:
 * - `$VAR` / `${VAR}` env-var references in apiKey / baseUrl fields
 * - `SICLAW_LLM_*` runtime env-var overrides (highest priority)
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
// Environment variable reference resolution
// ---------------------------------------------------------------------------

/**
 * Expand `$VAR` and `${VAR}` references in a string to their process.env values.
 * Unset variables resolve to "" with a console warning.
 */
function resolveEnvRef(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, braced, bare) => {
      const name = braced || bare;
      const val = process.env[name];
      if (val === undefined) console.warn(`[config] env ${name} is not set`);
      return val ?? "";
    },
  );
}

/**
 * Returns true if the value contains `$VAR` or `${VAR}` references.
 */
function hasEnvRef(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(value);
}

/**
 * Resolve env-var references in provider apiKey / baseUrl fields,
 * and in the embedding config.
 */
function resolveEnvRefs(config: SiclawConfig): void {
  for (const provider of Object.values(config.providers)) {
    if (provider.apiKey && hasEnvRef(provider.apiKey)) {
      provider.apiKey = resolveEnvRef(provider.apiKey);
    }
    if (provider.baseUrl && hasEnvRef(provider.baseUrl)) {
      provider.baseUrl = resolveEnvRef(provider.baseUrl);
    }
  }
  if (config.embedding) {
    if (config.embedding.apiKey && hasEnvRef(config.embedding.apiKey)) {
      config.embedding.apiKey = resolveEnvRef(config.embedding.apiKey);
    }
    if (config.embedding.baseUrl && hasEnvRef(config.embedding.baseUrl)) {
      config.embedding.baseUrl = resolveEnvRef(config.embedding.baseUrl);
    }
  }
}

/**
 * Apply `SICLAW_LLM_*` environment variable overrides (highest priority).
 *
 * - `SICLAW_LLM_API_KEY`  → overrides the default provider's apiKey
 * - `SICLAW_LLM_BASE_URL` → overrides the default provider's baseUrl
 * - `SICLAW_LLM_MODEL`    → overrides the default modelId
 */
function applySiclawLlmOverrides(config: SiclawConfig): void {
  const envApiKey = process.env.SICLAW_LLM_API_KEY;
  const envBaseUrl = process.env.SICLAW_LLM_BASE_URL;
  const envModel = process.env.SICLAW_LLM_MODEL;

  if (!envApiKey && !envBaseUrl && !envModel) return;

  // Determine the default provider name
  const providerName =
    config.default?.provider ?? Object.keys(config.providers)[0];
  if (!providerName || !config.providers[providerName]) return;

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

  // Resolve $VAR / ${VAR} references in provider & embedding fields
  resolveEnvRefs(cached);

  // SICLAW_LLM_* env overrides — highest priority
  applySiclawLlmOverrides(cached);

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

  // If no baseUrl and no apiKey, embeddings are effectively unconfigured
  if (!baseUrl && !apiKey) return null;

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
      `Set SICLAW_LLM_API_KEY or use "$VAR" syntax in settings.json.`,
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
