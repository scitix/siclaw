/**
 * Chat gateway — bridges the frontend (HTTP/SSE) to the Runtime (WebSocket).
 *
 * POST /api/v1/siclaw/agents/:id/chat/send  → SSE streaming (JWT auth, web frontend)
 * POST /api/v1/run                           → synchronous execution (API key auth, external)
 */

import crypto from "node:crypto";
import http from "node:http";
import {
  sendJson,
  parseBody,
  requireAuth,
  type RestRouter,
} from "../gateway/rest-router.js";
import type { ResolvedModelBinding } from "../gateway/agent-model-binding.js";
import { getDb } from "../gateway/db.js";
import {
  ErrorCodes,
  errorBody,
  isErrorDetail,
  type ErrorDetail,
} from "../lib/error-envelope.js";

/** Resolve model binding directly from Portal's own DB. */
async function resolveAgentModelBinding(agentId: string): Promise<ResolvedModelBinding | null> {
  const db = getDb();
  const [agentRows] = await db.query(
    "SELECT model_provider, model_id FROM agents WHERE id = ?",
    [agentId],
  ) as any;
  const agent = agentRows[0] as { model_provider?: string; model_id?: string } | undefined;
  if (!agent?.model_provider || !agent?.model_id) return null;

  const [providerRows] = await db.query(
    "SELECT id, name, base_url, api_key, api_type FROM model_providers WHERE name = ? LIMIT 1",
    [agent.model_provider],
  ) as any;
  const provider = providerRows[0] as
    | { id: string; name: string; base_url: string; api_key: string | null; api_type: string }
    | undefined;
  if (!provider) return null;

  const [entryRows] = await db.query(
    "SELECT model_id, name, reasoning, context_window, max_tokens FROM model_entries WHERE provider_id = ?",
    [provider.id],
  ) as any;
  const models = (entryRows as any[]).map((m: any) => ({
    id: m.model_id,
    name: m.name ?? m.model_id,
    reasoning: !!m.reasoning,
    input: ["text"] as string[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.context_window,
    maxTokens: m.max_tokens,
  }));

  return {
    modelProvider: provider.name,
    modelId: agent.model_id,
    modelConfig: {
      name: provider.name,
      baseUrl: provider.base_url,
      apiKey: provider.api_key ?? "",
      api: provider.api_type,
      authHeader: true,
      models,
    },
  };
}

// ── API key authentication ──────────────────────────────────

interface ApiKeyAuthResult {
  agentId: string;
  keyId: string;
  keyName: string;
  createdBy: string;
}

async function authenticateApiKey(req: http.IncomingMessage): Promise<ApiKeyAuthResult | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer sk-")) return null;

  const plaintext = auth.slice(7);
  const keyHash = crypto.createHash("sha256").update(plaintext).digest("hex");

  const db = getDb();
  const [rows] = await db.query(
    `SELECT id, agent_id, name, expires_at, created_by
     FROM agent_api_keys WHERE key_hash = ? LIMIT 1`,
    [keyHash],
  ) as any;

  if (rows.length === 0) return null;
  const key = rows[0];

  if (key.expires_at && new Date(key.expires_at) < new Date()) return null;

  db.query("UPDATE agent_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [key.id]).catch(() => {});

  return { agentId: key.agent_id, keyId: key.id, keyName: key.name, createdBy: key.created_by };
}
import type { RuntimeConnectionMap } from "./runtime-connection.js";

/** Send an SSE event to the response stream. No-op if the stream is already closed. */
function sseWrite(res: import("node:http").ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerChatRoutes(
  router: RestRouter,
  connectionMap: RuntimeConnectionMap,
  jwtSecret: string,
): void {
  // POST /api/v1/siclaw/agents/:id/chat/send — SSE streaming
  router.post("/api/v1/siclaw/agents/:id/chat/send", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) {
      sendJson(res, 401, errorBody({ code: ErrorCodes.INTERNAL, message: "Authentication required", retriable: false }));
      return;
    }

    const body = await parseBody<{ text?: string; session_id?: string }>(req);
    if (!body.text) {
      sendJson(res, 400, errorBody({ code: ErrorCodes.BAD_REQUEST, message: "text is required", retriable: false }));
      return;
    }

    const agentId = params.id;
    const sessionId = body.session_id ?? crypto.randomUUID();

    if (!connectionMap.isConnected(agentId)) {
      sendJson(res, 503, errorBody({
        code: ErrorCodes.CONNECTION_FAILED,
        message: `Agent runtime is not connected for agent ${agentId}`,
        retriable: true,
      }));
      return;
    }

    // Resolve agent's bound model + provider config from DB
    const modelBinding = await resolveAgentModelBinding(agentId);
    if (!modelBinding) {
      sendJson(res, 400, errorBody({
        code: ErrorCodes.BAD_REQUEST,
        message: "Agent has no model configured, or the bound provider/model was not found",
        retriable: false,
      }));
      return;
    }

    // Set up SSE response
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Subscribe to chat events for this agent, filter by sessionId
    let unsubscribe: (() => void) | null = null;

    function cleanup(): void {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    }

    req.on("close", cleanup);

    unsubscribe = connectionMap.subscribe(agentId, "chat.event", (data: unknown) => {
      const envelope = data as { sessionId?: string; event?: Record<string, unknown> } | undefined;
      if (!envelope?.event) return;
      if (envelope.sessionId && envelope.sessionId !== sessionId) return;

      const evt = envelope.event;

      // Translate stream_error events to a canonical SSE error frame so the
      // frontend handles them via the same code path as RPC-level failures.
      if (evt.type === "stream_error") {
        const detail = isErrorDetail(evt.error)
          ? (evt.error as ErrorDetail)
          : { code: ErrorCodes.STREAM_INTERRUPTED, message: "Stream error", retriable: true };
        sseWrite(res, "error", detail);
        return;
      }

      sseWrite(res, "chat.event", evt);

      // Stream complete — only on prompt_done (sent by Runtime after ALL agent
      // turns finish). agent_end fires after each individual turn and must NOT
      // close the stream, or multi-turn responses (tool calls → text) get cut off.
      if (evt.type === "prompt_done" || evt.type === "done") {
        sseWrite(res, "done", {});
        res.end();
        cleanup();
      }
    });

    // Send chat.send command
    const result = await connectionMap.sendCommand(agentId, "chat.send", {
      agentId,
      userId: auth.userId,
      text: body.text,
      sessionId,
      modelProvider: modelBinding.modelProvider,
      modelId: modelBinding.modelId,
      modelConfig: modelBinding.modelConfig,
    });

    if (!result.ok) {
      sseWrite(res, "error", {
        code: ErrorCodes.INTERNAL,
        message: result.error ?? "RPC failed",
        retriable: true,
      });
      res.end();
      cleanup();
      return;
    }

    // Initial response — send session info
    sseWrite(res, "session", { sessionId: (result.payload as Record<string, unknown>)?.sessionId ?? sessionId });
  });

  // POST /api/v1/siclaw/agents/:id/chat/steer — inject steer message
  router.post("/api/v1/siclaw/agents/:id/chat/steer", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<{ session_id?: string; text?: string }>(req);
    if (!body.session_id || !body.text) { sendJson(res, 400, { error: "session_id and text are required" }); return; }

    const result = await connectionMap.sendCommand(params.id, "chat.steer", {
      agentId: params.id,
      userId: auth.userId,
      sessionId: body.session_id,
      text: body.text,
    });

    sendJson(res, result.ok ? 200 : 502, result);
  });

  // POST /api/v1/siclaw/agents/:id/chat/abort — abort current execution
  router.post("/api/v1/siclaw/agents/:id/chat/abort", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<{ session_id?: string }>(req);
    if (!body.session_id) { sendJson(res, 400, { error: "session_id is required" }); return; }

    const result = await connectionMap.sendCommand(params.id, "chat.abort", {
      agentId: params.id,
      userId: auth.userId,
      sessionId: body.session_id,
    });

    sendJson(res, result.ok ? 200 : 502, result);
  });

  // POST /api/v1/siclaw/agents/:id/chat/clear-queue — clear queued steer/followUp messages
  router.post("/api/v1/siclaw/agents/:id/chat/clear-queue", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<{ session_id?: string }>(req);
    if (!body.session_id) { sendJson(res, 400, { error: "session_id is required" }); return; }

    const result = await connectionMap.sendCommand(params.id, "chat.clearQueue", {
      agentId: params.id,
      userId: auth.userId,
      sessionId: body.session_id,
    });

    sendJson(res, result.ok ? 200 : 502, result);
  });

  // POST /api/v1/siclaw/agents/:id/clear-memory — clear agent memory
  router.post("/api/v1/siclaw/agents/:id/clear-memory", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const result = await connectionMap.sendCommand(params.id, "agent.clearMemory", {
      agentId: params.id,
      userId: auth.userId,
    });

    sendJson(res, result.ok ? 200 : 502, result);
  });

  // ================================================================
  // POST /api/v1/run — External API (API key auth, agent resolved from key)
  // ================================================================

  router.post("/api/v1/run", async (req, res) => {
    const keyAuth = await authenticateApiKey(req);
    if (!keyAuth) {
      sendJson(res, 401, {
        error: "Invalid or expired API key",
        hint: "Use Authorization: Bearer sk-xxx header with a valid API key",
      });
      return;
    }

    const body = await parseBody<{ text?: string; session_id?: string }>(req);
    if (!body.text) { sendJson(res, 400, { error: "text is required" }); return; }

    const agentId = keyAuth.agentId;
    const sessionId = body.session_id ?? crypto.randomUUID();

    if (!connectionMap.isConnected(agentId)) {
      sendJson(res, 503, { error: "Agent runtime is not connected" });
      return;
    }

    const modelBinding = await resolveAgentModelBinding(agentId);
    if (!modelBinding) {
      sendJson(res, 400, { error: "Agent has no model configured" });
      return;
    }

    let assistantText = "";
    let resolved = false;

    function cleanup(): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    }

    req.on("close", () => {
      cleanup();
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        sendJson(res, 504, { error: "Execution timeout" });
      }
    }, 300_000);

    let unsubscribe: (() => void) | null = connectionMap.subscribe(agentId, "chat.event", (data: unknown) => {
      if (resolved) return;
      const envelope = data as { sessionId?: string; event?: Record<string, unknown> } | undefined;
      if (!envelope?.event) return;
      if (envelope.sessionId && envelope.sessionId !== sessionId) return;

      const evt = envelope.event;
      if (evt.type === "agent_message" && typeof evt.text === "string") assistantText += evt.text;
      if (evt.type === "message_update") {
        const ame = (evt as any).assistantMessageEvent;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") assistantText += ame.delta;
      }
      if (evt.type === "prompt_done" || evt.type === "done") {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          if (unsubscribe) { unsubscribe(); unsubscribe = null; }
          sendJson(res, 200, { session_id: sessionId, agent_id: agentId, text: assistantText, status: "success" });
        }
      }
    });

    const result = await connectionMap.sendCommand(agentId, "chat.send", {
      agentId,
      userId: keyAuth.createdBy,
      text: body.text,
      sessionId,
      mode: "api",
      modelProvider: modelBinding.modelProvider,
      modelId: modelBinding.modelId,
      modelConfig: modelBinding.modelConfig,
    });

    if (!result.ok && !resolved) {
      resolved = true;
      clearTimeout(timeout);
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      sendJson(res, 500, { error: result.error ?? "Execution failed" });
    }
  });
}

