/**
 * Task Coordinator — scheduler + executor for agent_tasks in Runtime.
 *
 * Replaces the Portal-owned PortalTaskService. Tasks are Runtime-owned: cron
 * config lives in agent_tasks / agent_task_runs (shared MySQL), the scheduler
 * runs here, and execution dispatches directly to AgentBox — no extra HTTP
 * hop through Portal's /run endpoint.
 *
 * Pattern mirrors siclaw_main's CronService:
 *   - Load active tasks at startup, re-sync every 60s (picks up rows created
 *     via UI REST, chat-tool manage_schedule, or any other writer)
 *   - Each fire: resolve agent's model binding, create a fresh session, stream
 *     events through sse-consumer (which persists the full trace), record the
 *     run into agent_task_runs
 *   - Emits task.completed events via the supplied broadcaster so upstream
 *     (upstream in prod, Portal in test) can route notifications to users.
 */

import crypto from "node:crypto";
import { CronScheduler, type CronJobRow } from "../cron/cron-scheduler.js";
import { getDb } from "./db.js";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient, type AgentBoxTlsOptions, type PromptOptions } from "./agentbox/client.js";
import { resolveAgentModelBinding } from "./agent-model-binding.js";
import { appendMessage, incrementMessageCount } from "./chat-repo.js";
import { consumeAgentSse } from "./sse-consumer.js";
import { buildRedactionConfig } from "./output-redactor.js";

/** Row shape needed by the scheduler — carries the task prompt out-of-band. */
interface AgentTaskDbRow {
  id: string;
  agent_id: string | null;
  name: string;
  description: string | null;
  schedule: string;
  prompt: string;
  status: string;
  created_by: string | null;
  last_run_at: string | null;
  last_result: string | null;
}

/**
 * Event emitted after a task run completes (or fails). Upstream consumers
 * (upstream / Portal) should route this by userId to the live user's UI session.
 */
export interface TaskCompletedEvent {
  taskId: string;
  /** Human-readable task name — used by upstream notification titles so
   *  users don't see a UUID prefix. */
  taskName: string;
  runId: string;
  agentId: string;
  userId: string;
  status: "success" | "failure";
  resultText: string;
  error: string | null;
  durationMs: number;
  sessionId: string;
}

export type TaskCompletedHandler = (evt: TaskCompletedEvent) => void;

export interface TaskCoordinatorOptions {
  agentBoxManager: AgentBoxManager;
  agentBoxTlsOptions?: AgentBoxTlsOptions;
  /** Resync cadence to pick up changes from other writers (default 60s). */
  syncIntervalMs?: number;
  /** Per-task soft timeout (default 5 min). */
  executionTimeoutMs?: number;
  /** Notification hook — called once per completed run. */
  onTaskCompleted?: TaskCompletedHandler;
  /** Days to keep cron run records + their chat traces. 0 disables pruning. */
  retentionDays?: number;
}

export class TaskCoordinator {
  private scheduler: CronScheduler;
  private manager: AgentBoxManager;
  private tlsOptions?: AgentBoxTlsOptions;
  private syncTimer?: ReturnType<typeof setInterval>;
  private pruneTimer?: ReturnType<typeof setInterval>;
  private syncIntervalMs: number;
  private executionTimeoutMs: number;
  private retentionDays: number;
  private onTaskCompleted?: TaskCompletedHandler;

  /** Side-map: jobId → prompt text (CronJobRow lacks this field). */
  private readonly jobPrompts = new Map<string, string>();

  constructor(opts: TaskCoordinatorOptions) {
    this.manager = opts.agentBoxManager;
    this.tlsOptions = opts.agentBoxTlsOptions;
    this.syncIntervalMs = opts.syncIntervalMs ?? 15_000;
    this.executionTimeoutMs = opts.executionTimeoutMs ?? 300_000;
    this.retentionDays = opts.retentionDays ?? 90;
    this.onTaskCompleted = opts.onTaskCompleted;
    this.scheduler = new CronScheduler((job) => this.executeJob(job));
  }

