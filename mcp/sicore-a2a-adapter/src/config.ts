import { readFileSync, statSync } from "node:fs";

/** One named A2A key. `agentId` is set only when pinned via SICLAW_AGENT_ID on the single-key path. */
export interface NamedKey {
  alias: string;
  apiKey: string;
  agentId?: string;
}

export interface AdapterConfig {
  baseUrl: string;
  keys: NamedKey[];
  requestTimeoutMs: number;
  pollIntervalMs: number;
}

/** Per-key config handed to one SicoreA2aClient after its agent is resolved. */
export interface ResolvedAdapterConfig {
  baseUrl: string;
  agentId: string;
  apiKey: string;
  requestTimeoutMs: number;
  pollIntervalMs: number;
}

export const ALIAS_PATTERN = "^[a-z0-9][a-z0-9_-]{0,31}$";
const ALIAS_RE = new RegExp(ALIAS_PATTERN);
const DEFAULT_ALIAS = "default";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

function parseBoundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("SICORE_URL must be an absolute URL");
  }
  if (url.username || url.password) {
    throw new ConfigError("SICORE_URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new ConfigError("SICORE_URL must not contain a query string or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new ConfigError("SICORE_URL must use HTTPS (HTTP is allowed only for loopback testing)");
  }
  return url.toString().replace(/\/$/, "");
}

function loadKeyFromFile(path: string): string {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new ConfigError("SICLAW_A2A_KEY_FILE could not be read");
  }
  if (!stat.isFile()) throw new ConfigError("SICLAW_A2A_KEY_FILE must point to a regular file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new ConfigError("SICLAW_A2A_KEY_FILE must not be readable or writable by group/others (use chmod 600)");
  }
  let key: string;
  try {
    key = readFileSync(path, "utf8").trim();
  } catch {
    throw new ConfigError("SICLAW_A2A_KEY_FILE could not be read");
  }
  if (!key) throw new ConfigError("SICLAW_A2A_KEY_FILE is empty");
  return key;
}

// The single-key form (SICLAW_A2A_KEY / SICLAW_A2A_KEY_FILE) is the original,
// backward-compatible way to configure exactly one agent. It maps to the
// reserved "default" alias so old configs keep working untouched.
function loadSingleKey(env: NodeJS.ProcessEnv): string | undefined {
  const direct = env.SICLAW_A2A_KEY?.trim();
  const keyFile = env.SICLAW_A2A_KEY_FILE?.trim();
  if (direct && keyFile) {
    throw new ConfigError("Set only one of SICLAW_A2A_KEY or SICLAW_A2A_KEY_FILE");
  }
  if (keyFile) return loadKeyFromFile(keyFile);
  if (direct) return direct;
  return undefined;
}

function parseKeysJson(raw: string): Array<[string, string]> {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new ConfigError('SICLAW_A2A_KEYS must be a JSON object mapping alias to key, e.g. {"sre":"sk-..."}');
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new ConfigError('SICLAW_A2A_KEYS must be a JSON object mapping alias to key, e.g. {"sre":"sk-..."}');
  }
  const entries: Array<[string, string]> = [];
  for (const [alias, value] of Object.entries(obj)) {
    if (typeof value !== "string" || !value.trim()) {
      // Do not echo the value; a malformed key must never surface in an error.
      throw new ConfigError(`SICLAW_A2A_KEYS["${alias}"] must be a non-empty string key`);
    }
    entries.push([alias, value.trim()]);
  }
  if (entries.length === 0) {
    throw new ConfigError("SICLAW_A2A_KEYS must contain at least one alias");
  }
  return entries;
}

function loadKeys(env: NodeJS.ProcessEnv): NamedKey[] {
  const single = loadSingleKey(env);
  const multiRaw = env.SICLAW_A2A_KEYS?.trim();
  const pinnedAgentId = env.SICLAW_AGENT_ID?.trim() || undefined;
  if (pinnedAgentId && Buffer.byteLength(pinnedAgentId, "utf8") > 255) {
    throw new ConfigError("SICLAW_AGENT_ID must be 255 bytes or less");
  }

  const byAlias = new Map<string, NamedKey>();

  if (single !== undefined) {
    // SICLAW_AGENT_ID only pins the default single key. Every SICLAW_A2A_KEYS
    // entry resolves its own agent at startup, so pinning one id there is
    // ambiguous and rejected below.
    byAlias.set(DEFAULT_ALIAS, { alias: DEFAULT_ALIAS, apiKey: single, agentId: pinnedAgentId });
  }

  if (multiRaw) {
    if (pinnedAgentId) {
      throw new ConfigError(
        "SICLAW_AGENT_ID cannot be combined with SICLAW_A2A_KEYS; each named key resolves its own agent",
      );
    }
    for (const [alias, key] of parseKeysJson(multiRaw)) {
      if (!ALIAS_RE.test(alias)) {
        throw new ConfigError(`SICLAW_A2A_KEYS alias "${alias}" is invalid; must match ${ALIAS_PATTERN}`);
      }
      if (byAlias.has(alias)) {
        // The only possible collision is with the "default" single key.
        throw new ConfigError(
          `SICLAW_A2A_KEYS alias "${alias}" collides with the single-key SICLAW_A2A_KEY/SICLAW_A2A_KEY_FILE (reserved as "default"); remove one`,
        );
      }
      byAlias.set(alias, { alias, apiKey: key });
    }
  }

  if (byAlias.size === 0) {
    throw new ConfigError(
      "Configure at least one key via SICLAW_A2A_KEYS, SICLAW_A2A_KEY, or SICLAW_A2A_KEY_FILE",
    );
  }
  return [...byAlias.values()];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  return {
    baseUrl: normalizeBaseUrl(required(env, "SICORE_URL")),
    keys: loadKeys(env),
    requestTimeoutMs: parseBoundedInteger(env, "SICLAW_A2A_TIMEOUT_MS", 30_000, 1_000, 120_000),
    pollIntervalMs: parseBoundedInteger(env, "SICLAW_A2A_POLL_INTERVAL_MS", 3_000, 500, 5_000),
  };
}
