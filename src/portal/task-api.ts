/**
 * Agent Task CRUD API for the Portal.
 * Tasks are scheduled jobs scoped to a specific agent.
 */

import crypto from "node:crypto";
import { getDb } from "../gateway/db.js";
import { parseCronExpression, getAverageIntervalMs } from "../cron/cron-matcher.js";
import { CRON_LIMITS } from "../cron/cron-limits.js";
import {
  sendJson,
  parseBody,
  requireAuth,
  type RestRouter,
} from "../gateway/rest-router.js";

export function registerTaskRoutes(router: RestRouter, jwtSecret: string): void {
  // GET /api/v1/agents/:agentId/tasks — list tasks for an agent
  router.get("/api/v1/agents/:agentId/tasks", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, agent_id, name, description, schedule, prompt, status, last_run_at, last_result, created_at
       FROM agent_tasks WHERE agent_id = ? ORDER BY created_at DESC`,
      [params.agentId],
    ) as any;

    sendJson(res, 200, { data: rows });
  });

  // POST /api/v1/agents/:agentId/tasks — create
  router.post("/api/v1/agents/:agentId/tasks", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<Record<string, unknown>>(req);
    if (!body.name || !body.schedule || !body.prompt) {
      sendJson(res, 400, { error: "name, schedule, and prompt are required" });
      return;
    }

    // Validate schedule expression
    try {
      parseCronExpression(body.schedule as string);
    } catch (err: any) {
      sendJson(res, 400, { error: `Invalid schedule expression: ${err.message}` });
      return;
    }

    // Validate interval
    try {
      const { avg, min } = getAverageIntervalMs(body.schedule as string, CRON_LIMITS.INTERVAL_SAMPLE_COUNT);
      if (avg < CRON_LIMITS.MIN_INTERVAL_MS) {
        sendJson(res, 400, { error: `Schedule fires too frequently. Average interval ${Math.round(avg / 60000)}min, minimum is ${CRON_LIMITS.MIN_INTERVAL_MS / 60000}min.` });
        return;
      }
      if (min < CRON_LIMITS.ABSOLUTE_MIN_GAP_MS) {
        sendJson(res, 400, { error: `Schedule has burst pattern. Minimum gap ${Math.round(min / 60000)}min, must be >= ${CRON_LIMITS.ABSOLUTE_MIN_GAP_MS / 60000}min.` });
        return;
      }
    } catch (err: any) {
      sendJson(res, 400, { error: `Invalid schedule: ${err.message}` });
      return;
    }

    const id = crypto.randomUUID();
    const db = getDb();

    await db.query(
      `INSERT INTO agent_tasks (id, agent_id, name, description, schedule, prompt, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.agentId,
        body.name,
        body.description ?? null,
        body.schedule,
        body.prompt,
        body.status ?? "active",
        auth.userId,
      ],
    );

    const [rows] = await db.query("SELECT * FROM agent_tasks WHERE id = ?", [id]) as any;
    sendJson(res, 201, rows[0]);
  });

  // PUT /api/v1/agents/:agentId/tasks/:taskId — update
  router.put("/api/v1/agents/:agentId/tasks/:taskId", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    // Validate schedule if provided
    if (body.schedule) {
      try {
        parseCronExpression(body.schedule as string);
        const { avg, min } = getAverageIntervalMs(body.schedule as string, CRON_LIMITS.INTERVAL_SAMPLE_COUNT);
        if (avg < CRON_LIMITS.MIN_INTERVAL_MS) {
          sendJson(res, 400, { error: `Schedule fires too frequently. Average interval ${Math.round(avg / 60000)}min, minimum is ${CRON_LIMITS.MIN_INTERVAL_MS / 60000}min.` });
          return;
        }
        if (min < CRON_LIMITS.ABSOLUTE_MIN_GAP_MS) {
          sendJson(res, 400, { error: `Schedule has burst pattern. Minimum gap ${Math.round(min / 60000)}min, must be >= ${CRON_LIMITS.ABSOLUTE_MIN_GAP_MS / 60000}min.` });
          return;
        }
      } catch (err: any) {
        sendJson(res, 400, { error: `Invalid schedule expression: ${err.message}` });
        return;
      }
    }

    const fields = ["name", "description", "schedule", "prompt", "status"];
    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const field of fields) {
      if (field in body) {
        setClauses.push(`${field} = ?`);
        values.push(body[field]);
      }
    }

    if (setClauses.length === 0) {
      sendJson(res, 400, { error: "No fields to update" });
      return;
    }

    setClauses.push("updated_at = NOW(3)");
    values.push(params.taskId, params.agentId);

    const sql = `UPDATE agent_tasks SET ${setClauses.join(", ")} WHERE id = ? AND agent_id = ?`;
    await db.query(sql, values);

    const [rows] = await db.query("SELECT * FROM agent_tasks WHERE id = ?", [params.taskId]) as any;
    if (rows.length === 0) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }

    sendJson(res, 200, rows[0]);
  });

  // DELETE /api/v1/agents/:agentId/tasks/:taskId
  router.delete("/api/v1/agents/:agentId/tasks/:taskId", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const [existing] = await db.query(
      "SELECT id FROM agent_tasks WHERE id = ? AND agent_id = ?",
      [params.taskId, params.agentId],
    ) as any;

    if (existing.length === 0) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }

    await db.query("DELETE FROM agent_tasks WHERE id = ?", [params.taskId]);
    sendJson(res, 200, { deleted: true });
  });

  // GET /api/v1/agents/:agentId/tasks/:taskId/runs — execution history
  router.get("/api/v1/agents/:agentId/tasks/:taskId/runs", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, task_id, status, result_text, error, duration_ms, created_at
       FROM agent_task_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 50`,
      [params.taskId],
    ) as any;

    sendJson(res, 200, { data: rows });
  });
}
