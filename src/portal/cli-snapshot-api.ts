/**
 * CLI snapshot endpoint — `GET /api/v1/cli-snapshot`.
 *
 * Returns the minimum config needed for a local TUI (`siclaw`) to run against
 * a local Portal (`siclaw local`) without its own settings.json:
 *   - providers + models assembled from `model_providers` × `model_entries`
 *   - mcpServers from `mcp_servers`
 *   - default = first model flagged `is_default = 1` (or null if none set)
 *
 * Auth (defence in depth; all three gates must pass):
 *   1. `enableCliSnapshot` must be true at server startup, otherwise the route
 *      isn't registered at all.
 *   2. Request origin must be loopback (`127.0.0.1` / `::1` / `::ffff:127.0.0.1`).
 *      Hardens against accidentally exposing the endpoint over a remote network
 *      if someone flips the flag for debugging.
 *   3. Request must present a matching `X-Siclaw-Cli-Snapshot-Secret` header.
 *      The secret is a dedicated random value in `.siclaw/local-secrets.json`,
 *      not the Portal's `jwtSecret` — so reading the snapshot does NOT also
 *      grant the caller the ability to self-sign admin JWTs and hit every
 *      other admin-gated Portal route.
 *
 * The response contains every provider's api_key, every cluster's kubeconfig,
 * and every host's password / private_key. Any change that broadens how this
 * endpoint can be reached (or who can present the secret) must preserve the
 * "local single-user only" trust boundary.
 */

import type http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { RestRouter } from "../gateway/rest-router.js";
import { sendJson } from "../gateway/rest-router.js";
import { getDb, type Db } from "../gateway/db.js";
import { safeParseJson } from "../gateway/dialect-helpers.js";
import { defaultProviderModelCompat } from "../core/model-compat.js";
import { resolveCapabilities } from "../core/tool-capabilities.js";
import type {
  CliSnapshotKnowledgeRepo,
  CliSnapshotClusterCredential,
  CliSnapshotHostCredential,
  CliSnapshotCredentials,
  CliSnapshotAgentMeta,
  CliSnapshotActiveAgent,
  CliSnapshotSkill,
} from "./cli-snapshot-types.js";
import { safeParseSkillFiles } from "../shared/skill-package.js";
import type { ModelRoutePolicy } from "../core/model-routing.js";
import { resolveSnapshotModelRouting } from "./model-routing-config.js";

export type {
  CliSnapshotKnowledgeRepo,
  CliSnapshotClusterCredential,
  CliSnapshotHostCredential,
  CliSnapshotCredentials,
  CliSnapshotAgentMeta,
  CliSnapshotActiveAgent,
  CliSnapshotSkill,
};

const CLI_SNAPSHOT_SECRET_HEADER = "x-siclaw-cli-snapshot-secret";
const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
// Mirror the client-side cap (see `portal-snapshot-client.ts:MAX_SNAPSHOT_BYTES`).
// The client refuses to buffer more than this; the server matches so a future
// field (e.g. a new bulk-delivered resource) can't silently blow past the
// client cap and surface as a confusing "snapshot exceeds size" fallback on
// the other side. Keep the two constants in lockstep.
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  return addr !== undefined && LOOPBACK_ADDRS.has(addr);
}

