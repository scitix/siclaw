/**
 * Internal API handlers for AgentBox consumption (Port 3002 mTLS).
 *
 * These endpoints serve data from the Runtime's own DB tables (skills, mcp, models, tasks).
 * For resource bindings (which skills/mcp are bound to an agent), we call the Upstream Adapter.
 *
 * Endpoints:
 *   GET    /api/internal/settings          — model providers + entries
 *   GET    /api/internal/mcp-servers       — MCP config for the agent
 *   GET    /api/internal/skills/bundle     — skill bundle for the agent
 *   GET    /api/internal/agent-tasks       — scheduled tasks for the agent
 *   POST   /api/internal/agent-tasks       — create a task
 *   PUT    /api/internal/agent-tasks/:id   — update a task
 *   DELETE /api/internal/agent-tasks/:id   — delete a task
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import type { RuntimeConfig } from "./config.js";
import type { CertificateIdentity } from "./security/cert-manager.js";
import { validateSchedule } from "../cron/cron-limits.js";

/** Read + JSON-parse an HTTP request body. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

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
 * GET /api/internal/agent-tasks
 *
 * Returns the scheduled tasks for the agent identified by the mTLS certificate.
 * Used by the agent's in-conversation `manage_schedule` tool.
 */
export async function handleAgentTasksList(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
): Promise<void> {
  try {
    const db = getDb();
    // Scope by (agent, user): each AgentBox pod's cert identifies both,
    // matching the REST handler's (agent_id, created_by) tenancy.
    const [rows] = await db.query(
      `SELECT id, name, schedule, status, description, prompt, last_run_at, last_result
       FROM agent_tasks WHERE agent_id = ? AND created_by = ? AND status = 'active'
       ORDER BY created_at`,
      [identity.agentId, identity.userId],
    ) as any;

    const tasks = rows.map((row: any) => ({
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

    sendJson(res, 200, { tasks });
  } catch (err) {
    console.error("[internal-api] agent-tasks list error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * POST /api/internal/agent-tasks
 *
 * Body: { name, description?, schedule, prompt, status? }
 * Creates a task bound to the agent identified by the mTLS certificate.
 */
export async function handleAgentTasksCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
): Promise<void> {
  try {
    const body = await readJsonBody(req) as {
      name?: string;
      description?: string;
      schedule?: string;
      prompt?: string;
      status?: "active" | "paused";
    };
    if (!body.name || !body.schedule || !body.prompt) {
      sendJson(res, 400, { error: "name, schedule, prompt are required" });
      return;
    }
    // Same CRON_LIMITS as the REST path — a compromised agent must not be
    // able to POST here with a sub-minute schedule and bypass the UI check.
    const invalid = validateSchedule(body.schedule);
    if (invalid) { sendJson(res, 400, { error: invalid }); return; }
    const id = randomUUID();
    const db = getDb();
    // created_by comes from the mTLS cert's CN so chat-initiated tasks match
    // the same (agent, user) tenancy as UI-created ones.
    await db.query(
      `INSERT INTO agent_tasks (id, agent_id, name, description, schedule, prompt, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, identity.agentId, body.name, body.description ?? null, body.schedule, body.prompt, body.status ?? "active", identity.userId],
    );
    const [rows] = await db.query("SELECT * FROM agent_tasks WHERE id = ?", [id]) as any;
    sendJson(res, 201, rows[0]);
  } catch (err) {
    console.error("[internal-api] agent-tasks create error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * PUT /api/internal/agent-tasks/:id
 *
 * Body: any of { name, description, schedule, prompt, status }
 * Only tasks owned by the agent (mTLS identity) can be updated.
 */
export async function handleAgentTasksUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  taskId: string,
): Promise<void> {
  try {
    const body = await readJsonBody(req) as Record<string, unknown>;
    // If the update carries a schedule, re-validate — otherwise a poisoned
    // agent could UPDATE an existing task to a sub-minute schedule.
    if (typeof body.schedule === "string" && body.schedule.length > 0) {
      const invalid = validateSchedule(body.schedule);
      if (invalid) { sendJson(res, 400, { error: invalid }); return; }
    }
    const db = getDb();
    const [existing] = await db.query(
      "SELECT id FROM agent_tasks WHERE id = ? AND agent_id = ? AND created_by = ?",
      [taskId, identity.agentId, identity.userId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    await db.query(
      `UPDATE agent_tasks SET
         name = COALESCE(?, name),
         description = COALESCE(?, description),
         schedule = COALESCE(?, schedule),
         prompt = COALESCE(?, prompt),
         status = COALESCE(?, status)
       WHERE id = ?`,
      [
        typeof body.name === "string" ? body.name : null,
        typeof body.description === "string" ? body.description : null,
        typeof body.schedule === "string" ? body.schedule : null,
        typeof body.prompt === "string" ? body.prompt : null,
        typeof body.status === "string" ? body.status : null,
        taskId,
      ],
    );
    const [rows] = await db.query("SELECT * FROM agent_tasks WHERE id = ?", [taskId]) as any;
    sendJson(res, 200, rows[0]);
  } catch (err) {
    console.error("[internal-api] agent-tasks update error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * DELETE /api/internal/agent-tasks/:id
 */
export async function handleAgentTasksDelete(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  taskId: string,
): Promise<void> {
  try {
    const db = getDb();
    const [existing] = await db.query(
      "SELECT id FROM agent_tasks WHERE id = ? AND agent_id = ? AND created_by = ?",
      [taskId, identity.agentId, identity.userId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    await db.query("DELETE FROM agent_tasks WHERE id = ?", [taskId]);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error("[internal-api] agent-tasks delete error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}
