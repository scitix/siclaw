/**
 * Cron Coordinator — Bridge between DB and CronScheduler.
 *
 * Responsibilities:
 * 1. Load active cron jobs from MySQL on startup
 * 2. Schedule them via CronScheduler
 * 3. Execute fired jobs by sending prompts to AgentBox
 * 4. Record execution results to cron_job_runs
 * 5. Periodically sync with DB to pick up changes
 */

import crypto from "node:crypto";
import { CronScheduler, type CronJobRow } from "../cron/cron-scheduler.js";
import { getDb } from "./db.js";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient, type AgentBoxTlsOptions, type PromptOptions } from "./agentbox/client.js";

/** Extended row that carries the prompt text from DB (not in CronJobRow) */
interface CronJobDbRow {
  id: string;
  org_id: string;
  agent_id: string | null;
  name: string;
  description: string | null;
  schedule: string;
  prompt: string;
  status: string;
  created_by: string;
  last_run_at: string | null;
  last_result: string | null;
}

/** In-memory map from jobId → prompt text (CronJobRow lacks this field) */
const jobPrompts = new Map<string, string>();

/** In-memory map from jobId → org_id (for context) */
const jobOrgIds = new Map<string, string>();

export interface CronCoordinatorOptions {
  agentBoxManager: AgentBoxManager;
  agentBoxTlsOptions?: AgentBoxTlsOptions;
  /** How often to re-sync with DB (default: 60 000 ms = 1 min) */
  syncIntervalMs?: number;
  /** Maximum time to wait for a job execution to complete (default: 300 000 ms = 5 min) */
  executionTimeoutMs?: number;
}

export class CronCoordinator {
  private scheduler: CronScheduler;
  private manager: AgentBoxManager;
  private tlsOptions?: AgentBoxTlsOptions;
  private syncTimer?: ReturnType<typeof setInterval>;
  private syncIntervalMs: number;
  private executionTimeoutMs: number;

  constructor(opts: CronCoordinatorOptions) {
    this.manager = opts.agentBoxManager;
    this.tlsOptions = opts.agentBoxTlsOptions;
    this.syncIntervalMs = opts.syncIntervalMs ?? 60_000;
    this.executionTimeoutMs = opts.executionTimeoutMs ?? 300_000;
    this.scheduler = new CronScheduler((job) => this.executeJob(job));
  }

  /** Start: load all active jobs from DB and begin periodic sync */
  async start(): Promise<void> {
    console.log("[cron-coordinator] Starting...");
    await this.syncFromDb();

    this.syncTimer = setInterval(() => {
      this.syncFromDb().catch((err) => {
        console.error("[cron-coordinator] Sync error:", err);
      });
    }, this.syncIntervalMs);
    this.syncTimer.unref();

    console.log(`[cron-coordinator] Started (sync every ${this.syncIntervalMs / 1000}s, ${this.scheduler.jobCount} jobs loaded)`);
  }

