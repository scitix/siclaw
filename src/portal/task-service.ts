/**
 * TaskService — In-process task scheduler for Portal.
 *
 * Runs timers in the Portal process. Task execution calls the
 * synchronous /run endpoint on the same Portal server (which
 * proxies to the Runtime via WebSocket).
 */

import crypto from "node:crypto";
import { CronScheduler, type CronJobRow } from "../cron/cron-scheduler.js";
import { getDb } from "../gateway/db.js";

const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PortalTaskService {
  readonly scheduler: CronScheduler;
  private portalPort: number;
  private portalSecret: string;

  constructor(opts: { portalPort: number; portalSecret: string }) {
    this.portalPort = opts.portalPort;
    this.portalSecret = opts.portalSecret;
    this.scheduler = new CronScheduler((job) => this.execute(job));
  }

  /** Load all active tasks and start timers */
  async start(): Promise<void> {
    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, agent_id AS agentId, name, description, schedule, prompt,
              status, last_run_at AS lastRunAt, last_result AS lastResult
       FROM agent_tasks WHERE status = 'active'`,
    ) as any;

    for (const row of rows) {
      this.scheduler.addOrUpdate(row as CronJobRow);
    }
    console.log(`[task-service] Loaded ${rows.length} active tasks`);
  }

  /** Execute a single task */
  private async execute(job: CronJobRow): Promise<void> {
    const db = getDb();

    // Re-validate from DB
    const [current] = await db.query("SELECT * FROM agent_tasks WHERE id = ? AND status = 'active'", [job.id]) as any;
    if (current.length === 0) {
      console.log(`[task-service] Task ${job.id} no longer active, skipping`);
      return;
    }

    const agentId = job.agentId ?? "";
    console.log(`[task-service] Executing task ${job.id} (${job.name}) for agent ${agentId}`);
    const startTime = Date.now();
    const runId = crypto.randomUUID();

    try {
      const resp = await fetch(`http://127.0.0.1:${this.portalPort}/api/v1/siclaw/agents/${agentId}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.portalSecret}`,
        },
        body: JSON.stringify({ text: buildTaskPrompt(job) }),
        signal: AbortSignal.timeout(EXECUTION_TIMEOUT_MS + 10_000),
      });

      const durationMs = Date.now() - startTime;

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 500)}`);
      }

      const data = await resp.json() as { text?: string; sessionId?: string };
      const resultText = data.text || "";

      // Record success
      await db.query(
        "UPDATE agent_tasks SET last_run_at = NOW(3), last_result = 'success' WHERE id = ?",
        [job.id],
      );
      await db.query(
        `INSERT INTO agent_task_runs (id, task_id, status, result_text, duration_ms) VALUES (?, ?, 'success', ?, ?)`,
        [runId, job.id, resultText.slice(0, 10000), durationMs],
      );

      console.log(`[task-service] Task ${job.id} completed in ${durationMs}ms`);
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      console.error(`[task-service] Task ${job.id} failed:`, err.message);

      await db.query(
        "UPDATE agent_tasks SET last_run_at = NOW(3), last_result = 'failure' WHERE id = ?",
        [job.id],
      );
      await db.query(
        `INSERT INTO agent_task_runs (id, task_id, status, error, duration_ms) VALUES (?, ?, 'failure', ?, ?)`,
        [runId, job.id, err.message?.slice(0, 2000), durationMs],
      );
    }
  }

  /** Sync a task change from CRUD into the scheduler */
  syncTask(job: CronJobRow): void {
    this.scheduler.addOrUpdate(job);
  }

  /** Remove a task from the scheduler */
  removeTask(taskId: string): void {
    this.scheduler.cancel(taskId);
  }

  stop(): void {
    this.scheduler.stop();
    console.log("[task-service] Stopped");
  }
}

function buildTaskPrompt(job: CronJobRow): string {
  const parts = [`[Automated Task — Non-interactive]\n\nTask: ${job.name}`];
  if (job.description) {
    parts.push(`Instructions: ${job.description}`);
  }
  if (job.prompt) {
    parts.push(`Prompt: ${job.prompt}`);
  }
  return parts.join("\n\n");
}
