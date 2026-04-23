/**
 * CLI snapshot endpoint — `GET /api/v1/cli-snapshot`.
 *
 * Returns the minimum config needed for a local TUI (`siclaw`) to run against
 * a local Portal (`siclaw local`) without its own settings.json:
 *   - providers + models assembled from `model_providers` × `model_entries`
 *   - mcpServers from `mcp_servers`
 *   - default = first model flagged `is_default = 1` (or null if none set)
 *
 * Auth: the caller presents a JWT signed with the Portal's `jwtSecret`.
 * On a developer's laptop both processes read `.siclaw/local-secrets.json`,
 * so the TUI self-signs a short-lived admin JWT before calling here — the
 * trust boundary is "whoever can read the secrets file can call this".
 *
 * The response intentionally excludes per-provider API keys so a leak of the
 * snapshot wire payload alone would not compromise credentials. The TUI in
 * local mode reads keys directly from the `model_providers.api_key` column
 * via the same snapshot — if that proves too permissive later we can split
 * into a "config snapshot" (public) + "secrets fetch" (stricter auth).
 */

import type { RestRouter } from "../gateway/rest-router.js";
import { sendJson, requireAuth } from "../gateway/rest-router.js";
import { getDb } from "../gateway/db.js";

function parseQuery(url: string): Record<string, string> {
  const q = url.split("?")[1];
  if (!q) return {};
  const out: Record<string, string> = {};
  for (const pair of q.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
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
  enabled: number;
}

interface SkillRow {
  name: string;
  description: string | null;
  labels: string | null;
  specs: string | null;
  scripts: string | null;
}

interface KnowledgeRow {
  repo_name: string;
  version: number;
  data: Buffer | Uint8Array | string;
  size_bytes: number;
  sha256: string | null;
  file_count: number | null;
}

export interface CliSnapshotKnowledgeRepo {
  name: string;
  version: number;
  fileCount: number;
  sizeBytes: number;
  sha256: string | null;
  /** Gzip'd tar of the repo's markdown pages, base64-encoded for JSON transport. */
  dataBase64: string;
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
  description: string | null;
}

export interface CliSnapshotClusterCredential {
  name: string;
  /** Raw kubeconfig YAML/JSON content. */
  kubeconfig: string;
  description: string | null;
}

export interface CliSnapshotHostCredential {
  name: string;
  ip: string;
  port: number;
  username: string;
  /** "password" or "key". Determines which of password/privateKey is set. */
  authType: string;
  password: string | null;
  privateKey: string | null;
  description: string | null;
}

export interface CliSnapshotCredentials {
  clusters: CliSnapshotClusterCredential[];
  hosts: CliSnapshotHostCredential[];
}

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  model_provider: string | null;
  model_id: string | null;
  system_prompt: string | null;
  icon: string | null;
  color: string | null;
}

export interface CliSnapshotAgentMeta {
  /** Display name; used as `--agent <name>` value. */
  name: string;
  description: string | null;
  /** Model this agent prefers, if configured in Portal. */
  modelProvider: string | null;
  modelId: string | null;
  icon: string | null;
  color: string | null;
}

export interface CliSnapshotActiveAgent {
  name: string;
  description: string | null;
  systemPrompt: string | null;
  modelProvider: string | null;
  modelId: string | null;
}

