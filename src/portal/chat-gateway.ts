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

/** Send an SSE event to the response stream. */
function sseWrite(res: import("node:http").ServerResponse, event: string, data: unknown): void {
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

            // Stream complete
            if (evt.type === "turn_complete" || evt.type === "done") {
              saveChatHistory(agentId, auth.userId, sessionId, body.text!, assistantText).catch(
                (err) => console.error("[chat-gateway] Failed to save history:", err),
              );
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

  // POST /api/v1/siclaw/agents/:id/run — synchronous execution
  router.post("/api/v1/siclaw/agents/:id/run", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<{ text?: string; session_id?: string }>(req);
    if (!body.text) { sendJson(res, 400, { error: "text is required" }); return; }

    const agentId = params.id;
    const sessionId = body.session_id ?? crypto.randomUUID();
    const reqId = rpcId();

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

            if (evt.type === "turn_complete" || evt.type === "done") {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                ws.close();

                saveChatHistory(agentId, auth.userId, sessionId, body.text!, assistantText).catch(
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

// ── Chat history persistence ────────────────────────────────

async function saveChatHistory(
  agentId: string,
  userId: string,
  sessionId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const db = getDb();

  // Upsert session — MySQL uses ON DUPLICATE KEY UPDATE instead of ON CONFLICT
  await db.query(
    `INSERT INTO chat_sessions (id, agent_id, user_id, title, preview, message_count, last_active_at)
     VALUES (?, ?, ?, ?, ?, 2, NOW(3))
     ON DUPLICATE KEY UPDATE
       message_count = chat_sessions.message_count + 2,
       preview = VALUES(preview),
       last_active_at = NOW(3)`,
    [sessionId, agentId, userId, userText.slice(0, 100), assistantText.slice(0, 200)],
  );

  // Insert user message
  await db.query(
    `INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, NOW(3))`,
    [crypto.randomUUID(), sessionId, userText],
  );

  // Insert assistant message
  await db.query(
    `INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, NOW(3))`,
    [crypto.randomUUID(), sessionId, assistantText],
  );
}
