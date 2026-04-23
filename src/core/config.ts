/**
 * Unified configuration loader for AgentBox / TUI.
 *
 * LLM provider config (API key, base URL, models) is stored exclusively in
 * settings.json — environment variables are NOT used for sensitive credentials.
 * Deployment env vars (SICLAW_CONFIG_DIR, SICLAW_AGENTBOX_PORT, etc.) are
 * still supported for infrastructure/container orchestration.
 */

import fs from "node:fs";
import path from "node:path";

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
  paths: { userDataDir: string; skillsDir: string; credentialsDir: string; reposDir: string; docsDir: string; knowledgeDir: string };
  server: { port: number; gatewayUrl: string };
  debugImage: string;
  debugNamespace: string;
  debugPodTTL: number;
  /** Idle timeout before cached debug pods are evicted, in seconds. */
  debugPodIdleTimeout: number;
  allowedTools: string[] | null;
  mcpServers: Record<string, unknown>;
  metrics?: { port?: number; token?: string; includeUserId?: boolean };
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
    reposDir: ".siclaw/repos",
    docsDir: ".siclaw/docs",
    knowledgeDir: ".siclaw/knowledge",
  },
  server: { port: 3000, gatewayUrl: "" },
  debugImage: "busybox:1.36",
  debugNamespace: "default",
  debugPodTTL: 600,
  debugPodIdleTimeout: 60,
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
/**
 * Portal snapshot override — when set (typically by cli-main.ts right after
 * fetching from a running local Portal), these fields take precedence over
 * whatever settings.json has for the same keys. Set to null to clear.
 *
 * This is how CLI mode "inherits" Portal's configuration without having to
 * materialise a settings.json file: the snapshot lives only in memory for
 * the duration of the session.
 */
let snapshotOverride: {
  providers?: SiclawConfig["providers"];
  default?: SiclawConfig["default"];
  mcpServers?: SiclawConfig["mcpServers"];
} | null = null;

export function setPortalSnapshot(
  override: {
    providers?: SiclawConfig["providers"];
    default?: SiclawConfig["default"];
    mcpServers?: SiclawConfig["mcpServers"];
  } | null,
): void {
  snapshotOverride = override;
  cached = null;  // next loadConfig() will reapply the override
}

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

  // Apply Portal snapshot overrides AFTER file merge so Portal state wins.
  if (snapshotOverride) {
    if (snapshotOverride.providers && Object.keys(snapshotOverride.providers).length > 0) {
      cached.providers = snapshotOverride.providers;
    }
    if (snapshotOverride.default) {
      cached.default = snapshotOverride.default;
    }
    if (snapshotOverride.mcpServers && Object.keys(snapshotOverride.mcpServers).length > 0) {
      cached.mcpServers = snapshotOverride.mcpServers;
    }
  }

  // Environment variable overrides (deployment/infrastructure only — NOT LLM config)
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
  if (process.env.SICLAW_REPOS_DIR) {
    cached.paths.reposDir = process.env.SICLAW_REPOS_DIR;
  }
  if (process.env.SICLAW_DOCS_DIR) {
    cached.paths.docsDir = process.env.SICLAW_DOCS_DIR;
  }
  if (process.env.SICLAW_GATEWAY_URL) {
    cached.server.gatewayUrl = process.env.SICLAW_GATEWAY_URL;
  }
  if (process.env.SICLAW_DEBUG_NAMESPACE) {
    cached.debugNamespace = process.env.SICLAW_DEBUG_NAMESPACE;
  }
  if (process.env.SICLAW_DEBUG_POD_TTL) {
    const v = parseInt(process.env.SICLAW_DEBUG_POD_TTL, 10);
    if (!isNaN(v)) cached.debugPodTTL = v;
  }
  // Idle timeout in seconds (matches debugPodTTL unit)
  if (process.env.SICLAW_DEBUG_POD_IDLE_TIMEOUT) {
    const v = parseInt(process.env.SICLAW_DEBUG_POD_IDLE_TIMEOUT, 10);
    if (!isNaN(v)) cached.debugPodIdleTimeout = v;
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
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
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
    warnings.push("No LLM providers configured. Use /setup → Models to configure.");
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
      `Use /setup → Models to configure.`,
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
