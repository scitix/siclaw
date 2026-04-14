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
import { resolveAgentModelBinding } from "../gateway/agent-model-binding.js";
import { getDb } from "../gateway/db.js";

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

  db.query("UPDATE agent_api_keys SET last_used_at = NOW(3) WHERE id = ?", [key.id]).catch(() => {});

  return { agentId: key.agent_id, keyId: key.id, keyName: key.name, createdBy: key.created_by };
}
import WebSocket from "ws";

/** Send an SSE event to the response stream. No-op if the stream is already closed. */
function sseWrite(res: import("node:http").ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Generate a unique RPC id. */
function rpcId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function registerChatRoutes(
  router: RestRouter,
  runtimeWsUrl: string,
  runtimeSecret: string,
  jwtSecret: string,
): void {
  // POST /api/v1/siclaw/agents/:id/chat/send — SSE streaming
  router.post("/api/v1/siclaw/agents/:id/chat/send", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<{ text?: string; session_id?: string }>(req);
    if (!body.text) { sendJson(res, 400, { error: "text is required" }); return; }

    const agentId = params.id;
    const sessionId = body.session_id ?? crypto.randomUUID();
    const reqId = rpcId();

    // Resolve agent's bound model + provider config from DB
    const modelBinding = await resolveAgentModelBinding(agentId);
    if (!modelBinding) {
      sendJson(res, 400, { error: "Agent has no model configured, or the bound provider/model was not found" });
      return;
    }

    // Set up SSE response
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Connect to Runtime WS
    const wsUrl = `${runtimeWsUrl}/ws`;
    const ws = new WebSocket(wsUrl, {
      headers: {
        "X-Auth-Token": runtimeSecret,
        "X-Agent-Id": agentId,
      },
    });

    let closed = false;

    function cleanup(): void {
      if (closed) return;
      closed = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }

    req.on("close", cleanup);

    ws.on("open", () => {
      // Send chat.send RPC
      ws.send(JSON.stringify({
        type: "req",
        id: reqId,
        method: "chat.send",
        params: {
          agentId,
          userId: auth.userId,
          text: body.text,
          sessionId,
          modelProvider: modelBinding.modelProvider,
          modelId: modelBinding.modelId,
          modelConfig: modelBinding.modelConfig,
        },
      }));
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string;
          id?: string;
          ok?: boolean;
          event?: string;
          payload?: Record<string, unknown>;
          error?: string;
        };

        if (msg.type === "res" && msg.id === reqId) {
          if (!msg.ok) {
            sseWrite(res, "error", { error: msg.error ?? "RPC failed" });
            res.end();
            cleanup();
            return;
          }
          // Initial response — send session info
          sseWrite(res, "session", { sessionId: (msg.payload as Record<string, unknown>)?.sessionId ?? sessionId });
        }

        if (msg.type === "event" && msg.event === "chat.event" && msg.payload) {
          const evt = msg.payload.event as Record<string, unknown> | undefined;
          if (evt) {
            sseWrite(res, "chat.event", evt);

            // Runtime persists user/assistant/tool events to chat_messages via
            // sse-consumer; Portal only forwards the stream to the browser.

            // Stream complete
            if (evt.type === "agent_end" || evt.type === "turn_complete" || evt.type === "prompt_done" || evt.type === "done") {
              sseWrite(res, "done", {});
              res.end();
              cleanup();
            }
          }
        }
      } catch (err) {
        console.error("[chat-gateway] Failed to parse WS message:", err);
      }
    });

    ws.on("error", (err) => {
      console.error("[chat-gateway] WS error:", err.message);
      if (!res.headersSent) {
        sendJson(res, 502, { error: "Runtime connection failed" });
      } else {
        sseWrite(res, "error", { error: "Runtime connection lost" });
        res.end();
      }
      cleanup();
    });

    ws.on("close", () => {
      if (!closed) {
        sseWrite(res, "done", {});
        res.end();
        cleanup();
      }
    });
  });

  // POST /api/v1/siclaw/agents/:id/chat/steer — inject steer message
  router.post("/api/v1/siclaw/agents/:id/chat/steer", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<{ session_id?: string; text?: string }>(req);
    if (!body.session_id || !body.text) { sendJson(res, 400, { error: "session_id and text are required" }); return; }

    const result = await runtimeRpc(runtimeWsUrl, runtimeSecret, params.id, "chat.steer", {
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

    const result = await runtimeRpc(runtimeWsUrl, runtimeSecret, params.id, "chat.abort", {
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

    const result = await runtimeRpc(runtimeWsUrl, runtimeSecret, params.id, "chat.clearQueue", {
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

    const result = await runtimeRpc(runtimeWsUrl, runtimeSecret, params.id, "agent.clearMemory", {
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
    const reqId = rpcId();

    const modelBinding = await resolveAgentModelBinding(agentId);
    if (!modelBinding) {
      sendJson(res, 400, { error: "Agent has no model configured" });
      return;
    }

    const wsUrl = `${runtimeWsUrl}/ws`;
    const ws = new WebSocket(wsUrl, {
      headers: { "X-Auth-Token": runtimeSecret, "X-Agent-Id": agentId },
    });

    let assistantText = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; ws.close(); sendJson(res, 504, { error: "Execution timeout" }); }
    }, 300_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "req", id: reqId, method: "chat.send",
        params: {
          agentId, userId: keyAuth.createdBy, text: body.text,
          sessionId, mode: "api",
          modelProvider: modelBinding.modelProvider,
          modelId: modelBinding.modelId,
          modelConfig: modelBinding.modelConfig,
        },
      }));
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string; id?: string; ok?: boolean;
          event?: string; payload?: Record<string, unknown>; error?: string;
        };

        if (msg.type === "res" && msg.id === reqId && !msg.ok) {
          if (!resolved) { resolved = true; clearTimeout(timeout); ws.close(); sendJson(res, 500, { error: msg.error ?? "Execution failed" }); }
          return;
        }

        if (msg.type === "event" && msg.event === "chat.event" && msg.payload) {
          const evt = msg.payload.event as Record<string, unknown> | undefined;
          if (evt) {
            if (evt.type === "agent_message" && typeof evt.text === "string") assistantText += evt.text;
            if (evt.type === "message_update") {
              const ame = (evt as any).assistantMessageEvent;
              if (ame?.type === "text_delta" && typeof ame.delta === "string") assistantText += ame.delta;
            }
            if (evt.type === "agent_end" || evt.type === "turn_complete" || evt.type === "prompt_done" || evt.type === "done") {
              if (!resolved) {
                resolved = true; clearTimeout(timeout); ws.close();
                sendJson(res, 200, { session_id: sessionId, agent_id: agentId, text: assistantText, status: "success" });
              }
            }
          }
        }
      } catch (err) { console.error("[api-run] Failed to parse WS message:", err); }
    });

    ws.on("error", (err) => {
      console.error("[api-run] WS error:", err.message);
      if (!resolved) { resolved = true; clearTimeout(timeout); sendJson(res, 502, { error: "Runtime connection failed" }); }
    });

    ws.on("close", () => {
      if (!resolved) { resolved = true; clearTimeout(timeout); sendJson(res, 502, { error: "Runtime connection closed unexpectedly" }); }
    });
  });
}

// ── Simple RPC helper (connect WS, send one RPC, wait for response, close) ──

export async function runtimeRpc(
  runtimeWsUrl: string,
  runtimeSecret: string,
  agentId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const wsUrl = `${runtimeWsUrl}/ws`;
    const ws = new WebSocket(wsUrl, {
      headers: {
        "X-Auth-Token": runtimeSecret,
        "X-Agent-Id": agentId,
      },
    });

    const reqId = rpcId();
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        resolve({ ok: false, error: "RPC timeout" });
      }
    }, 30_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "req", id: reqId, method, params }));
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string;
          id?: string;
          ok?: boolean;
          payload?: unknown;
          error?: string;
        };
        if (msg.type === "res" && msg.id === reqId) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            ws.close();
            if (msg.ok) {
              resolve({ ok: true, payload: msg.payload });
            } else {
              resolve({ ok: false, error: msg.error ?? "RPC failed" });
            }
          }
        }
      } catch (err) {
        console.error("[chat-gateway] Failed to parse WS message:", err);
      }
    });

    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ ok: false, error: `WS error: ${err.message}` });
      }
    });

    ws.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ ok: false, error: "WS closed unexpectedly" });
      }
    });
  });
}

