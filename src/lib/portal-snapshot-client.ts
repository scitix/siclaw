/**
 * Portal snapshot client — TUI-side.
 *
 * When `siclaw local` is running on the same machine, `siclaw` (TUI) probes
 * `http://127.0.0.1:<port>/api/health` and, if up, fetches
 * `GET /api/v1/cli-snapshot` to get the Portal's current config snapshot
 * (providers / default model / MCP servers).
 *
 * Auth: the TUI reads `.siclaw/local-secrets.json` to obtain a dedicated
 * `cliSnapshotSecret` and sends it in the `X-Siclaw-Cli-Snapshot-Secret`
 * header. The secret is separate from `jwtSecret` on purpose — reading the
 * snapshot does not give the caller the ability to self-sign admin JWTs
 * against every other Portal route. The Portal also rejects non-loopback
 * request origins, giving a defence-in-depth backstop if `enableCliSnapshot`
 * ever flips on in a non-local deployment.
 *
 * Silent degradation: any failure — file missing, Portal unreachable, HTTP
 * error, wrong secret — returns `null`, and the TUI continues with its
 * settings.json-based loadConfig() path unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  CliSnapshotSkill,
  CliSnapshotKnowledgeRepo,
  CliSnapshotCredentials,
  CliSnapshotAgentMeta,
  CliSnapshotActiveAgent,
} from "../portal/cli-snapshot-api.js";

const CLI_SNAPSHOT_SECRET_HEADER = "X-Siclaw-Cli-Snapshot-Secret";

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
  /** Absent in older `.siclaw/local-secrets.json` files — caller handles. */
  cliSnapshotSecret?: string;
}

const DEFAULT_PORTAL_PORT = 3000;
const PROBE_TIMEOUT_MS = 1500;
const FETCH_TIMEOUT_MS = 3000;
/**
 * Guard against a misconfigured or hostile Portal that returns an oversized
 * snapshot. Knowledge/credential tars are base64-in-JSON so the inflation
 * factor is ~4/3, but 50 MB of decoded payload is already far more than a
 * reasonable per-session wiki. Beyond this, we refuse to buffer rather than
 * risk OOMing the TUI.
 */
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

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
  if (!secrets.cliSnapshotSecret) {
    // Older `.siclaw/local-secrets.json` files written before the
    // cli-snapshot-secret split — treat as no-secrets so the TUI falls
    // back to settings.json. Re-running `siclaw local` back-fills the
    // new field.
    return { snapshot: null, error: { kind: "no-secrets" } };
  }

  const baseUrl = `http://127.0.0.1:${port}`;

  // Step 1: cheap health probe so we fail fast if Portal isn't running.
  const healthy = await probeHealth(`${baseUrl}/api/health`);
  if (!healthy) return { snapshot: null, error: { kind: "portal-unreachable" } };

  // Step 2: fetch snapshot (optionally scoped to an agent), authenticating
  // with the dedicated cli-snapshot secret. No JWT forging here — see the
  // module header for why the two secrets are kept separate.
  const url = opts?.agent
    ? `${baseUrl}/api/v1/cli-snapshot?agent=${encodeURIComponent(opts.agent)}`
    : `${baseUrl}/api/v1/cli-snapshot`;
  try {
    const res = await fetch(url, {
      headers: { [CLI_SNAPSHOT_SECRET_HEADER]: secrets.cliSnapshotSecret },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Reject oversize responses up-front: if the server advertises a
    // Content-Length beyond the cap, abort before buffering a byte of it.
    const advertised = Number(res.headers.get("content-length"));
    if (Number.isFinite(advertised) && advertised > MAX_SNAPSHOT_BYTES) {
      console.warn(`[portal-snapshot] snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes (advertised=${advertised}) — falling back`);
      return { snapshot: null, error: { kind: "portal-unreachable" } };
    }
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
    // Read with a running byte-count so we stop the moment a chunked response
    // (no Content-Length) crosses the cap — we never let the buffer grow past
    // MAX_SNAPSHOT_BYTES even if the server lies about its size.
    const body = await readBodyWithCap(res, MAX_SNAPSHOT_BYTES);
    if (!body) {
      console.warn(`[portal-snapshot] snapshot exceeded ${MAX_SNAPSHOT_BYTES} bytes mid-stream — falling back`);
      return { snapshot: null, error: { kind: "portal-unreachable" } };
    }
    const payload = JSON.parse(body) as PortalSnapshot;
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

/**
 * Read a Response body as UTF-8 text with a hard byte cap. Returns null as
 * soon as cumulative bytes exceed `maxBytes` (and cancels the stream so we
 * don't keep buffering). Returns the concatenated body on clean completion.
 */
async function readBodyWithCap(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* already closing */ }
        return null;
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
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
