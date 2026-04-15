/**
 * Task Coordinator — scheduler + executor for agent_tasks in Runtime.
 *
 * Replaces the Portal-owned PortalTaskService. Tasks are Runtime-owned: cron
 * config lives in agent_tasks / agent_task_runs (shared MySQL), the scheduler
 * runs here, and execution dispatches directly to AgentBox — no extra HTTP
 * hop through Portal's /run endpoint.
 *
 * Pattern mirrors siclaw_main's CronService:
 *   - Load active tasks at startup, re-sync every 15s (picks up rows created
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
import { buildRedactionConfigForModelConfig } from "./output-redactor.js";

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
  /** Resync cadence to pick up changes from other writers (default 15s). */
  syncIntervalMs?: number;
  /** Per-task soft timeout (default 5 min). */
  executionTimeoutMs?: number;
  /** Notification hook — called once per completed run. */
  onTaskCompleted?: TaskCompletedHandler;
  /** Days to keep cron run records + their chat traces. 0 disables pruning. */
  retentionDays?: number;
  /** Seconds between two Run-now invocations on the same task (default 30). */
  manualRunCooldownSec?: number;
}

export type FireNowOutcome =
  | { kind: "ok" }
  | { kind: "in_flight" }
  | { kind: "cooldown"; retryAfterSec: number }
  | { kind: "not_found" };

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

  /** Tasks whose executeJob is currently running. Prevents double-fire across
   *  the cron-scheduler path and the manual Run-now path. Belt-and-suspenders
   *  on top of the status='running' row in agent_task_runs. */
  private readonly executing = new Set<string>();

  /** Minimum gap between two manual Run-now invocations for the same task.
   *  Protects against degenerate trivially-fast tasks being hammered through
   *  the HTTP endpoint; legitimate debug-iteration (30–60 s per cycle) is
   *  unaffected. Override via SICLAW_MANUAL_RUN_COOLDOWN_SEC. */
  private readonly manualRunCooldownSec: number;

  constructor(opts: TaskCoordinatorOptions) {
    this.manager = opts.agentBoxManager;
    this.tlsOptions = opts.agentBoxTlsOptions;
    this.syncIntervalMs = opts.syncIntervalMs ?? 15_000;
    this.executionTimeoutMs = opts.executionTimeoutMs ?? 300_000;
    this.retentionDays = opts.retentionDays ?? 90;
    this.manualRunCooldownSec = opts.manualRunCooldownSec ?? 30;
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
   * Delete scheduled-task-triggered sessions + run records older than
   * retentionDays.
   *
   * chat_messages is wiped transitively via the FK cascade from chat_sessions.
   * agent_task_runs.session_id is a plain column (no FK) so we delete it in
   * a separate statement; any stale session_id left pointing at a just-
   * deleted row is harmless (the messages endpoint returns empty for
   * missing sessions).
   *
   * Scoped to origin='task' for sessions so user chat history is not touched.
   */
  private async pruneOldRuns(): Promise<void> {
    const db = getDb();
    const days = this.retentionDays;
    const t0 = Date.now();
    const [sessResult] = (await db.query(
      `DELETE FROM chat_sessions
       WHERE origin = 'task' AND last_active_at < NOW() - INTERVAL ? DAY`,
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

  /** Execute one fire of a task: run agent, persist trace + run row, emit event.
   *
   *  Sole execution entry point — both the cron-scheduler path and the
   *  manual Run-now path end up here. The first thing this function does
   *  is a synchronous claim on `this.executing`: if another fire is in
   *  flight for the same task we bail immediately. The check + add are
   *  synchronous (no `await`), so under Node's single-threaded event loop
   *  no two coroutines can both pass the check — that's what closes the
   *  cron/manual coincidence window.
   *
   *  The 'running' agent_task_runs row is also created here (not in
   *  fireNow) so bailing on the claim check doesn't leak an orphan row.
   */
  private async executeJob(
    job: CronJobRow,
    opts?: { skipStatusCheck?: boolean },
  ): Promise<void> {
    // ── Synchronous claim gate (must come BEFORE any await) ─────────────
    if (this.executing.has(job.id)) {
      console.log(`[task-coordinator] Task ${job.id} (${job.name}) already executing, skipping duplicate fire`);
      return;
    }
    this.executing.add(job.id);
    // ────────────────────────────────────────────────────────────────────

    try {
      await this.executeJobInner(job, opts);
    } finally {
      // Always release the in-memory claim, even on uncaught error.
      this.executing.delete(job.id);
    }
  }

  /** Inner body of executeJob — kept separate so the claim/release in
   *  executeJob can be guaranteed by a single try/finally at the top. */
  private async executeJobInner(
    job: CronJobRow,
    opts?: { skipStatusCheck?: boolean },
  ): Promise<void> {
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
    //
    // Manual-fire path skips this: fireNow did its own validation and the
    // task is intentionally being run regardless of paused/active status.
    if (!opts?.skipStatusCheck) {
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
    }

    const agentId = job.agentId ?? "";
    const userId = job.userId || "";
    const sessionId = crypto.randomUUID();
    let status: "success" | "failure" = "success";
    let resultText = "";
    let error: string | null = null;

    // Reserve the run row up-front so UIs can see "running" state.
    let runId = "";
    try {
      runId = await this.createRunningRun(job.id, sessionId);
    } catch (err) {
      console.error(`[task-coordinator] Could not create running row for ${job.id}:`, err);
      // Continue without a reserved row; recordRun below will still try.
    }

    try {
      console.log(`[task-coordinator] Executing task ${job.id} (${job.name}) agent=${agentId} user=${userId}`);

      const binding = await resolveAgentModelBinding(agentId);
      if (!binding) throw new Error(`Agent ${agentId} has no valid model binding`);

      const handle = await this.manager.getOrCreate(userId, agentId);
      const client = new AgentBoxClient(handle.endpoint, 30_000, this.tlsOptions);

      const promptOpts: PromptOptions = {
        sessionId,
        text: prompt,
        mode: "task",
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

      const redactionConfig = buildRedactionConfigForModelConfig(binding.modelConfig);

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
    try {
      if (runId) {
        await this.finalizeRun(runId, status, resultText, error, durationMs);
      } else {
        // Fallback: no reserved row → INSERT the final state in one go.
        runId = await this.recordRun(job.id, status, resultText, error, durationMs, sessionId);
      }
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
       VALUES (?, ?, ?, ?, ?, 'task')`,
      [sessionId, agentId, userId, title.slice(0, 255), promptText.slice(0, 500)],
    );
  }

  /** Reserve an agent_task_runs row with status='running' at the start of a
   *  fire so that UIs polling /runs see the execution immediately instead of
   *  only after it finishes. finalizeRun UPDATEs the same row at the end. */
  private async createRunningRun(
    taskId: string,
    sessionId: string,
  ): Promise<string> {
    const db = getDb();
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO agent_task_runs (id, task_id, status, session_id)
       VALUES (?, ?, 'running', ?)`,
      [id, taskId, sessionId],
    );
    return id;
  }

  private async finalizeRun(
    runId: string,
    status: string,
    resultText: string,
    error: string | null,
    durationMs: number,
  ): Promise<void> {
    const db = getDb();
    await db.query(
      `UPDATE agent_task_runs
         SET status = ?, result_text = ?, error = ?, duration_ms = ?
       WHERE id = ?`,
      [status, resultText.slice(0, 10_000), error, durationMs, runId],
    );
  }

  /** Fallback for the zero-running-row case (shouldn't normally happen
   *  since createRunningRun precedes execution). Kept so a DB blip on
   *  INSERT doesn't lose the final result. */
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

  /**
   * Manually trigger a run for the given task. Validation layers (in order):
   *   1. Task exists (HTTP handler already verified ownership).
   *   2. In-flight: no concurrent execution. Two levels — the in-memory
   *      executing Set (catches both manual + cron-fired coincidences in
   *      this process) AND a DB status='running' row (catches stale state
   *      from a Runtime restart mid-run).
   *   3. Cooldown: at least manualRunCooldownSec since the last manual fire.
   *
   * We do NOT create the agent_task_runs row here — executeJob owns that,
   * so if the synchronous claim gate in executeJob bails no orphan row is
   * left behind.
   */
  async fireNow(taskId: string): Promise<FireNowOutcome> {
    const db = getDb();
    const [rows] = (await db.query(
      `SELECT id, agent_id, name, description, schedule, prompt, status, created_by,
              last_run_at, last_result, last_manual_run_at
       FROM agent_tasks WHERE id = ? LIMIT 1`,
      [taskId],
    )) as any;
    if (rows.length === 0) return { kind: "not_found" };
    const row = rows[0] as AgentTaskDbRow & { last_manual_run_at: Date | null };

    if (this.executing.has(taskId)) return { kind: "in_flight" };
    const [inflight] = (await db.query(
      "SELECT id FROM agent_task_runs WHERE task_id = ? AND status = 'running' LIMIT 1",
      [taskId],
    )) as any;
    if (inflight.length > 0) return { kind: "in_flight" };

    if (row.last_manual_run_at) {
      const elapsed = (Date.now() - new Date(row.last_manual_run_at).getTime()) / 1000;
      if (elapsed < this.manualRunCooldownSec) {
        return { kind: "cooldown", retryAfterSec: Math.ceil(this.manualRunCooldownSec - elapsed) };
      }
    }

    // Record the manual trigger moment so a rapid follow-up click hits the
    // cooldown. Done before executeJob so two near-simultaneous fireNow
    // calls (both past the in-flight check) don't both pass cooldown.
    await db.query(
      "UPDATE agent_tasks SET last_manual_run_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [taskId],
    );

    // Seed the side-map the scheduler normally fills on sync.
    this.jobPrompts.set(taskId, row.prompt);

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

    // Kick off asynchronously. executeJob does its own synchronous claim
    // gate + createRunningRun; if a concurrent cron fire has already
    // claimed this task, executeJob will bail without creating an extra
    // run row.
    void this.executeJob(cronJob, { skipStatusCheck: true });
    return { kind: "ok" };
  }
}
