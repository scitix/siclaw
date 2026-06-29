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
import { normalizeModelRoutePolicy, type ModelRoutePolicy } from "./model-routing.js";

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
  modelRouting?: ModelRoutePolicy;
  embedding?: EmbeddingConfig;
  paths: { userDataDir: string; skillsDir: string; credentialsDir: string; reposDir: string; docsDir: string; knowledgeDir: string };
  server: {
    port: number;
    gatewayUrl: string;
    /**
     * Idle self-destruct window for an AgentBox pod, in seconds. When no SSE
     * connections and no active sessions remain for this long, the pod shuts
     * itself down (K8s mode). Default 300 (5 min). Set to 0 (or negative) to
     * make the pod resident — never auto-destroy. Overridable via
     * SICLAW_AGENTBOX_IDLE_TIMEOUT. Always normalized via normalizeIdleTimeoutSec
     * — positive values below MIN_AGENTBOX_IDLE_SEC (300) are floored to 300; 0
     * stays resident.
     */
    idleTimeoutSec: number;
  };
  debugImage: string;
  debugNamespace: string;
  debugPodTTL: number;
  /** Idle timeout before cached debug pods are evicted, in seconds. */
  debugPodIdleTimeout: number;
  /** Max time a debug pod may take to reach Running before the tool fails fast, in seconds. */
  debugPodStartupTimeout: number;
  allowedTools: string[] | null;
  mcpServers: Record<string, unknown>;
  metrics?: { port?: number; token?: string; includeUserId?: boolean };
  debug: boolean;
  userId: string;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return defaultValue;
}

/**
 * Minimum AgentBox idle self-destruct window, in seconds. A positive window
 * below this floor would churn pods (cold-start + JSONL session restore) every
 * time a user pauses for more than the window between turns. `0` (resident) is
 * the deliberate escape hatch and is NOT floored.
 */
export const MIN_AGENTBOX_IDLE_SEC = 300;

/**
 * Normalize an idle-timeout value (seconds) to the supported range:
 *  - `<= 0`      → `0`   (resident — never auto-destroy; intentional escape hatch)
 *  - `1`..`299`  → `300` (enforce the floor)
 *  - `>= 300`    → itself (floored to an integer)
 *  - invalid / missing → `300` (the default)
 *
 * Applied both where the value is authored (agent-api write) and where it is
 * consumed (loadConfig), so a sub-floor value from ANY source — env var,
 * settings.json, or a legacy DB row written before this floor existed — still
 * resolves to a safe window.
 */
export function normalizeIdleTimeoutSec(v: unknown): number {
  // Unset (null/undefined/"") → default, NOT resident: only an explicit numeric
  // <= 0 opts into resident, so a client that omits the field gets 300.
  if (v === null || v === undefined || v === "") return MIN_AGENTBOX_IDLE_SEC;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return MIN_AGENTBOX_IDLE_SEC; // invalid → default
  if (n <= 0) return 0;                                   // resident (escape hatch)
  return Math.max(MIN_AGENTBOX_IDLE_SEC, n);              // floor
}

export function isMemoryEnabled(): boolean {
  // Off by default — memory (memory_search/memory_get + session auto-save) is an
  // opt-in feature. Enable explicitly via SICLAW_MEMORY_ENABLED=true (helm:
  // runtime.memory.enabled). When the env is unset (local dev, TUI, tests) memory
  // stays disabled so no memory-facing prompt text or tools leak in.
  return parseBooleanEnv(process.env.SICLAW_MEMORY_ENABLED, false);
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
  server: { port: 3000, gatewayUrl: "", idleTimeoutSec: 300 },
  debugImage: "busybox:1.36",
  debugNamespace: "default",
  debugPodTTL: 600,
  debugPodIdleTimeout: 60,
  debugPodStartupTimeout: 60,
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
  modelRouting?: SiclawConfig["modelRouting"];
  mcpServers?: SiclawConfig["mcpServers"];
} | null = null;