/** Constant-time equality for header-provided secrets. */
function secretsMatch(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function parseQuery(url: string): Record<string, string> {
  // The Host part is synthetic — we only need URLSearchParams's parser here.
  const params = new URL(url, "http://x").searchParams;
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string | null;
  api_type: string;
}

interface ModelRow {
  provider_id: string;
  model_id: string;
  name: string | null;
  reasoning: number;
  context_window: number;
  max_tokens: number;
  is_default: number;
}

interface McpRow {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string | null;
  env: string | null;
  headers: string | null;
  description: string | null;
  enabled: number;
}

interface SkillRow {
  name: string;
  description: string | null;
  labels: string | null;
  specs: string | null;
  scripts: string | null;
  files: string | null;
}

interface KnowledgeRow {
  repo_name: string;
  version: number;
  data: Buffer | Uint8Array | string;
  size_bytes: number;
  sha256: string | null;
  file_count: number | null;
}

interface ClusterRow {
  name: string;
  kubeconfig: string | null;
  description: string | null;
}

interface HostRow {
  name: string;
  ip: string;
  port: number;
  username: string;
  auth_type: string;
  password: string | null;
  private_key: string | null;
  passphrase: string | null;
  description: string | null;
  jump_host_id: string | null;
  jump_host_name: string | null;
}

/** Cap a target + up to 3 bastions — mirrors ssh-client MAX_JUMP_DEPTH. */
const SNAPSHOT_MAX_JUMP_DEPTH = 3;

/**
 * Given the agent-bound host rows, append any jump hosts referenced (≤3 hops)
 * that aren't already in the set, so each ProxyJump chain's credentials are
 * present in the snapshot even when the bastion isn't directly bound. Resolves
 * each appended host's own jump_host_name too (for nested chains).
 */
async function expandJumpHosts(db: Db, rows: HostRow[]): Promise<HostRow[]> {
  const byName = new Map<string, HostRow>(rows.map((r) => [r.name, r]));
  // Seed the frontier with bound hosts that reference a jump host.
  let frontier = rows.filter((r) => r.jump_host_id);
  for (let depth = 0; depth < SNAPSHOT_MAX_JUMP_DEPTH && frontier.length > 0; depth++) {
    const ids = Array.from(new Set(frontier.map((r) => r.jump_host_id).filter((id): id is string => !!id)));
    if (ids.length === 0) break;
    const placeholders = ids.map(() => "?").join(", ");
    const [jumpRows] = await db.query<HostRow[]>(
      `SELECT h.name, h.ip, h.port, h.username, h.auth_type, h.password, h.private_key, h.passphrase,
              h.description, h.jump_host_id, hj.name AS jump_host_name
       FROM hosts h LEFT JOIN hosts hj ON h.jump_host_id = hj.id
       WHERE h.id IN (${placeholders})`,
      ids,
    );
    const next: HostRow[] = [];
    for (const jr of jumpRows) {
      if (byName.has(jr.name)) continue;
      byName.set(jr.name, jr);
      if (jr.jump_host_id) next.push(jr);
    }
    frontier = next;
  }
  return Array.from(byName.values());
}

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  model_provider: string | null;
  model_id: string | null;
  model_routing: unknown;
  tool_capabilities: unknown;
  system_prompt: string | null;
  icon: string | null;
  color: string | null;
}

export interface CliSnapshot {
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
  modelRouting?: ModelRoutePolicy;
  mcpServers: Record<string, unknown>;
  skills: CliSnapshotSkill[];
  /** Active versions of each knowledge repo, gzip'd-tar + base64. */
  knowledge: CliSnapshotKnowledgeRepo[];
  /** Cluster kubeconfigs + SSH host credentials. */
  credentials: CliSnapshotCredentials;
  /**
   * ALWAYS populated (even when request is agent-scoped) — lets the TUI
   * render a picker / `siclaw agents` list without a second round-trip.
   */
  availableAgents: CliSnapshotAgentMeta[];
  /** Agent the rest of this snapshot is scoped to, null = global/unscoped view. */
  activeAgent: CliSnapshotActiveAgent | null;
  /** Server-side ISO timestamp so the TUI can display when this was fetched. */
  generatedAt: string;
}

