import { readFileSync, statSync } from "node:fs";

export interface AdapterConfig {
  baseUrl: string;
  agentId: string;
  apiKey: string;
  requestTimeoutMs: number;
  pollIntervalMs: number;
}

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

function loadApiKey(env: NodeJS.ProcessEnv): string {
  const direct = env.SICLAW_A2A_KEY?.trim();
  const keyFile = env.SICLAW_A2A_KEY_FILE?.trim();
  if (direct && keyFile) {
    throw new ConfigError("Set only one of SICLAW_A2A_KEY or SICLAW_A2A_KEY_FILE");
  }
  if (keyFile) return loadKeyFromFile(keyFile);
  if (direct) return direct;
  throw new ConfigError("SICLAW_A2A_KEY or SICLAW_A2A_KEY_FILE is required");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const agentId = required(env, "SICLAW_AGENT_ID");
  if (Buffer.byteLength(agentId, "utf8") > 255) {
    throw new ConfigError("SICLAW_AGENT_ID must be 255 bytes or less");
  }
  return {
    baseUrl: normalizeBaseUrl(required(env, "SICORE_URL")),
    agentId,
    apiKey: loadApiKey(env),
    requestTimeoutMs: parseBoundedInteger(env, "SICLAW_A2A_TIMEOUT_MS", 30_000, 1_000, 120_000),
    pollIntervalMs: parseBoundedInteger(env, "SICLAW_A2A_POLL_INTERVAL_MS", 3_000, 500, 5_000),
  };
}