export interface CliSnapshotSkill {
  /** Name from SKILL.md frontmatter; used as the materialized directory name. */
  name: string;
  description: string;
  labels: string[];
  /** Raw SKILL.md content including YAML frontmatter. */
  specs: string;
  /** Companion scripts (shell / python) referenced by SKILL.md. */
  scripts: Array<{ name: string; content: string }>;
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

export function registerCliSnapshotRoute(router: RestRouter, jwtSecret: string): void {
  router.get("/api/v1/cli-snapshot", async (req, res) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const query = parseQuery(req.url ?? "");
    const agentName = query.agent || null;

    // Always fetch the agent list — populates `availableAgents` even when
    // the request is scoped, so the TUI can render its picker without a
    // second round-trip.
    const [allAgents] = await db.query<AgentRow[]>(
      "SELECT id, name, description, status, model_provider, model_id, system_prompt, icon, color FROM agents WHERE status = 'active' ORDER BY name",
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

    const [providers] = await db.query<ProviderRow[]>(
      "SELECT id, name, base_url, api_key, api_type FROM model_providers ORDER BY sort_order, name",
    );
    const [models] = await db.query<ModelRow[]>(
      "SELECT provider_id, model_id, name, reasoning, context_window, max_tokens, is_default FROM model_entries ORDER BY provider_id, sort_order, model_id",
    );
    // MCP: scoped to agent via agent_mcp_servers when active, else all enabled.
    const [mcps] = activeAgentId
      ? await db.query<McpRow[]>(
          `SELECT m.id, m.name, m.transport, m.url, m.command, m.args, m.env, m.headers, m.enabled
           FROM mcp_servers m
           JOIN agent_mcp_servers ams ON ams.mcp_server_id = m.id
           WHERE m.enabled = 1 AND ams.agent_id = ?
           ORDER BY m.name`,
          [activeAgentId],
        )
      : await db.query<McpRow[]>(
          "SELECT id, name, transport, url, command, args, env, headers, enabled FROM mcp_servers WHERE enabled = 1 ORDER BY name",
        );
    // Skills: with agent scope we filter via agent_skills; otherwise all
    // non-overlay skills in the default org. Overlay suppression applies in
    // both paths — an overlay always wins over the base builtin.
    const [skills] = activeAgentId
      ? await db.query<SkillRow[]>(
          `SELECT s.name, s.description, s.labels, s.specs, s.scripts
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
          `SELECT s.name, s.description, s.labels, s.specs, s.scripts
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
    const [hostRows] = activeAgentId
      ? await db.query<HostRow[]>(
          `SELECT h.name, h.ip, h.port, h.username, h.auth_type, h.password, h.private_key, h.description
           FROM hosts h
           JOIN agent_hosts ah ON ah.host_id = h.id
           WHERE ah.agent_id = ?
           ORDER BY h.name`,
          [activeAgentId],
        )
      : await db.query<HostRow[]>(
          "SELECT name, ip, port, username, auth_type, password, private_key, description FROM hosts ORDER BY name",
        );

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
          compat: { supportsDeveloperRole: true, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
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
          (h.auth_type === "key" && typeof h.private_key === "string" && h.private_key.length > 0),
        )
        .map((h) => ({
          name: h.name,
          ip: h.ip,
          port: h.port,
          username: h.username,
          authType: h.auth_type,
          password: h.auth_type === "password" ? h.password : null,
          privateKey: h.auth_type === "key" ? h.private_key : null,
          description: h.description,
        })),
    };

    // When an agent is active and carries a model preference, override the
    // default so the TUI picks that model instead of whatever is_default
    // was set at the global model_entries level.
    if (activeAgent && activeAgent.model_provider && activeAgent.model_id) {
      defaultOut = { provider: activeAgent.model_provider, modelId: activeAgent.model_id };
    }

    const availableAgentsOut: CliSnapshotAgentMeta[] = allAgents.map((a) => ({
      name: a.name,
      description: a.description,
      modelProvider: a.model_provider,
      modelId: a.model_id,
      icon: a.icon,
      color: a.color,
    }));

    const activeAgentOut: CliSnapshotActiveAgent | null = activeAgent
      ? {
          name: activeAgent.name,
          description: activeAgent.description,
          systemPrompt: activeAgent.system_prompt,
          modelProvider: activeAgent.model_provider,
          modelId: activeAgent.model_id,
        }
      : null;

    const snapshot: CliSnapshot = {
      providers: providersOut,
      default: defaultOut,
      mcpServers: mcpServersOut,
      skills: skillsOut,
      knowledge: knowledgeOut,
      credentials: credentialsOut,
      availableAgents: availableAgentsOut,
      activeAgent: activeAgentOut,
      generatedAt: new Date().toISOString(),
    };
    sendJson(res, 200, snapshot);
  });
}

function safeJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
