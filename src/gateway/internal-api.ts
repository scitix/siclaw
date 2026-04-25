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
import type {
  DelegationAppendMessagePayload,
  DelegationEventPayload,
  DelegationPersistenceEvent,
  DelegationPersistenceResponse,
  DelegationToolUpdatePayload,
  DelegationUpdateMessagePayload,
} from "../shared/delegation-persistence.js";

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
/**
 * Fetch the agent's bound skill/mcp ids from Upstream.
 *
 * Errors are propagated intentionally. An earlier version swallowed every
 * error and returned `{ skillIds: [] }`, which was ambiguous with "agent
 * truly has no skills bound" — any transient RPC failure (WSClient
 * mid-reconnect, Upstream restart, etc.) then caused `handleSkillsBundle` to
 * return an empty bundle, AgentBox wiped `resolved/`, and the pod lost its
 * entire skill set until a manual restart.
 *
 * With the current behaviour, upstream handlers return HTTP 500; AgentBox's
 * reload handler treats that as "leave current state, retry next time" and
 * the materialized `resolved/` is preserved.
 */
async function fetchAgentResources(
  frontendClient: FrontendWsClient,
  orgId: string,
  agentId: string,
): Promise<{ skillIds: string[]; mcpServerIds: string[]; isProduction: boolean }> {
  const data = await frontendClient.request("config.getResources", {
    agentId,
    orgId,
  });
  return {
    skillIds: data.skill_ids ?? [],
    mcpServerIds: data.mcp_server_ids ?? [],
    isProduction: data.is_production ?? true,
  };
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
      // Upstream uses agentId to resolve the caller's org and reject
      // cross-org id requests. Without it, sicore falls back to the WS
      // runtime_id and the org lookup fails ("agent <runtime_id> not found").
      agentId: identity.agentId,
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
      // Upstream uses agentId to resolve the caller's org and reject
      // cross-org skill_id requests. Without it, sicore falls back to the
      // WS runtime_id and the org lookup fails ("agent <runtime_id> not
      // found"), which manifests as repeated `skills/bundle error` in
      // Runtime logs and a fresh AgentBox with no skills materialised.
      agentId: identity.agentId,
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

function maybeJson(metadata: Record<string, unknown> | null | undefined): string | null {
  return metadata != null ? JSON.stringify(metadata) : null;
}

async function appendDelegationMessage(
  frontendClient: FrontendWsClient,
  msg: DelegationAppendMessagePayload,
): Promise<string> {
  const result = await frontendClient.request("chat.appendMessage", {
    session_id: msg.sessionId,
    role: msg.role,
    content: msg.content,
    tool_name: msg.toolName ?? null,
    tool_input: msg.toolInput ?? null,
    metadata: maybeJson(msg.metadata),
    outcome: msg.outcome ?? null,
    duration_ms: msg.durationMs ?? null,
    from_agent_id: msg.fromAgentId ?? null,
    parent_session_id: msg.parentSessionId ?? null,
    delegation_id: msg.delegationId ?? null,
    target_agent_id: msg.targetAgentId ?? null,
  });
  return result.id as string;
}

async function updateDelegationMessage(
  frontendClient: FrontendWsClient,
  msg: DelegationUpdateMessagePayload,
): Promise<void> {
  await frontendClient.request("chat.updateMessage", {
    id: msg.messageId,
    session_id: msg.sessionId,
    content: msg.content,
    tool_name: msg.toolName ?? null,
    tool_input: msg.toolInput ?? null,
    metadata: maybeJson(msg.metadata),
    outcome: msg.outcome ?? null,
    duration_ms: msg.durationMs ?? null,
    delegation_id: msg.delegationId ?? null,
  });
}

async function updateDelegationToolMessage(
  frontendClient: FrontendWsClient,
  msg: DelegationToolUpdatePayload,
): Promise<void> {
  await frontendClient.request("chat.updateDelegationToolMessage", {
    session_id: msg.sessionId,
    tool_name: msg.toolName,
    delegation_id: msg.delegationId,
    content: msg.content,
    metadata: maybeJson(msg.metadata),
    outcome: msg.outcome ?? null,
    duration_ms: msg.durationMs ?? null,
  });
}

async function appendDelegationEvent(
  frontendClient: FrontendWsClient,
  evt: DelegationEventPayload,
): Promise<string> {
  const metadata: Record<string, unknown> = {
    kind: "delegation_event",
    source: "system_notification",
    event_type: `delegation.${evt.status}`,
    delegation_id: evt.delegationId,
    child_session_id: evt.childSessionId,
    target_agent_id: evt.targetAgentId,
    parent_agent_id: evt.parentAgentId,
    status: evt.status,
    capsule: evt.capsule,
    ...(evt.fullSummary ? { full_summary: evt.fullSummary } : {}),
    ...(evt.summaryTruncated != null ? { summary_truncated: evt.summaryTruncated } : {}),
    ...(evt.scope ? { scope: evt.scope } : {}),
    ...(evt.taskIndex != null ? { task_index: evt.taskIndex } : {}),
    ...(evt.totalTasks != null ? { total_tasks: evt.totalTasks } : {}),
    ...(evt.toolCalls != null ? { tool_calls: evt.toolCalls } : {}),
    ...(evt.durationMs != null ? { duration_ms: evt.durationMs } : {}),
    ...(evt.partialSource ? { partial_source: evt.partialSource } : {}),
    ...(evt.interruptedTool ? { interrupted_tool: evt.interruptedTool } : {}),
  };

  return appendDelegationMessage(frontendClient, {
    sessionId: evt.parentSessionId,
    role: "user",
    content: evt.capsule,
    metadata,
    fromAgentId: evt.targetAgentId,
    delegationId: evt.delegationId,
    targetAgentId: evt.targetAgentId,
  });
}

/**
 * POST /api/internal/delegation-events
 *
 * AgentBox-side background delegation runs persist through this Runtime-owned
 * callback. AgentBox must not import Gateway chat repositories directly: in
 * K8s it is a separate pod/process and Runtime owns the Portal RPC connection.
 */
export async function handleDelegationEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const event = await readJsonBody(req) as DelegationPersistenceEvent;
    let response: DelegationPersistenceResponse = { ok: true };

    switch (event.type) {
      case "delegation.ensure_session": {
        await frontendClient.request("chat.ensureSession", {
          session_id: event.sessionId,
          agent_id: event.agentId,
          user_id: event.userId || sessionRegistry.resolveUser(event.sessionId),
          title: event.title,
          preview: event.preview,
          origin: event.origin,
          parent_session_id: event.lineage?.parentSessionId ?? null,
          parent_agent_id: event.lineage?.parentAgentId ?? identity.agentId,
          delegation_id: event.lineage?.delegationId ?? null,
          target_agent_id: event.lineage?.targetAgentId ?? null,
        });
        break;
      }
      case "delegation.append_message": {
        response = { ok: true, id: await appendDelegationMessage(frontendClient, event.message) };
        break;
      }
      case "delegation.update_message": {
        await updateDelegationMessage(frontendClient, event.message);
        break;
      }
      case "delegation.update_tool_message": {
        await updateDelegationToolMessage(frontendClient, event.message);
        break;
      }
      case "delegation.append_event": {
        response = { ok: true, id: await appendDelegationEvent(frontendClient, event.event) };
        break;
      }
      case "delegation.emit_chat_event": {
        frontendClient.emitEvent("chat.event", { sessionId: event.sessionId, event: event.event });
        break;
      }
      default: {
        sendJson(res, 400, { error: "Unknown delegation event type" });
        return;
      }
    }

    sendJson(res, 200, response);
  } catch (err) {
    console.error("[internal-api] delegation-events error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}
