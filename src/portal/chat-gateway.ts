/**
 * Chat gateway — bridges the frontend (HTTP/SSE) to the Runtime (WebSocket).
 *
 * POST /api/v1/siclaw/agents/:id/chat/send  → SSE streaming
 * POST /api/v1/siclaw/agents/:id/run         → synchronous execution
 */

import crypto from "node:crypto";
import { getDb } from "../gateway/db.js";
import {
  sendJson,
  parseBody,
  requireAuth,
  type RestRouter,
} from "../gateway/rest-router.js";
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

interface ResolvedModelBinding {
  modelProvider: string;
  modelId: string;
  modelConfig: {
    name: string;
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
      compat?: Record<string, unknown>;
    }>;
  };
}

/** Look up the agent's bound provider/model and build a full modelConfig for Runtime. */
async function resolveAgentModelBinding(agentId: string): Promise<ResolvedModelBinding | null> {
  const db = getDb();
  const [agentRows] = (await db.query(
    "SELECT model_provider, model_id FROM agents WHERE id = ?",
    [agentId],
  )) as any;
  const agent = agentRows[0] as { model_provider?: string; model_id?: string } | undefined;
  if (!agent?.model_provider || !agent?.model_id) return null;

  const [providerRows] = (await db.query(
    "SELECT id, name, base_url, api_key, api_type FROM model_providers WHERE name = ? LIMIT 1",
    [agent.model_provider],
  )) as any;
  const provider = providerRows[0] as
    | { id: string; name: string; base_url: string; api_key: string | null; api_type: string }
    | undefined;
  if (!provider) return null;

  const [entryRows] = (await db.query(
    "SELECT model_id, name, reasoning, context_window, max_tokens FROM model_entries WHERE provider_id = ?",
    [provider.id],
  )) as any;
  const models = (entryRows as Array<{
    model_id: string;
    name: string | null;
    reasoning: number;
    context_window: number;
    max_tokens: number;
  }>).map((m) => ({
    id: m.model_id,
    name: m.name ?? m.model_id,
    reasoning: !!m.reasoning,
    input: ["text"],
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

    let assistantText = "";
    let closed = false;
    let historySaved = false;
    const toolRecords: ToolRecord[] = [];
    let currentTool: ToolRecord | null = null;

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

            // Accumulate assistant text
            if (evt.type === "agent_message" && typeof evt.text === "string") {
              assistantText += evt.text;
            }

            // Accumulate text from message_update (pi-agent text delta)
            if (evt.type === "message_update") {
              const ame = (evt as any).assistantMessageEvent;
              if (ame?.type === "text_delta" && ame.delta) {
                assistantText += ame.delta;
              }
            }

            // Track tool executions
            if (evt.type === "tool_execution_start") {
              const toolName = (evt.toolName as string) ?? "tool";
              const args = evt.args as Record<string, unknown> | undefined;
              const input = args ? JSON.stringify(args) : "";
              currentTool = { toolName, toolInput: input, content: "", outcome: null, durationMs: null };
            }
            if (evt.type === "tool_execution_end" && currentTool) {
              const result = evt.result as { content?: Array<{ type: string; text?: string }> } | undefined;
              currentTool.content = result?.content
                ?.filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("") ?? "";
              currentTool.outcome = (evt.isError ? "error" : "success") as "success" | "error";
              currentTool.durationMs = typeof evt.durationMs === "number" ? evt.durationMs : null;
              toolRecords.push(currentTool);
              currentTool = null;
            }

            // Stream complete
            if (evt.type === "agent_end" || evt.type === "turn_complete" || evt.type === "prompt_done" || evt.type === "done") {
              if (!historySaved && body.text) {
                historySaved = true;
                saveChatHistory(agentId, auth.userId, sessionId, body.text, assistantText, toolRecords).catch(
                  (err) => console.error("[chat-gateway] Failed to save history:", err),
                );
              }
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
        // Save history on WS close as fallback
        if (!historySaved && assistantText && body.text) {
          historySaved = true;
          saveChatHistory(agentId, auth.userId, sessionId, body.text, assistantText, toolRecords).catch(
            (err) => console.error("[chat-gateway] Failed to save history on close:", err),
          );
        }
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

  // POST /api/v1/siclaw/agents/:id/run — synchronous execution
  router.post("/api/v1/siclaw/agents/:id/run", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<{ text?: string; session_id?: string }>(req);
    if (!body.text) { sendJson(res, 400, { error: "text is required" }); return; }

    const agentId = params.id;
    const sessionId = body.session_id ?? crypto.randomUUID();
    const reqId = rpcId();

    const modelBinding = await resolveAgentModelBinding(agentId);
    if (!modelBinding) {
      sendJson(res, 400, { error: "Agent has no model configured, or the bound provider/model was not found" });
      return;
    }

    // Connect to Runtime WS
    const wsUrl = `${runtimeWsUrl}/ws`;
    const ws = new WebSocket(wsUrl, {
      headers: {
        "X-Auth-Token": runtimeSecret,
        "X-Agent-Id": agentId,
      },
    });

    let assistantText = "";
    let resolved = false;
    const toolRecords2: ToolRecord[] = [];
    let currentTool2: ToolRecord | null = null;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        sendJson(res, 504, { error: "Execution timeout" });
      }
    }, 300_000); // 5 minutes

    ws.on("open", () => {
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

        if (msg.type === "res" && msg.id === reqId && !msg.ok) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            sendJson(res, 500, { error: msg.error ?? "RPC failed" });
          }
          return;
        }

        if (msg.type === "event" && msg.event === "chat.event" && msg.payload) {
          const evt = msg.payload.event as Record<string, unknown> | undefined;
          if (evt) {
            if (evt.type === "agent_message" && typeof evt.text === "string") {
              assistantText += evt.text;
            }
            if (evt.type === "message_update") {
              const ame = (evt as any).assistantMessageEvent;
              if (ame?.type === "text_delta" && ame.delta) {
                assistantText += ame.delta;
              }
            }
            if (evt.type === "tool_execution_start") {
              const toolName = (evt.toolName as string) ?? "tool";
              const args = evt.args as Record<string, unknown> | undefined;
              currentTool2 = { toolName, toolInput: args ? JSON.stringify(args) : "", content: "", outcome: null, durationMs: null };
            }
            if (evt.type === "tool_execution_end" && currentTool2) {
              const result = evt.result as { content?: Array<{ type: string; text?: string }> } | undefined;
              currentTool2.content = result?.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") ?? "";
              currentTool2.outcome = (evt.isError ? "error" : "success") as "success" | "error";
              currentTool2.durationMs = typeof evt.durationMs === "number" ? evt.durationMs : null;
              toolRecords2.push(currentTool2);
              currentTool2 = null;
            }

            if (evt.type === "turn_complete" || evt.type === "done" || evt.type === "agent_end" || evt.type === "prompt_done") {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                ws.close();

                saveChatHistory(agentId, auth.userId, sessionId, body.text!, assistantText, toolRecords2).catch(
                  (err) => console.error("[chat-gateway] Failed to save history:", err),
                );

                sendJson(res, 200, {
                  sessionId,
                  text: assistantText,
                });
              }
            }
          }
        }
      } catch (err) {
        console.error("[chat-gateway] Failed to parse WS message:", err);
      }
    });

    ws.on("error", (err) => {
      console.error("[chat-gateway] WS error:", err.message);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        sendJson(res, 502, { error: "Runtime connection failed" });
      }
    });

    ws.on("close", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        sendJson(res, 502, { error: "Runtime connection closed unexpectedly" });
      }
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