  async start(): Promise<void> {
    console.log("[task-coordinator] Starting...");
    await this.syncFromDb();
    this.syncTimer = setInterval(() => {
      this.syncFromDb().catch((err) => {
        console.error("[task-coordinator] Sync error:", err);
      });
    }, this.syncIntervalMs);
    this.syncTimer.unref();

    // Retention: run once at startup so a long-lived pod catches up even if
    // the daily timer hasn't fired yet, then daily afterwards. Disabled when
    // retentionDays is 0 (for dev / single-node scenarios where cleanup is
    // handled out-of-band).
    if (this.retentionDays > 0) {
      this.pruneOldRuns().catch((err) => {
        console.error("[task-coordinator] Initial prune error:", err);
      });
      this.pruneTimer = setInterval(() => {
        this.pruneOldRuns().catch((err) => {
          console.error("[task-coordinator] Prune error:", err);
        });
      }, 24 * 60 * 60 * 1000);
      this.pruneTimer.unref();
    }

    console.log(
      `[task-coordinator] Started (sync every ${this.syncIntervalMs / 1000}s, retention ${this.retentionDays}d, ${this.scheduler.jobCount} tasks loaded)`,
    );
  }

  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    this.scheduler.stop();
    this.jobPrompts.clear();
    console.log("[task-coordinator] Stopped");
  }

  /**
   * Delete cron-triggered sessions + run records older than retentionDays.
   *
   * chat_messages is wiped transitively via the FK cascade from chat_sessions.
   * agent_task_runs.session_id is a plain column (no FK) so we delete it in
   * a separate statement; any stale session_id left pointing at a just-
   * deleted row is harmless (the messages endpoint returns empty for
   * missing sessions).
   *
   * Scoped to origin='cron' for sessions so user chat history is not touched.
   */
  private async pruneOldRuns(): Promise<void> {
    const db = getDb();
    const days = this.retentionDays;
    const t0 = Date.now();
    const [sessResult] = (await db.query(
      `DELETE FROM chat_sessions
       WHERE origin = 'cron' AND last_active_at < NOW() - INTERVAL ? DAY`,
      [days],
    )) as any;
    const [runsResult] = (await db.query(
      `DELETE FROM agent_task_runs WHERE created_at < NOW() - INTERVAL ? DAY`,
      [days],
    )) as any;
    const sessions = sessResult?.affectedRows ?? 0;
    const runs = runsResult?.affectedRows ?? 0;
    if (sessions > 0 || runs > 0) {
      console.log(
        `[task-coordinator] Pruned ${runs} run(s) + ${sessions} cron session(s) older than ${days}d (${Date.now() - t0}ms)`,
      );
    }
  }

  /** Reconcile scheduler state with agent_tasks table. */
  private async syncFromDb(): Promise<void> {
    const db = getDb();
    const [rows] = (await db.query(
      `SELECT id, agent_id, name, description, schedule, prompt, status, created_by,
              last_run_at, last_result
       FROM agent_tasks WHERE status = 'active'`,
    )) as any;

    const activeIds = new Set<string>();
    for (const row of rows as AgentTaskDbRow[]) {
      activeIds.add(row.id);
      this.jobPrompts.set(row.id, row.prompt);
      const cronJob: CronJobRow = {
        id: row.id,
        userId: row.created_by ?? "",
        name: row.name,
        schedule: row.schedule,
        description: row.description,
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
    for (const scheduledId of this.scheduler.scheduledJobIds) {
      if (!activeIds.has(scheduledId)) {
        this.scheduler.cancel(scheduledId);
        this.jobPrompts.delete(scheduledId);
      }
    }
  }

  /** Execute one fire of a task: run agent, persist trace + run row, emit event. */
  private async executeJob(job: CronJobRow): Promise<void> {
    const startTime = Date.now();
    const prompt = this.jobPrompts.get(job.id);
    if (!prompt) {
      console.error(`[task-coordinator] No prompt for task ${job.id} (${job.name}), skipping`);
      return;
    }

    // Defensive re-check against the DB: between the scheduler's setTimeout
    // being queued and the callback firing, the user may have paused the
    // task through the API. The local scheduler state is only reconciled
    // on the sync interval (15s), so a late-fired timer can outrun it.
    // A single SELECT here closes that window without cross-module coupling.
    //
    // Fail-closed: if the DB lookup itself fails, skip this fire. Proceeding
    // on a DB error would mean firing with stale in-memory state (the whole
    // point this check exists) and a guaranteed downstream failure anyway
    // once the job tries to write its run record.
    try {
      const db = getDb();
      const [rows] = (await db.query(
        "SELECT status FROM agent_tasks WHERE id = ? LIMIT 1",
        [job.id],
      )) as any;
      const current = rows?.[0]?.status;
      if (current !== "active") {
        console.log(`[task-coordinator] Skipping task ${job.id} (${job.name}) — status=${current ?? "missing"}`);
        return;
      }
    } catch (err) {
      console.warn(`[task-coordinator] status precheck failed for ${job.id}, skipping fire: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const agentId = job.agentId ?? "";
    const userId = job.userId || "";
    const sessionId = crypto.randomUUID();
    let status: "success" | "failure" = "success";
    let resultText = "";
    let error: string | null = null;

    try {
      console.log(`[task-coordinator] Executing task ${job.id} (${job.name}) agent=${agentId} user=${userId}`);

      const binding = await resolveAgentModelBinding(agentId);
      if (!binding) throw new Error(`Agent ${agentId} has no valid model binding`);

      const handle = await this.manager.getOrCreate(userId, agentId);
      const client = new AgentBoxClient(handle.endpoint, 30_000, this.tlsOptions);

      const promptOpts: PromptOptions = {
        sessionId,
        text: prompt,
        mode: "cron",
        agentId,
        modelProvider: binding.modelProvider,
        modelId: binding.modelId,
        modelConfig: binding.modelConfig,
      };
      await client.prompt(promptOpts);

      // Seed chat_sessions + user message so FK + ordering are consistent
      await this.ensureChatSession(sessionId, agentId, userId, job.name, prompt);
      await appendMessage({ sessionId, role: "user", content: prompt });
      await incrementMessageCount(sessionId);

      const redactionConfig = buildRedactionConfig(undefined, undefined, [
        binding.modelConfig.apiKey,
        binding.modelConfig.baseUrl,
      ]);

      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), this.executionTimeoutMs);
      timer.unref();
      try {
        const consumed = await consumeAgentSse({
          client,
          sessionId,
          userId,
          persistMessages: true,
          redactionConfig,
          signal: abortCtrl.signal,
        });
        resultText = consumed.resultText;
        if (consumed.errorMessage) throw new Error(consumed.errorMessage);
      } finally {
        clearTimeout(timer);
      }

      console.log(`[task-coordinator] Task ${job.id} completed (${Date.now() - startTime}ms)`);
    } catch (err) {
      status = "failure";
      error = err instanceof Error ? err.message : String(err);
      console.error(`[task-coordinator] Task ${job.id} failed:`, error);
    }

    const durationMs = Date.now() - startTime;

    // Persistence + notification — best-effort so one failure doesn't mask another
    let runId = "";
    try {
      runId = await this.recordRun(job.id, status, resultText, error, durationMs, sessionId);
      await this.updateTaskMetadata(job.id, status);
    } catch (err) {
      console.error(`[task-coordinator] Failed to record run for task ${job.id}:`, err);
    }

    if (this.onTaskCompleted && runId) {
      try {
        this.onTaskCompleted({
          taskId: job.id,
          taskName: job.name,
          runId,
          agentId,
          userId,
          status,
          resultText,
          error,
          durationMs,
          sessionId,
        });
      } catch (err) {
        console.error(`[task-coordinator] onTaskCompleted hook failed:`, err);
      }
    }
  }

  /**
   * Guarantee a chat_sessions row so chat_messages inserts don't fail the FK.
   * INSERT IGNORE makes it safe even if the row already exists.
   */
  private async ensureChatSession(
    sessionId: string,
    agentId: string,
    userId: string,
    title: string,
    promptText: string,
  ): Promise<void> {
    const db = getDb();
    await db.query(
      `INSERT IGNORE INTO chat_sessions (id, agent_id, user_id, title, preview, origin)
       VALUES (?, ?, ?, ?, ?, 'cron')`,
      [sessionId, agentId, userId, title.slice(0, 255), promptText.slice(0, 500)],
    );
  }

  /** Insert a run row. Returns the generated runId so the completion event
   *  can link back to the specific execution. */
  private async recordRun(
    taskId: string,
    status: string,
    resultText: string,
    error: string | null,
    durationMs: number,
    sessionId: string,
  ): Promise<string> {
    const db = getDb();
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO agent_task_runs (id, task_id, status, result_text, error, duration_ms, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, taskId, status, resultText.slice(0, 10_000), error, durationMs, sessionId],
    );
    return id;
  }

  private async updateTaskMetadata(taskId: string, status: string): Promise<void> {
    const db = getDb();
    await db.query(
      `UPDATE agent_tasks SET last_run_at = CURRENT_TIMESTAMP(3), last_result = ? WHERE id = ?`,
      [status, taskId],
    );
  }
}
