/**
 * Metrics REST endpoints (admin-only).
 *
 * GET /api/v1/metrics/live?userId=                — realtime snapshot + top-N (from MetricsAggregator)
 * GET /api/v1/metrics/summary?period=&userId=     — aggregated stats from chat_sessions
 * GET /api/v1/metrics/audit?...                   — tool call audit log (cursor paginated, from chat_messages)
 * GET /api/v1/metrics/audit/:id                   — audit entry detail (full content)
 *
 * Data sources split by semantics:
 *   - `/live` = real-time in-memory (K8s: pulled from AgentBox pods every 30s;
 *               Local: in-process LocalCollector). Tool/skill rankings keep
 *               user/agent labels and survive cross-pod aggregation.
 *   - `/summary` and `/audit` = durable DB (chat_sessions + chat_messages).
 */

import type { RestRouter } from "./rest-router.js";
import type { RuntimeConfig } from "./config.js";
import type { MetricsAggregator } from "./metrics-aggregator.js";
import { sendJson, parseQuery, requireAdmin } from "./rest-router.js";
import { getDb } from "./db.js";

const PERIODS: Record<string, number> = {
  today: 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export function registerMetricsRoutes(
  router: RestRouter,
  config: RuntimeConfig,
  aggregator: MetricsAggregator,
): void {

  // ── GET /api/v1/metrics/live ─────────────────────────────
  router.get("/api/v1/metrics/live", async (req, res) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const query = parseQuery(req.url ?? "");
    const userId = query.userId || undefined;

    sendJson(res, 200, {
      snapshot: aggregator.snapshot(),
      topTools: aggregator.topTools(10, userId),
      topSkills: aggregator.topSkills(10, userId),
    });
  });

  // ── GET /api/v1/metrics/summary ──────────────────────────
  router.get("/api/v1/metrics/summary", async (req, res) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const query = parseQuery(req.url ?? "");
    const period = query.period || "7d";
    const rangeMs = PERIODS[period];
    if (!rangeMs) { sendJson(res, 400, { error: "Invalid period" }); return; }
    const cutoff = new Date(Date.now() - rangeMs);
    const userFilter = query.userId || null;

    const db = getDb();

    const sessionParams: unknown[] = [cutoff];
    let totalSessionsSql = "SELECT COUNT(*) AS c FROM chat_sessions WHERE created_at >= ?";
    if (userFilter) { totalSessionsSql += " AND user_id = ?"; sessionParams.push(userFilter); }
    const [sRows] = await db.query(totalSessionsSql, sessionParams) as [Array<{ c: number }>, unknown];
    const totalSessions = Number(sRows[0]?.c ?? 0);

    const pParams: unknown[] = [cutoff];
    let totalPromptsSql = `SELECT COUNT(*) AS c FROM chat_messages m
      JOIN chat_sessions s ON m.session_id = s.id
      WHERE m.role = 'user' AND m.created_at >= ?`;
    if (userFilter) { totalPromptsSql += " AND s.user_id = ?"; pParams.push(userFilter); }
    const [pRows] = await db.query(totalPromptsSql, pParams) as [Array<{ c: number }>, unknown];
    const totalPrompts = Number(pRows[0]?.c ?? 0);

    let byUser: Array<{ userId: string; sessions: number; messages: number }> = [];
    if (!userFilter) {
      const [uRows] = await db.query(
        `SELECT s.user_id AS userId, COUNT(DISTINCT s.id) AS sessions, SUM(s.message_count) AS messages
         FROM chat_sessions s WHERE s.created_at >= ?
         GROUP BY s.user_id ORDER BY sessions DESC LIMIT 50`,
        [cutoff],
      ) as [Array<{ userId: string; sessions: number; messages: number | null }>, unknown];
      byUser = uRows.map(r => ({ userId: r.userId, sessions: Number(r.sessions), messages: Number(r.messages ?? 0) }));
    }

    sendJson(res, 200, {
      totalSessions,
      totalPrompts,
      byUser,
    });
  });

  // ── GET /api/v1/metrics/audit ────────────────────────────
  router.get("/api/v1/metrics/audit", async (req, res) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const query = parseQuery(req.url ?? "");
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || "50", 10)));

    const startDate = query.startDate ? new Date(query.startDate) : new Date(Date.now() - 86_400_000);
    const endDate = query.endDate ? new Date(query.endDate) : new Date();

    const conds: string[] = ["m.role = 'tool'", "m.created_at BETWEEN ? AND ?"];
    const params: unknown[] = [startDate, endDate];

    if (query.userId) {
      conds.push("s.user_id = ?");
      params.push(query.userId);
    }
    if (query.toolName) {
      conds.push("m.tool_name = ?");
      params.push(query.toolName);
    }
    if (query.outcome) {
      conds.push("m.outcome = ?");
      params.push(query.outcome);
    }
    // Cursor pagination with millisecond precision + id tiebreaker
    if (query.cursorTs && query.cursorId) {
      const cursorDate = new Date(parseInt(query.cursorTs, 10));
      conds.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
      params.push(cursorDate, cursorDate, query.cursorId);
    }

    const sql = `SELECT m.id, m.session_id AS sessionId, m.tool_name AS toolName,
                        LEFT(m.tool_input, 500) AS toolInput,
                        m.outcome, m.duration_ms AS durationMs, m.created_at AS timestamp,
                        s.user_id AS userId, s.agent_id AS agentId
                 FROM chat_messages m
                 LEFT JOIN chat_sessions s ON m.session_id = s.id
                 WHERE ${conds.join(" AND ")}
                 ORDER BY m.created_at DESC, m.id DESC
                 LIMIT ?`;
    params.push(limit + 1);

    const [rows] = await getDb().query(sql, params) as [Array<{
      id: string; sessionId: string; toolName: string | null; toolInput: string | null;
      outcome: string | null; durationMs: number | null; timestamp: Date;
      userId: string | null; agentId: string | null;
    }>, unknown];

    const hasMore = rows.length > limit;
    const logs = rows.slice(0, limit).map(r => ({
      id: r.id,
      sessionId: r.sessionId,
      userId: r.userId,
      agentId: r.agentId,
      toolName: r.toolName,
      toolInput: r.toolInput,
      outcome: r.outcome,
      durationMs: r.durationMs,
      timestamp: r.timestamp.toISOString(),
    }));

    sendJson(res, 200, { logs, hasMore });
  });

  // ── GET /api/v1/metrics/audit/:id ────────────────────────
  router.get("/api/v1/metrics/audit/:id", async (req, res, params) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const id = params.id;
    if (!id) { sendJson(res, 400, { error: "Missing id" }); return; }

    const [rows] = await getDb().query(
      `SELECT m.id, m.session_id AS sessionId, m.tool_name AS toolName, m.tool_input AS toolInput,
              m.outcome, m.duration_ms AS durationMs, m.content, m.created_at AS timestamp,
              s.user_id AS userId, s.agent_id AS agentId
       FROM chat_messages m
       LEFT JOIN chat_sessions s ON m.session_id = s.id
       WHERE m.id = ? AND m.role = 'tool'`,
      [id],
    ) as [Array<{
      id: string; sessionId: string; toolName: string | null; toolInput: string | null;
      outcome: string | null; durationMs: number | null; content: string | null;
      timestamp: Date; userId: string | null; agentId: string | null;
    }>, unknown];

    if (!rows.length) { sendJson(res, 404, { error: "Not found" }); return; }
    const r = rows[0];
    sendJson(res, 200, {
      id: r.id,
      sessionId: r.sessionId,
      userId: r.userId,
      agentId: r.agentId,
      toolName: r.toolName,
      toolInput: r.toolInput,
      content: r.content,
      outcome: r.outcome,
      durationMs: r.durationMs,
      timestamp: r.timestamp.toISOString(),
    });
  });
}