export function registerCliSnapshotRoute(router: RestRouter, cliSnapshotSecret: string): void {
  if (!cliSnapshotSecret) {
    throw new Error("registerCliSnapshotRoute: cliSnapshotSecret is required");
  }
  router.get("/api/v1/cli-snapshot", async (req, res) => {
    // Gate 1: loopback origin only. A rogue / misconfigured Ingress can't
    // reach this endpoint even if `enableCliSnapshot` ever flips on in prod.
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { error: "Forbidden: loopback origin required" });
      return;
    }
    // Gate 2: shared-secret header. Dedicated secret (not jwtSecret) so the
    // caller cannot use the same credential to self-sign admin JWTs against
    // every other admin-gated route.
    const provided = req.headers[CLI_SNAPSHOT_SECRET_HEADER];
    if (typeof provided !== "string" || !secretsMatch(provided, cliSnapshotSecret)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const db = getDb();
    const query = parseQuery(req.url ?? "");
    const agentName = query.agent || null;

    // Always fetch the agent list — populates `availableAgents` even when
    // the request is scoped, so the TUI can render its picker without a
    // second round-trip.
    const [allAgents] = await db.query<AgentRow[]>(
      "SELECT id, name, description, status, model_provider, model_id, model_routing, tool_capabilities, system_prompt, icon, color FROM agents WHERE status = 'active' ORDER BY name",
    );

    // Resolve the scoping agent (if any). Return 404 early so the client
    // can surface a "did you mean..." error with the full list.
    let activeAgent: AgentRow | null = null;
    if (agentName) {
      activeAgent = allAgents.find((a) => a.name === agentName) ?? null;
      if (!activeAgent) {
        sendJson(res, 404, {
          error: `Agent "${agentName}" not found`,
          availableAgents: allAgents.map((a) => a.name),
        });
        return;
      }
    }
    const activeAgentId = activeAgent?.id ?? null;

    // Filter providers with a missing/empty api_key — a provider row that
    // lacks credentials would surface as an "authHeader: true + apiKey: ''"
    // entry, causing the first model call to fail with a cryptic 401 from
    // the upstream provider instead of a clean "no model configured" hint.
    const [providers] = await db.query<ProviderRow[]>(
      "SELECT id, name, base_url, api_key, api_type FROM model_providers WHERE api_key IS NOT NULL AND api_key != '' ORDER BY sort_order, name",
    );
    const [models] = await db.query<ModelRow[]>(
      "SELECT provider_id, model_id, name, reasoning, context_window, max_tokens, is_default FROM model_entries ORDER BY provider_id, sort_order, model_id",
    );
    // MCP: scoped to agent via agent_mcp_servers when active, else all enabled.
    const [mcps] = activeAgentId
      ? await db.query<McpRow[]>(
          `SELECT m.id, m.name, m.transport, m.url, m.command, m.args, m.env, m.headers, m.description, m.enabled
           FROM mcp_servers m
           JOIN agent_mcp_servers ams ON ams.mcp_server_id = m.id
           WHERE m.enabled = 1 AND ams.agent_id = ?
           ORDER BY m.name`,
          [activeAgentId],
        )
      : await db.query<McpRow[]>(
          "SELECT id, name, transport, url, command, args, env, headers, description, enabled FROM mcp_servers WHERE enabled = 1 ORDER BY name",
        );
    // Skills: with agent scope we filter via agent_skills; otherwise all
    // non-overlay skills in the default org. Overlay suppression applies in
    // both paths — an overlay always wins over the base builtin.
    const [skills] = activeAgentId
      ? await db.query<SkillRow[]>(
          `SELECT s.name, s.description, s.labels, s.specs, s.scripts, s.files
           FROM skills s
           JOIN agent_skills ask ON ask.skill_id = s.id
           WHERE s.org_id = ? AND ask.agent_id = ?
             AND (s.is_builtin = 0 OR s.id NOT IN (
               SELECT overlay_of FROM skills
               WHERE org_id = ? AND overlay_of IS NOT NULL
             ))
           ORDER BY s.name`,
          ["default", activeAgentId, "default"],
        )
      : await db.query<SkillRow[]>(
          `SELECT s.name, s.description, s.labels, s.specs, s.scripts, s.files
           FROM skills s
           WHERE s.org_id = ?
             AND (s.is_builtin = 0 OR s.id NOT IN (
               SELECT overlay_of FROM skills
               WHERE org_id = ? AND overlay_of IS NOT NULL
             ))
           ORDER BY s.name`,
          ["default", "default"],
        );
    // Knowledge: agent-scoped via agent_knowledge_repos; else all active.
    const [knowledge] = activeAgentId
      ? await db.query<KnowledgeRow[]>(
          `SELECT r.name AS repo_name, v.version, v.data, v.size_bytes, v.sha256, v.file_count
           FROM knowledge_versions v
           JOIN knowledge_repos r ON r.id = v.repo_id
           JOIN agent_knowledge_repos akr ON akr.repo_id = r.id
           WHERE v.is_active = 1 AND akr.agent_id = ?
           ORDER BY r.name`,
          [activeAgentId],
        )
      : await db.query<KnowledgeRow[]>(
          `SELECT r.name AS repo_name, v.version, v.data, v.size_bytes, v.sha256, v.file_count
           FROM knowledge_versions v
           JOIN knowledge_repos r ON r.id = v.repo_id
           WHERE v.is_active = 1
           ORDER BY r.name`,
        );
    // Credentials: clusters + hosts, agent-scoped via agent_clusters /
    // agent_hosts when active, else all rows with usable material.
    const [clusterRows] = activeAgentId
      ? await db.query<ClusterRow[]>(
          `SELECT c.name, c.kubeconfig, c.description
           FROM clusters c
           JOIN agent_clusters ac ON ac.cluster_id = c.id
           WHERE ac.agent_id = ? AND c.kubeconfig IS NOT NULL AND c.kubeconfig != ''
           ORDER BY c.name`,
          [activeAgentId],
        )
      : await db.query<ClusterRow[]>(
          "SELECT name, kubeconfig, description FROM clusters WHERE kubeconfig IS NOT NULL AND kubeconfig != '' ORDER BY name",
        );
    const HOST_COLS =
      "h.name, h.ip, h.port, h.username, h.auth_type, h.password, h.private_key, h.passphrase, h.description, h.jump_host_id, hj.name AS jump_host_name";
    const [hostRowsRaw] = activeAgentId
      ? await db.query<HostRow[]>(
          `SELECT ${HOST_COLS}
           FROM hosts h
           JOIN agent_hosts ah ON ah.host_id = h.id
           LEFT JOIN hosts hj ON h.jump_host_id = hj.id
           WHERE ah.agent_id = ?
           ORDER BY h.name`,
          [activeAgentId],
        )
      : await db.query<HostRow[]>(
          `SELECT ${HOST_COLS} FROM hosts h LEFT JOIN hosts hj ON h.jump_host_id = hj.id ORDER BY h.name`,
        );
    // When agent-scoped, pull in jump hosts referenced by bound hosts (≤3 hops)
    // so each ProxyJump chain's credentials are present in the snapshot even if
    // the bastion isn't itself bound to the agent.
    const hostRows = activeAgentId
      ? await expandJumpHosts(db, hostRowsRaw)
      : hostRowsRaw;

    // Group models under their provider name.
    const modelsByProviderId = new Map<string, ModelRow[]>();
    for (const m of models) {
      const list = modelsByProviderId.get(m.provider_id);
      if (list) list.push(m);
      else modelsByProviderId.set(m.provider_id, [m]);
    }

    const providersOut: CliSnapshot["providers"] = {};
    let defaultOut: CliSnapshot["default"] = null;

    for (const p of providers) {
      const entries = modelsByProviderId.get(p.id) ?? [];
      providersOut[p.name] = {
        baseUrl: p.base_url,
        apiKey: p.api_key ?? "",
        api: p.api_type,
        authHeader: true,
        models: entries.map((m) => ({
          id: m.model_id,
          name: m.name ?? m.model_id,
          reasoning: Boolean(m.reasoning),
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.context_window,
          maxTokens: m.max_tokens,
          compat: defaultProviderModelCompat({ api: p.api_type, baseUrl: p.base_url }),
        })),
      };
      // First model flagged is_default wins. If none, first provider's first model is a fallback.
      const defaultEntry = entries.find((m) => m.is_default === 1);
      if (defaultEntry && !defaultOut) {
        defaultOut = { provider: p.name, modelId: defaultEntry.model_id };
      }
    }
    if (!defaultOut) {
      const firstProvider = providers[0];
      const firstModel = firstProvider ? modelsByProviderId.get(firstProvider.id)?.[0] : undefined;
      if (firstProvider && firstModel) {
        defaultOut = { provider: firstProvider.name, modelId: firstModel.model_id };
      }
    }

    const mcpServersOut: Record<string, unknown> = {};
    for (const m of mcps) {
      mcpServersOut[m.name] = {
        transport: m.transport,
        ...(m.url ? { url: m.url } : {}),
        ...(m.command ? { command: m.command } : {}),
        ...(m.args ? { args: safeJson(m.args, []) } : {}),
        ...(m.env ? { env: safeJson(m.env, {}) } : {}),
        ...(m.headers ? { headers: safeJson(m.headers, {}) } : {}),
        ...(m.description ? { description: m.description } : {}),
      };
    }

    const skillsOut: CliSnapshotSkill[] = skills
      .filter((s) => typeof s.specs === "string" && s.specs.length > 0)
      .map((s) => ({
        name: s.name,
        description: s.description ?? "",
        labels: safeJson<string[]>(s.labels ?? "", []),
        specs: s.specs!,
        scripts: safeJson<Array<{ name: string; content: string }>>(s.scripts ?? "", []),
        files: safeParseSkillFiles(
          s.files,
          s.specs ?? "",
          safeJson<Array<{ name: string; content: string }>>(s.scripts ?? "", []),
        ),
      }));

    const knowledgeOut: CliSnapshotKnowledgeRepo[] = knowledge.map((k) => {
      // `data` may come back as Buffer (mysql2), Uint8Array (node:sqlite), or
      // string (some driver edge cases). Normalize to Buffer for base64.
      const buf = Buffer.isBuffer(k.data)
        ? k.data
        : typeof k.data === "string"
          ? Buffer.from(k.data, "binary")
          : Buffer.from(k.data);
      return {
        name: k.repo_name,
        version: k.version,
        fileCount: k.file_count ?? 0,
        sizeBytes: k.size_bytes,
        sha256: k.sha256,
        dataBase64: buf.toString("base64"),
      };
    });

    const credentialsOut: CliSnapshotCredentials = {
      clusters: clusterRows
        .filter((c) => typeof c.kubeconfig === "string" && c.kubeconfig.length > 0)
        .map((c) => ({
          name: c.name,
          kubeconfig: c.kubeconfig!,
          description: c.description,
        })),
      hosts: hostRows
        .filter((h) =>
          (h.auth_type === "password" && typeof h.password === "string" && h.password.length > 0) ||
          (h.auth_type === "key" && typeof h.private_key === "string" && h.private_key.length > 0) ||
          // Managed hosts carry no key/password of their own; they're usable as
          // long as they have a jump host to source the key from.
          (h.auth_type === "managed" && typeof h.jump_host_name === "string" && h.jump_host_name.length > 0),
        )
        .map((h) => ({
          name: h.name,
          ip: h.ip,
          port: h.port,
          username: h.username,
          authType: h.auth_type,
          password: h.auth_type === "password" ? h.password : null,
          privateKey: h.auth_type === "key" ? h.private_key : null,
          passphrase: (h.auth_type === "key" || h.auth_type === "managed") ? h.passphrase : null,
          description: h.description,
          jumpHost: h.jump_host_name,
        })),
    };

    // When an agent is active and carries a model preference, override the
    // default so the TUI picks that model instead of whatever is_default
    // was set at the global model_entries level.
    if (activeAgent && activeAgent.model_provider && activeAgent.model_id) {
      defaultOut = { provider: activeAgent.model_provider, modelId: activeAgent.model_id };
    }

    const modelRoutingOut = activeAgent && activeAgent.model_provider && activeAgent.model_id
      ? resolveSnapshotModelRouting(
          activeAgent.model_routing,
          { provider: activeAgent.model_provider, modelId: activeAgent.model_id },
          providersOut,
        )
      : undefined;

    const availableAgentsOut: CliSnapshotAgentMeta[] = allAgents.map((a) => ({
      name: a.name,
      description: a.description,
      modelProvider: a.model_provider,
      modelId: a.model_id,
      icon: a.icon,
      color: a.color,
    }));

    // Resolve the agent's capability groups → concrete allowedTools at this
    // boundary (the AgentBox/TUI stays oblivious to group keys). null/empty =
    // unrestricted; we only emit the field when non-null to keep the payload
    // compact (TUI treats absent as null).
    const allowedToolsOut = activeAgent
      ? resolveCapabilities(safeParseJson<string[] | null>(activeAgent.tool_capabilities, null))
      : null;

    const activeAgentOut: CliSnapshotActiveAgent | null = activeAgent
      ? {
          name: activeAgent.name,
          description: activeAgent.description,
          systemPrompt: activeAgent.system_prompt,
          modelProvider: activeAgent.model_provider,
          modelId: activeAgent.model_id,
          ...(modelRoutingOut ? { modelRouting: modelRoutingOut } : {}),
          ...(allowedToolsOut ? { allowedTools: allowedToolsOut } : {}),
        }
      : null;

    const snapshot: CliSnapshot = {
      providers: providersOut,
      default: defaultOut,
      ...(modelRoutingOut ? { modelRouting: modelRoutingOut } : {}),
      mcpServers: mcpServersOut,
      skills: skillsOut,
      knowledge: knowledgeOut,
      credentials: credentialsOut,
      availableAgents: availableAgentsOut,
      activeAgent: activeAgentOut,
      generatedAt: new Date().toISOString(),
    };

    // Server-side size cap (belt-and-suspenders for the matching client cap).
    // Serialise once, size-check, then write the same string so we don't pay
    // JSON.stringify twice for a happy path response.
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      sendJson(res, 413, {
        error: `Snapshot exceeds ${MAX_SNAPSHOT_BYTES}-byte cap`,
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(serialized);
  });
}

function safeJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