  /** Stop: cancel all timers and scheduled jobs */
  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
    this.scheduler.stop();
    jobPrompts.clear();
    jobOrgIds.clear();
    console.log("[cron-coordinator] Stopped");
  }

  /** Sync: reload active jobs from DB, add new ones, cancel removed ones */
  private async syncFromDb(): Promise<void> {
    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, org_id, agent_id, name, description, schedule, prompt, status, created_by, last_run_at, last_result
       FROM cron_jobs WHERE status = 'active'`,
    ) as any;

    const activeIds = new Set<string>();

    for (const row of rows as CronJobDbRow[]) {
      activeIds.add(row.id);

      // Store prompt and orgId in side maps (CronJobRow doesn't carry these)
      jobPrompts.set(row.id, row.prompt);
      jobOrgIds.set(row.id, row.org_id);

      const cronJob: CronJobRow = {
        id: row.id,
        userId: row.created_by,
        name: row.name,
        description: row.description,
        schedule: row.schedule,
        skillId: null,
        status: "active",
        lastRunAt: row.last_run_at ? new Date(row.last_run_at) : null,
        lastResult: row.last_result,
        assignedTo: null,
        lockedBy: null,
        lockedAt: null,
        agentId: row.agent_id,
      };

      this.scheduler.addOrUpdate(cronJob);
    }

    // Cancel any scheduled jobs that are no longer active in DB
    for (const scheduledId of this.scheduler.scheduledJobIds) {
      if (!activeIds.has(scheduledId)) {
        console.log(`[cron-coordinator] Cancelling removed/paused job ${scheduledId}`);
        this.scheduler.cancel(scheduledId);
        jobPrompts.delete(scheduledId);
        jobOrgIds.delete(scheduledId);
      }
    }
  }

  /** Execute a cron job: create AgentBox, send prompt, record result */
  private async executeJob(job: CronJobRow): Promise<void> {
    const startTime = Date.now();
    const prompt = jobPrompts.get(job.id);
    if (!prompt) {
      console.error(`[cron-coordinator] No prompt found for job ${job.id} (${job.name}), skipping`);
      return;
    }

    const agentId = job.agentId ?? "default";
    let sessionId: string | undefined;
    let status = "success";
    let resultText = "";
    let error: string | null = null;

    try {
      console.log(`[cron-coordinator] Executing job ${job.id} (${job.name}) agent=${agentId} user=${job.userId}`);

      // Get or create AgentBox for this user+agent
      const handle = await this.manager.getOrCreate(job.userId, agentId);
      const client = new AgentBoxClient(handle.endpoint, 30_000, this.tlsOptions);

      // Build and send the prompt
      const promptOpts: PromptOptions = {
        text: prompt,
        mode: "cron",
        agentId,
      };
      const promptResult = await client.prompt(promptOpts);
      sessionId = promptResult.sessionId;

      // Stream events until completion or timeout
      resultText = await this.drainEvents(client, sessionId);

      console.log(`[cron-coordinator] Job ${job.id} completed (${Date.now() - startTime}ms)`);
    } catch (err) {
      status = "failure";
      error = err instanceof Error ? err.message : String(err);
      console.error(`[cron-coordinator] Job ${job.id} failed:`, error);
    }

    const durationMs = Date.now() - startTime;

    // Record the run and update cron_job metadata (best-effort)
    try {
      await this.recordRun(job.id, status, resultText, error, durationMs, sessionId);
      await this.updateJobMetadata(job.id, status, resultText);
    } catch (err) {
      console.error(`[cron-coordinator] Failed to record run for job ${job.id}:`, err);
    }
  }

  /**
   * Drain SSE events from an AgentBox session, collecting the final agent message text.
   * Times out after executionTimeoutMs.
   */
  private async drainEvents(client: AgentBoxClient, sessionId: string): Promise<string> {
    let resultText = "";
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Execution timeout after ${this.executionTimeoutMs}ms`)),
        this.executionTimeoutMs,
      );
      timer.unref();
    });

    const drainPromise = (async () => {
      for await (const event of client.streamEvents(sessionId)) {
        const evt = event as Record<string, unknown>;
        // Collect agent_message text content for result recording
        if (evt.type === "agent_message" && typeof evt.text === "string") {
          resultText = evt.text;
        }
        // Also handle content_block_delta for streaming messages
        if (evt.type === "content_block_delta") {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta && typeof delta.text === "string") {
            resultText += delta.text;
          }
        }
      }
      return resultText;
    })();

    return Promise.race([drainPromise, timeoutPromise]);
  }

  /** Record a job run to the cron_job_runs table */
  private async recordRun(
    jobId: string,
    status: string,
    resultText: string,
    error: string | null,
    durationMs: number,
    sessionId?: string,
  ): Promise<void> {
    const db = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.query(
      `INSERT INTO cron_job_runs (id, job_id, status, result_text, error, duration_ms, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, jobId, status, resultText.slice(0, 10_000), error, durationMs, sessionId ?? null, now],
    );
  }

  /** Update the cron_job row with last_run_at and last_result */
  private async updateJobMetadata(jobId: string, status: string, resultText: string): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();
    const summary = status === "success"
      ? resultText.slice(0, 500)
      : `[FAILED] ${resultText.slice(0, 480)}`;

    await db.query(
      `UPDATE cron_jobs SET last_run_at = ?, last_result = ?, updated_at = ? WHERE id = ?`,
      [now, summary, now, jobId],
    );
  }
}