export function setPortalSnapshot(
  override: {
    providers?: SiclawConfig["providers"];
    default?: SiclawConfig["default"];
    modelRouting?: SiclawConfig["modelRouting"];
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
    if (snapshotOverride.modelRouting) {
      cached.modelRouting = snapshotOverride.modelRouting;
    }
    if (snapshotOverride.mcpServers && Object.keys(snapshotOverride.mcpServers).length > 0) {
      cached.mcpServers = snapshotOverride.mcpServers;
    }
  }

  cached.modelRouting = normalizeModelRoutePolicy(cached.modelRouting);

  // Environment variable overrides (deployment/infrastructure only — NOT LLM config)
  if (process.env.SICLAW_AGENTBOX_PORT) {
    cached.server.port = parseInt(process.env.SICLAW_AGENTBOX_PORT, 10);
  }
  // AgentBox idle self-destruct window, in seconds. 0 or negative ⇒ resident
  // (never auto-destroy). Invalid values keep the default.
  if (process.env.SICLAW_AGENTBOX_IDLE_TIMEOUT) {
    const v = parseInt(process.env.SICLAW_AGENTBOX_IDLE_TIMEOUT, 10);
    if (!isNaN(v)) cached.server.idleTimeoutSec = v;
  }
  // Enforce the floor on the FINAL value (default / settings.json / env / a
  // sub-300 value injected from a legacy agent row), keeping 0 = resident.
  cached.server.idleTimeoutSec = normalizeIdleTimeoutSec(cached.server.idleTimeoutSec);
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
  // Max seconds to wait for a debug pod to reach Running before failing fast.
  if (process.env.SICLAW_DEBUG_POD_STARTUP_TIMEOUT) {
    const v = parseInt(process.env.SICLAW_DEBUG_POD_STARTUP_TIMEOUT, 10);
    if (!isNaN(v) && v > 0) cached.debugPodStartupTimeout = v;
  }

  // Embedding config via env — infrastructure override for K8s/AgentBox, where
  // there is no settings.json `embedding` section and Portal does not serve one.
  // Each field overrides the file value individually; missing fields keep the
  // file value (or fall back to getEmbeddingConfig()'s defaults). The block is
  // only constructed when at least one var is set, so non-memory deployments are
  // unaffected. `getEmbeddingConfig()` still returns null when baseUrl is empty.
  {
    const envBaseUrl = process.env.SICLAW_EMBEDDING_BASE_URL;
    const envModel = process.env.SICLAW_EMBEDDING_MODEL;
    const envApiKey = process.env.SICLAW_EMBEDDING_API_KEY;
    const envDimensions = process.env.SICLAW_EMBEDDING_DIMENSIONS;
    if (envBaseUrl || envModel || envApiKey || envDimensions) {
      const existing = cached.embedding;
      const parsedDims = envDimensions !== undefined ? parseInt(envDimensions, 10) : NaN;
      cached.embedding = {
        baseUrl: envBaseUrl ?? existing?.baseUrl ?? "",
        apiKey: envApiKey ?? existing?.apiKey ?? "",
        model: envModel ?? existing?.model ?? "BAAI/bge-m3",
        dimensions: !isNaN(parsedDims) && parsedDims > 0 ? parsedDims : existing?.dimensions ?? 1024,
      };
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
 * True when two URLs share scheme + host + port (same trust domain). Used to
 * decide whether the embedding endpoint may inherit the default LLM provider's
 * API key. Malformed/empty URLs ⇒ false (fail closed: never leak the key).
 */
function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    // URL.host already includes the port, so protocol + host == origin.
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

/**
 * Get embedding configuration.
 *
 * apiKey resolution:
 *   1. explicit `embedding.apiKey` (always wins)
 *   2. default LLM provider key — ONLY when the embedding endpoint is the SAME
 *      ORIGIN as that provider (one provider serving both chat and embeddings).
 *
 * Inheriting the LLM key for an *independent* endpoint (the K8s/self-hosted TEI
 * case the SICLAW_EMBEDDING_* env path enables) would ship a high-value
 * credential to a different trust domain as `Authorization: Bearer …`. For a
 * cross-origin endpoint with no explicit key we send none and let
 * "empty = unauthenticated" hold, matching the chart docs.
 *
 * Returns null if no embedding baseUrl is configured.
 */
export function getEmbeddingConfig(): EmbeddingConfig | null {
  const config = loadConfig();

  const baseUrl = config.embedding?.baseUrl ?? "";
  const model = config.embedding?.model ?? "BAAI/bge-m3";
  const dimensions = config.embedding?.dimensions ?? 1024;

  // baseUrl is required for embedding API calls; without it, fall back to FTS-only
  if (!baseUrl) return null;

  let apiKey = config.embedding?.apiKey ?? "";
  if (!apiKey) {
    const defaultLlm = getDefaultLlm();
    if (defaultLlm && sameOrigin(baseUrl, defaultLlm.baseUrl)) {
      apiKey = defaultLlm.apiKey;
    }
  }

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
