/**
 * Portal snapshot client — TUI-side.
 *
 * When `siclaw local` is running on the same machine, `siclaw` (TUI) probes
 * `http://127.0.0.1:<port>/api/health` and, if up, fetches
 * `GET /api/v1/cli-snapshot` to get the Portal's current config snapshot
 * (providers / default model / MCP servers).
 *
 * Auth: the TUI reads `.siclaw/local-secrets.json` to get the Portal's
 * `jwtSecret`, then self-signs a short-lived admin JWT. The trust boundary
 * is "whoever can read the secrets file can call the snapshot endpoint" —
 * this is correct for local single-user mode and degrades safely when the
 * secrets file is absent (no Portal running locally).
 *
 * Silent degradation: any failure — file missing, Portal unreachable, HTTP
 * error, JWT malformed — returns `null`, and the TUI continues with its
 * settings.json-based loadConfig() path unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import type {
  CliSnapshotSkill,
  CliSnapshotKnowledgeRepo,
  CliSnapshotCredentials,
  CliSnapshotAgentMeta,
  CliSnapshotActiveAgent,
} from "../portal/cli-snapshot-api.js";

export interface PortalSnapshot {
  providers: Record<string, {
    baseUrl: string;
    apiKey: string;
    api: string;
    authHeader: boolean;
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
      input: string[];
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
      compat: { supportsDeveloperRole: boolean; supportsUsageInStreaming: boolean; maxTokensField: string };
    }>;
  }>;
  default: { provider: string; modelId: string } | null;
  mcpServers: Record<string, unknown>;
  skills: CliSnapshotSkill[];
  knowledge: CliSnapshotKnowledgeRepo[];
  credentials: CliSnapshotCredentials;
  availableAgents: CliSnapshotAgentMeta[];
  activeAgent: CliSnapshotActiveAgent | null;
  generatedAt: string;
  /** Augmented client-side for /ls display. Not sent by server. */
  portalUrl?: string;
}

interface LocalSecrets {
  jwtSecret: string;
  runtimeSecret: string;
  portalSecret: string;
}

const DEFAULT_PORTAL_PORT = 3000;
const PROBE_TIMEOUT_MS = 1500;
const FETCH_TIMEOUT_MS = 3000;

/**
 * Try to load a Portal snapshot. Returns null (silently) if anything goes
 * wrong — caller should fall through to settings.json.
 */
export interface TryLoadPortalSnapshotOpts {
  /** Override cwd for secrets discovery (tests). */
  cwd?: string;
  /** Override Portal port (env `SICLAW_PORTAL_PORT` takes precedence). */
  port?: number;
  /**
   * Scope the snapshot to a specific agent (by name). Returns `{ errorKind:
   * "agent-not-found", availableAgents }` via the out param when the name
   * doesn't exist — caller prints a friendly list.
   */
  agent?: string;
}

export type PortalSnapshotError =
  | { kind: "agent-not-found"; requested: string; available: string[] }
  | { kind: "portal-unreachable" }
  | { kind: "auth-failed"; status: number }
  | { kind: "no-secrets" };

export async function tryLoadPortalSnapshot(opts?: TryLoadPortalSnapshotOpts): Promise<PortalSnapshot | null> {
  const result = await loadPortalSnapshotDetailed(opts);
  return result.snapshot;
}

/**
 * Cheap reachability probe: does `.siclaw/local-secrets.json` exist in cwd and
 * is the Portal answering `/api/health`? Skips the full snapshot fetch — used
 * by the first-run wizard to decide whether to recommend Portal-based setup.
 */
export async function probeLocalPortal(opts?: { cwd?: string; port?: number }): Promise<{ url: string } | null> {
  const cwd = opts?.cwd ?? process.cwd();
  const port = Number(process.env.SICLAW_PORTAL_PORT) || opts?.port || DEFAULT_PORTAL_PORT;
  const secretsPath = path.resolve(cwd, ".siclaw/local-secrets.json");
  if (!readSecrets(secretsPath)) return null;
  const url = `http://127.0.0.1:${port}`;
  const healthy = await probeHealth(`${url}/api/health`);
  return healthy ? { url } : null;
}

export async function loadPortalSnapshotDetailed(opts?: TryLoadPortalSnapshotOpts): Promise<{
  snapshot: PortalSnapshot | null;
  error: PortalSnapshotError | null;
}> {
  const cwd = opts?.cwd ?? process.cwd();
  const port = Number(process.env.SICLAW_PORTAL_PORT) || opts?.port || DEFAULT_PORTAL_PORT;

  const secretsPath = path.resolve(cwd, ".siclaw/local-secrets.json");
  const secrets = readSecrets(secretsPath);
  if (!secrets) return { snapshot: null, error: { kind: "no-secrets" } };

  const baseUrl = `http://127.0.0.1:${port}`;

  // Step 1: cheap health probe so we fail fast if Portal isn't running.
  const healthy = await probeHealth(`${baseUrl}/api/health`);
  if (!healthy) return { snapshot: null, error: { kind: "portal-unreachable" } };

  // Step 2: sign a short-lived JWT using the Portal's jwtSecret.
  const token = jwt.sign(
    { sub: "cli-local", username: "cli-local", role: "admin" },
    secrets.jwtSecret,
    { expiresIn: "5m" },
  );

  // Step 3: fetch snapshot (optionally scoped to an agent).
  const url = opts?.agent
    ? `${baseUrl}/api/v1/cli-snapshot?agent=${encodeURIComponent(opts.agent)}`
    : `${baseUrl}/api/v1/cli-snapshot`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404 && opts?.agent) {
      // Server returned a 404 with `availableAgents` — surface structured.
      const body = (await res.json().catch(() => ({}))) as { availableAgents?: string[] };
      return {
        snapshot: null,
        error: { kind: "agent-not-found", requested: opts.agent, available: body.availableAgents ?? [] },
      };
    }
    if (!res.ok) {
      console.warn(`[portal-snapshot] Portal responded ${res.status} — falling back to settings.json`);
      return { snapshot: null, error: { kind: "auth-failed", status: res.status } };
    }
    const payload = (await res.json()) as PortalSnapshot;
    payload.portalUrl = baseUrl;
    return { snapshot: payload, error: null };
  } catch (err) {
    console.warn("[portal-snapshot] fetch failed, falling back to settings.json:", (err as Error).message);
    return { snapshot: null, error: { kind: "portal-unreachable" } };
  }
}

function readSecrets(filePath: string): LocalSecrets | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (
      typeof raw.jwtSecret === "string" &&
      typeof raw.runtimeSecret === "string" &&
      typeof raw.portalSecret === "string"
    ) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

async function probeHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}
