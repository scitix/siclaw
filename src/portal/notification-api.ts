/**
 * Per-user notification inbox — lives in Portal because "who should be told
 * something happened" is the user-facing / upstream-owned concern in the A-route
 * architecture. Runtime fires task completions, Portal receives + persists +
 * pushes to the user's live WS connection.
 *
 * Three surfaces:
 *   - REST (JWT-authed):  list / mark-read / dismiss-all for the UI
 *   - Internal REST (portalSecret): Runtime posts task-completed events here
 *   - WebSocket /ws/notifications (JWT-authed via query token): push channel
 *
 * Persistence is the source of truth — WS push is a bonus for live users.
 * If the user is offline, they'll see unread items on their next REST list.
 */

import crypto from "node:crypto";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { getDb } from "../gateway/db.js";
import {
  sendJson,
  parseBody,
  requireAuth,
  type RestRouter,
} from "../gateway/rest-router.js";

// ── Shape shared with the frontend ────────────────────────────

export interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string | null;
  relatedAgentId: string | null;
  relatedTaskId: string | null;
  relatedRunId: string | null;
  readAt: string | null;
  createdAt: string;
}

// ── Live WS connection registry: userId → Set<WebSocket> ──────

const userConnections = new Map<string, Set<WebSocket>>();

function addConnection(userId: string, ws: WebSocket): void {
  const set = userConnections.get(userId) ?? new Set();
  set.add(ws);
  userConnections.set(userId, set);
}

function removeConnection(userId: string, ws: WebSocket): void {
  const set = userConnections.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userConnections.delete(userId);
}

/**
 * Broadcast a notification to every live WS connection of the given user.
 * No-op if the user has no open sessions — persistence in DB covers them.
 */
function pushToUser(userId: string, notification: Notification): void {
  const conns = userConnections.get(userId);
  if (!conns) return;
  const payload = JSON.stringify({ type: "notification", data: notification });
  for (const ws of conns) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch { /* best-effort */ }
    }
  }
}

// ── Row helpers ───────────────────────────────────────────────

function rowToNotification(row: any): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    message: row.message ?? null,
    relatedAgentId: row.related_agent_id ?? null,
    relatedTaskId: row.related_task_id ?? null,
    relatedRunId: row.related_run_id ?? null,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// ── WS upgrade handler ────────────────────────────────────────

/**
 * Attach a /ws/notifications upgrade handler to the given HTTP server.
 * Auth: `?token=<jwt>` query param (EventSource-style; simpler than a custom
 * header, browsers restrict headers on `new WebSocket()`).
 *
 * TODO(prod): the JWT-in-URL approach leaks the raw token into nginx and
 * k8s access logs. Replace with a short-lived ticket exchange before going
 * to production (mirror the matching TODO in
 * portal-web/src/components/NotificationBell.tsx so the two sides change
 * together).
 */
export function registerNotificationWs(
  httpServer: http.Server,
  jwtSecret: string,
): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith("/ws/notifications")) return;

    const token = new URL(url, "http://x").searchParams.get("token");
    let userId: string | null = null;
    try {
      if (token) {
        const payload = jwt.verify(token, jwtSecret) as any;
        userId = payload?.sub ?? null;
      }
    } catch { /* invalid token */ }

    if (!userId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      addConnection(userId!, ws);
      ws.on("close", () => removeConnection(userId!, ws));
      ws.on("error", () => removeConnection(userId!, ws));
    });
  });
}

// ── REST routes ───────────────────────────────────────────────

export function registerNotificationRoutes(
  router: RestRouter,
  jwtSecret: string,
  portalSecret: string,
): void {
  // GET /api/v1/notifications?unread_only=1&limit=20
  router.get("/api/v1/notifications", async (req, res) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const url = new URL(req.url ?? "", "http://x");
    const unreadOnly = url.searchParams.get("unread_only") === "1";
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20")));

    const db = getDb();
    const where = unreadOnly
      ? "user_id = ? AND read_at IS NULL"
      : "user_id = ?";
    const [rows] = (await db.query(
      `SELECT id, user_id, type, title, message, related_agent_id, related_task_id,
              related_run_id, read_at, created_at
       FROM notifications WHERE ${where}
       ORDER BY created_at DESC LIMIT ?`,
      [auth.userId, limit],
    )) as any;

    const [[countRow]] = (await db.query(
      "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL",
      [auth.userId],
    )) as any;

    sendJson(res, 200, {
      data: (rows as any[]).map(rowToNotification),
      unread_count: Number(countRow.n),
    });
  });

  // POST /api/v1/notifications/:id/read
  router.post("/api/v1/notifications/:id/read", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    await db.query(
      "UPDATE notifications SET read_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND user_id = ? AND read_at IS NULL",
      [params.id, auth.userId],
    );
    sendJson(res, 200, { ok: true });
  });

  // POST /api/v1/notifications/read-all
  router.post("/api/v1/notifications/read-all", async (req, res) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    await db.query(
      "UPDATE notifications SET read_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND read_at IS NULL",
      [auth.userId],
    );
    sendJson(res, 200, { ok: true });
  });

  // POST /api/internal/task-notify  — called by Runtime's task-coordinator
  //   Headers: X-Auth-Token: <portalSecret>
  //   Body: { userId, agentId, taskId, runId, status, title, message }
  router.post("/api/internal/task-notify", async (req, res) => {
    const headerSecret = req.headers["x-auth-token"];
    if (headerSecret !== portalSecret) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const body = await parseBody<{
      userId?: string;
      agentId?: string;
      taskId?: string;
      runId?: string;
      status?: string;
      title?: string;
      message?: string;
    }>(req);
    if (!body.userId || !body.taskId || !body.status) {
      sendJson(res, 400, { error: "userId, taskId, status are required" });
      return;
    }

    const id = crypto.randomUUID();
    const type = body.status === "success" ? "task_success" : "task_failure";
    const title = body.title ?? (body.status === "success" ? "Task completed" : "Task failed");
    const message = body.message ?? null;

    const db = getDb();
    await db.query(
      `INSERT INTO notifications (id, user_id, type, title, message, related_agent_id, related_task_id, related_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, body.userId, type, title, message, body.agentId ?? null, body.taskId, body.runId ?? null],
    );

    // Push to any live WS connection — best effort, persistence is source of truth.
    const notification: Notification = {
      id,
      userId: body.userId,
      type,
      title,
      message,
      relatedAgentId: body.agentId ?? null,
      relatedTaskId: body.taskId,
      relatedRunId: body.runId ?? null,
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    pushToUser(body.userId, notification);

    sendJson(res, 201, { id });
  });
}
