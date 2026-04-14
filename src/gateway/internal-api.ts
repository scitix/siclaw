/**
 * Internal API handlers for AgentBox consumption (Port 3002 mTLS).
 *
 * These endpoints serve data from the Runtime's own DB tables (skills, mcp, models, cron).
 * For resource bindings (which skills/mcp are bound to an agent), we call the Upstream Adapter.
 *
 * Endpoints:
 *   GET /api/internal/settings        — model providers + entries
 *   GET /api/internal/mcp-servers     — MCP config for the agent
 *   GET /api/internal/skills/bundle   — skill bundle for the agent
 *   GET /api/internal/cron-list       — cron jobs for the agent
 */

import http from "node:http";
import { getDb } from "./db.js";
import type { RuntimeConfig } from "./config.js";
import type { CertificateIdentity } from "./security/cert-manager.js";

/** Send JSON response helper */
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Fetch agent resource bindings from Upstream Adapter.
 * Returns skill_ids and mcp_server_ids bound to the agent.
 */
async function fetchAgentResources(
  config: RuntimeConfig,
  orgId: string,
  agentId: string,
): Promise<{ skillIds: string[]; mcpServerIds: string[]; isProduction: boolean }> {
  try {
    const url = `${config.serverUrl}/api/internal/siclaw/adapter/agent/${agentId}/resources`;
    const resp = await fetch(url, {
      headers: {
        "X-Auth-Token": config.portalSecret,
        "X-Cert-Org-Id": orgId,
      },
    });
    if (!resp.ok) {
      console.warn(`[internal-api] Failed to fetch agent resources: ${resp.status}`);
      return { skillIds: [], mcpServerIds: [], isProduction: true };
    }
    const data = await resp.json() as { skill_ids?: string[]; mcp_server_ids?: string[]; is_production?: boolean };
    return {
      skillIds: data.skill_ids ?? [],
      mcpServerIds: data.mcp_server_ids ?? [],
      isProduction: data.is_production ?? true, // default to prod for safety
    };
  } catch (err) {
    console.warn("[internal-api] Error fetching agent resources:", err);
    return { skillIds: [], mcpServerIds: [], isProduction: true };
  }
}

/**
 * GET /api/internal/settings
 *
 * Proxies to Portal Adapter to get the agent's bound provider + models.
 * Gateway does not query the database directly — Portal is the source of truth.
 */
export async function handleSettings(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  config: RuntimeConfig,
): Promise<void> {
  try {
    const url = `${config.serverUrl}/api/internal/siclaw/adapter/agent/${identity.agentId}/settings`;
    const resp = await fetch(url, {
      headers: { "X-Auth-Token": config.portalSecret, "X-Cert-Org-Id": identity.orgId },
    });
    const data = await resp.json();
    sendJson(res, resp.status, data);
  } catch (err) {
    console.error("[internal-api] settings error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/mcp-servers
 *
 * Returns MCP server configs bound to the agent.
 * Fetches binding from Upstream Adapter, then queries Siclaw DB for details.
 */
export async function handleMcpServers(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  config: RuntimeConfig,
): Promise<void> {
  try {
    const db = getDb();
    const { mcpServerIds } = await fetchAgentResources(config, identity.orgId, identity.agentId);

    if (mcpServerIds.length === 0) {
      sendJson(res, 200, { mcpServers: {} });
      return;
    }

    // Query MCP servers by IDs
    const placeholders = mcpServerIds.map(() => "?").join(",");
    const [rows] = await db.query(
      `SELECT name, transport, url, command, args, env, headers, enabled
       FROM mcp_servers WHERE id IN (${placeholders}) AND enabled = 1`,
      mcpServerIds,
    ) as any;

    // Convert to the format AgentBox expects: { [name]: { transport, url, command, args, env, headers } }
    const mcpServers: Record<string, unknown> = {};
    for (const row of rows) {
      mcpServers[row.name] = {
        transport: row.transport,
        ...(row.url ? { url: row.url } : {}),
        ...(row.command ? { command: row.command } : {}),
        ...(row.args ? { args: typeof row.args === "string" ? JSON.parse(row.args) : row.args } : {}),
        ...(row.env ? { env: typeof row.env === "string" ? JSON.parse(row.env) : row.env } : {}),
        ...(row.headers ? { headers: typeof row.headers === "string" ? JSON.parse(row.headers) : row.headers } : {}),
      };
    }

    sendJson(res, 200, { mcpServers });
  } catch (err) {
    console.error("[internal-api] mcp-servers error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/skills/bundle
 *
 * Returns a skill bundle for the agent. Fetches binding from Upstream Adapter,
 * then queries Siclaw DB for skill content, and assembles with priority merging.
 */
export async function handleSkillsBundle(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  config: RuntimeConfig,
): Promise<void> {
  try {
    const db = getDb();
    const { skillIds, isProduction } = await fetchAgentResources(config, identity.orgId, identity.agentId);

    let rows: any[];
    if (skillIds.length === 0) {
      rows = [];
    } else if (isProduction) {
      // Prod: only the latest approved version of each bound skill
      const placeholders = skillIds.map(() => "?").join(",");
      const [result] = await db.query(
        `SELECT s.id, s.name, s.labels, sv.specs, sv.scripts
         FROM skills s
         JOIN skill_versions sv ON sv.skill_id = s.id AND sv.is_approved = 1
         WHERE s.id IN (${placeholders})
           AND sv.version = (
             SELECT MAX(sv2.version) FROM skill_versions sv2
             WHERE sv2.skill_id = s.id AND sv2.is_approved = 1
           )`,
        skillIds,
      ) as any;
      rows = result;
    } else {
      // Dev: latest content from skills table (all statuses)
      const placeholders = skillIds.map(() => "?").join(",");
      const [result] = await db.query(
        `SELECT id, name, labels, specs, scripts FROM skills WHERE id IN (${placeholders})`,
        skillIds,
      ) as any;
      rows = result;
    }

    const skills = rows.map((row: any) => ({
      dirName: row.name.replace(/[^a-zA-Z0-9_-]/g, "_"),
      scope: "global",
      specs: row.specs || "",
      scripts: row.scripts ? (typeof row.scripts === "string" ? JSON.parse(row.scripts) : row.scripts) : [],
    }));

    sendJson(res, 200, { version: new Date().toISOString(), skills });
  } catch (err) {
    console.error("[internal-api] skills/bundle error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/cron-list
 *
 * Returns cron jobs for the agent identified by the mTLS certificate.
 */
export async function handleCronList(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
): Promise<void> {
  try {
    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, name, schedule, status, description, prompt, last_run_at, last_result
       FROM cron_jobs WHERE agent_id = ? AND status = 'active'
       ORDER BY created_at`,
      [identity.agentId],
    ) as any;

    const jobs = rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      schedule: row.schedule,
      status: row.status,
      description: row.description,
      prompt: row.prompt,
      lastRunAt: row.last_run_at,
      lastResult: row.last_result,
      agentId: identity.agentId,
    }));

    sendJson(res, 200, { jobs });
  } catch (err) {
    console.error("[internal-api] cron-list error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}
