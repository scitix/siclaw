import { SCRIPT_MAX_CODE_BYTES, SCRIPT_MAX_INPUT_BYTES, ScriptSandboxError, type ScriptRequest, type ScriptSandboxConfig } from "./types.js";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
}

function strings(value: unknown, max = 32): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(identifier) && new Set(value).size === value.length;
}

export function validateScriptRequest(value: unknown): ScriptRequest {
  if (!record(value) || Object.keys(value).some(k => !["language", "code", "input", "network_isolation", "timeout_seconds", "clusters", "hosts", "mcp"].includes(k))) {
    throw new ScriptSandboxError("Unknown script parameter. Credentials, identities, images and connection addresses are not accepted.");
  }
  if (value.language !== "python" && value.language !== "shell") throw new ScriptSandboxError("language must be python or shell");
  if (typeof value.code !== "string" || !value.code.trim() || Buffer.byteLength(value.code) > SCRIPT_MAX_CODE_BYTES || value.code.includes("\0")) {
    throw new ScriptSandboxError("code must be non-empty and at most 128 KiB");
  }
  if (value.network_isolation !== undefined && typeof value.network_isolation !== "boolean") throw new ScriptSandboxError("network_isolation must be a boolean");
  if (value.timeout_seconds !== undefined && (!Number.isSafeInteger(value.timeout_seconds) || (value.timeout_seconds as number) < 1)) throw new ScriptSandboxError("timeout_seconds must be a positive integer");
  let input: string;
  try { input = JSON.stringify(value.input ?? null); } catch { throw new ScriptSandboxError("input must be JSON"); }
  if (Buffer.byteLength(input) > SCRIPT_MAX_INPUT_BYTES) throw new ScriptSandboxError("input exceeds 128 KiB");
  if (value.hosts !== undefined && !strings(value.hosts)) throw new ScriptSandboxError("hosts must contain at most 32 distinct registered names");
  if (value.clusters !== undefined) {
    const entries = value.clusters;
    if (!Array.isArray(entries) || entries.length > 32 || entries.some(e => !record(e) ||
      Object.keys(e).some(k => k !== "name") || !identifier(e.name))) {
      throw new ScriptSandboxError("Invalid clusters scope; provide registered names only. Namespace and resource permissions are enforced by the built-in tools and the cluster credential's RBAC.");
    }
    if (new Set(entries.map(e => e.name)).size !== entries.length) throw new ScriptSandboxError("Duplicate clusters scope");
  }
  if (value.mcp !== undefined) {
    const entries = value.mcp;
    if (!Array.isArray(entries) || entries.length > 32 || entries.some(e => !record(e) || Object.keys(e).some(k => k !== "server" && k !== "tools") || !identifier(e.server) || !strings(e.tools) || e.tools.length === 0)) {
      throw new ScriptSandboxError("Invalid mcp scope; provide registered names and non-empty explicit tools");
    }
    if (new Set(entries.map(e => e.server)).size !== entries.length) throw new ScriptSandboxError("Duplicate mcp scope");
  }
  return value as unknown as ScriptRequest;
}

export function resolveScriptLimits(request: ScriptRequest, config: ScriptSandboxConfig): { isolated: boolean; timeout: number } {
  return {
    isolated: config.requireNetworkIsolation || (request.network_isolation ?? config.networkIsolation),
    timeout: Math.min(request.timeout_seconds ?? 60, config.maxTimeoutSeconds),
  };
}
