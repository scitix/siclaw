/**
 * Internal API handlers for AgentBox consumption (Port 3002 mTLS).
 *
 * Runtime no longer accesses the database directly. All data queries
 * are proxied through Portal via FrontendWsClient RPC.
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
import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { CertificateIdentity } from "./security/cert-manager.js";
import { sessionRegistry } from "./session-registry.js";
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
 * Fetch agent resource bindings from Portal via RPC.
 * Returns skill_ids and mcp_server_ids bound to the agent.
 */
async function fetchAgentResources(
  frontendClient: FrontendWsClient,
  orgId: string,
  agentId: string,
): Promise<{ skillIds: string[]; mcpServerIds: string[]; isProduction: boolean }> {
  try {
    const data = await frontendClient.request("config.getResources", {
      agentId,
      orgId,
    });
    return {
      skillIds: data.skill_ids ?? [],
      mcpServerIds: data.mcp_server_ids ?? [],
      isProduction: data.is_production ?? true,
    };
  } catch (err) {
    console.warn("[internal-api] Error fetching agent resources:", err);
    return { skillIds: [], mcpServerIds: [], isProduction: true };
  }
}

/**
 * GET /api/internal/settings
 *
 * Proxies to Portal via RPC to get the agent's bound provider + models.
 */
export async function handleSettings(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const data = await frontendClient.request("config.getSettings", {
      agentId: identity.agentId,
      orgId: identity.orgId,
    });
    sendJson(res, 200, data);
  } catch (err) {
    console.error("[internal-api] settings error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/mcp-servers
 *
 * Returns MCP server configs bound to the agent.
 * Fetches binding via RPC, then queries MCP details via RPC.
 */
export async function handleMcpServers(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const { mcpServerIds } = await fetchAgentResources(frontendClient, identity.orgId, identity.agentId);

    if (mcpServerIds.length === 0) {
      sendJson(res, 200, { mcpServers: {} });
      return;
    }

    const data = await frontendClient.request("config.getMcpServers", {
      ids: mcpServerIds,
    });
    sendJson(res, 200, { mcpServers: data.mcpServers });
  } catch (err) {
    console.error("[internal-api] mcp-servers error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/skills/bundle
 *
 * Returns a skill bundle for the agent via RPC.
 */
export async function handleSkillsBundle(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const { skillIds, isProduction } = await fetchAgentResources(frontendClient, identity.orgId, identity.agentId);

    const data = await frontendClient.request("config.getSkillBundle", {
      skill_ids: skillIds,
      is_production: isProduction,
    });
    sendJson(res, 200, data);
  } catch (err) {
    console.error("[internal-api] skills/bundle error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/knowledge/bundle
 *
 * Returns the active LLM wiki packages bound to this agent via RPC.
 */
export async function handleKnowledgeBundle(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const data = await frontendClient.request("config.getKnowledgeBundle", {
      agentId: identity.agentId,
    });
    sendJson(res, 200, data);
  } catch (err) {
    console.error("[internal-api] knowledge/bundle error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/agent-tasks
 *
 * Returns the scheduled tasks for the agent identified by the mTLS certificate.
 */
export async function handleAgentTasksList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    // Session may be threaded via query param for GET; resolve → userId for audit.
    const sessionId = new URL(req.url || "/", "http://_").searchParams.get("session_id") ?? "";
    const userId = sessionRegistry.resolveUser(sessionId);
    const data = await frontendClient.request("task.list", {
      agent_id: identity.agentId,
      user_id: userId,
    });

    const tasks = (data.tasks as any[]).map((row: any) => ({
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
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const body = await readJsonBody(req) as {
      name?: string;
      description?: string;
      schedule?: string;
      prompt?: string;
      status?: "active" | "paused";
      session_id?: string;
    };
    if (!body.name || !body.schedule || !body.prompt) {
      sendJson(res, 400, { error: "name, schedule, prompt are required" });
      return;
    }
    const invalid = validateSchedule(body.schedule);
    if (invalid) { sendJson(res, 400, { error: invalid }); return; }

    const userId = sessionRegistry.resolveUser(body.session_id);
    const data = await frontendClient.request("task.create", {
      id: randomUUID(),
      agent_id: identity.agentId,
      user_id: userId,
      name: body.name,
      description: body.description ?? null,
      schedule: body.schedule,
      prompt: body.prompt,
      status: body.status ?? "active",
    });
    sendJson(res, 201, data);
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
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const body = await readJsonBody(req) as Record<string, unknown>;
    if (typeof body.schedule === "string" && body.schedule.length > 0) {
      const invalid = validateSchedule(body.schedule);
      if (invalid) { sendJson(res, 400, { error: invalid }); return; }
    }

    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    const userId = sessionRegistry.resolveUser(sessionId);
    const data = await frontendClient.request("task.update", {
      task_id: taskId,
      agent_id: identity.agentId,
      user_id: userId,
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      schedule: typeof body.schedule === "string" ? body.schedule : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
    });
    sendJson(res, data.error ? 404 : 200, data);
  } catch (err) {
    console.error("[internal-api] agent-tasks update error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * DELETE /api/internal/agent-tasks/:id
 */
export async function handleAgentTasksDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  taskId: string,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const sessionId = new URL(req.url || "/", "http://_").searchParams.get("session_id") ?? "";
    const userId = sessionRegistry.resolveUser(sessionId);
    const data = await frontendClient.request("task.delete", {
      task_id: taskId,
      agent_id: identity.agentId,
      user_id: userId,
    });
    sendJson(res, data.error ? 404 : 200, data);
  } catch (err) {
    console.error("[internal-api] agent-tasks delete error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}