// ── Chat history persistence ────────────────────────────────

interface ToolRecord {
  toolName: string
  toolInput: string
  content: string
  outcome: "success" | "error" | "blocked" | null
  durationMs: number | null
}

async function saveChatHistory(
  agentId: string,
  userId: string,
  sessionId: string,
  userText: string,
  assistantText: string,
  toolRecords: ToolRecord[],
): Promise<void> {
  const db = getDb();
  const totalMessages = 2 + toolRecords.length; // user + tools + assistant

  // Upsert session
  await db.query(
    `INSERT INTO chat_sessions (id, agent_id, user_id, title, preview, message_count, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE
       message_count = chat_sessions.message_count + ?,
       preview = VALUES(preview),
       last_active_at = NOW(3)`,
    [sessionId, agentId, userId, userText.slice(0, 100), assistantText.slice(0, 200), totalMessages, totalMessages],
  );

  // Insert messages in chronological order with 1ms spacing to guarantee ordering
  const baseTime = Date.now();
  let offset = 0;

  // 1. User message
  await db.query(
    `INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
    [crypto.randomUUID(), sessionId, userText, new Date(baseTime + offset++)],
  );

  // 2. Tool messages
  for (const tool of toolRecords) {
    await db.query(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_name, tool_input, outcome, duration_ms, created_at)
       VALUES (?, ?, 'tool', ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(), sessionId, tool.content,
        tool.toolName, tool.toolInput, tool.outcome, tool.durationMs,
        new Date(baseTime + offset++),
      ],
    );
  }

  // 3. Assistant message
  await db.query(
    `INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)`,
    [crypto.randomUUID(), sessionId, assistantText, new Date(baseTime + offset++)],
  );
}
