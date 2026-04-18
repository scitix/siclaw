/**
 * Task Coordinator — scheduler + executor for agent_tasks in Runtime.
 *
 * Runtime no longer accesses the database directly. All task persistence
 * is proxied through Portal via FrontendWsClient RPC.
 *
 * Pattern:
 *   - Load active tasks at startup via RPC, re-sync every 15s
 *   - Each fire: resolve agent's model binding via RPC, create a fresh
 *     session, stream events through sse-consumer, record the run via RPC
 *   - Emits task.completed events via the supplied broadcaster so upstream
 *     (upstream in prod, Portal in test) can route notifications to users.
 */

import crypto from "node:crypto";
import { CronScheduler, type CronJobRow } from "../cron/cron-scheduler.js";
import type { RuntimeConfig } from "./config.js";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient, type AgentBoxTlsOptions, type PromptOptions } from "./agentbox/client.js";
import { resolveAgentModelBinding } from "./agent-model-binding.js";
import { appendMessage, ensureChatSession, incrementMessageCount } from "./chat-repo.js";
import { consumeAgentSse } from "./sse-consumer.js";
import { buildRedactionConfigForModelConfig } from "./output-redactor.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import { sessionRegistry } from "./session-registry.js";

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
  config: RuntimeConfig;
  frontendClient: FrontendWsClient;
  agentBoxManager: AgentBoxManager;
  agentBoxTlsOptions?: AgentBoxTlsOptions;
  syncIntervalMs?: number;
  executionTimeoutMs?: number;
  onTaskCompleted?: TaskCompletedHandler;
  retentionDays?: number;
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
  private config: RuntimeConfig;
  private frontendClient: FrontendWsClient;
  private tlsOptions?: AgentBoxTlsOptions;
  private syncTimer?: ReturnType<typeof setInterval>;
  private pruneTimer?: ReturnType<typeof setInterval>;
  private syncIntervalMs: number;
  private executionTimeoutMs: number;
  private retentionDays: number;
  private onTaskCompleted?: TaskCompletedHandler;

  private readonly jobPrompts = new Map<string, string>();
  private readonly executing = new Set<string>();
  private readonly manualRunCooldownSec: number;

  constructor(opts: TaskCoordinatorOptions) {
    this.config = opts.config;
    this.frontendClient = opts.frontendClient;
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
    await this.syncFromAdapter();
    this.syncTimer = setInterval(() => {
      this.syncFromAdapter().catch((err) => {
        console.error("[task-coordinator] Sync error:", err);
      });
    }, this.syncIntervalMs);
    this.syncTimer.unref();

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

  private async pruneOldRuns(): Promise<void> {
    const t0 = Date.now();
    try {
      const result = await this.frontendClient.request("task.prune", {
        retention_days: this.retentionDays,
      });
      const sessions = result.sessions_deleted ?? 0;
      const runs = result.runs_deleted ?? 0;
      if (sessions > 0 || runs > 0) {
        console.log(
          `[task-coordinator] Pruned ${runs} run(s) + ${sessions} cron session(s) older than ${this.retentionDays}d (${Date.now() - t0}ms)`,
        );
      }
    } catch (err) {
      console.error("[task-coordinator] Prune error:", err);
    }
  }

  /** Reconcile scheduler state with active tasks from Portal via RPC. */
  private async syncFromAdapter(): Promise<void> {
    const result = await this.frontendClient.request("task.listActive");
    const rows = result.data as AgentTaskDbRow[];

    const activeIds = new Set<string>();
    for (const row of rows) {
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

  private async executeJob(
    job: CronJobRow,
    opts?: { skipStatusCheck?: boolean },
  ): Promise<void> {
    if (this.executing.has(job.id)) {
      console.log(`[task-coordinator] Task ${job.id} (${job.name}) already executing, skipping duplicate fire`);
      return;
    }
    this.executing.add(job.id);
    try {
      await this.executeJobInner(job, opts);
    } finally {
      this.executing.delete(job.id);
    }
  }

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

    // Defensive re-check via RPC: between the scheduler's setTimeout
    // and the callback firing, the user may have paused the task.
    if (!opts?.skipStatusCheck) {
      try {
        const statusResult = await this.frontendClient.request("task.getStatus", { taskId: job.id });
        const current = statusResult.status;
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
      runId = crypto.randomUUID();
      await this.frontendClient.request("task.runStart", {
        id: runId,
        task_id: job.id,
        session_id: sessionId,
      });
    } catch (err) {
      console.error(`[task-coordinator] Could not create running row for ${job.id}:`, err);
      runId = "";
    }

    try {
      console.log(`[task-coordinator] Executing task ${job.id} (${job.name}) agent=${agentId} user=${userId}`);

      const binding = await resolveAgentModelBinding(agentId, this.frontendClient);
      if (!binding) throw new Error(`Agent ${agentId} has no valid model binding`);

      // One pod per agent — shared across users who call the agent.
      // Caller/task-owner attribution flows to Upstream via the session registry.
      sessionRegistry.remember(sessionId, userId, agentId);
      const handle = await this.manager.getOrCreate(agentId);
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

      // Seed chat_sessions + user message via RPC
      await ensureChatSession(sessionId, agentId, userId, job.name, prompt);
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

    // Persistence + notification — best-effort
    try {
      if (runId) {
        await this.frontendClient.request("task.runFinalize", {
          run_id: runId,
          status,
          result_text: resultText.slice(0, 10_000),
          error,
          duration_ms: durationMs,
        });
      } else {
        // Fallback: no reserved row → use the existing task-run endpoint
        runId = crypto.randomUUID();
        await this.frontendClient.request("task.runRecord", {
          id: runId,
          task_id: job.id,
          status,
          result_text: resultText.slice(0, 10_000),
          error,
          duration_ms: durationMs,
          session_id: sessionId,
        });
      }
      await this.frontendClient.request("task.updateMeta", {
        task_id: job.id,
        last_result: status,
      });
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

  async fireNow(taskId: string): Promise<FireNowOutcome> {
    // In-memory check first
    if (this.executing.has(taskId)) return { kind: "in_flight" };

    try {
      const result = await this.frontendClient.request("task.fireNow", {
        task_id: taskId,
        cooldown_sec: this.manualRunCooldownSec,
      });

      if (result.outcome === "not_found") return { kind: "not_found" };
      if (result.outcome === "in_flight") return { kind: "in_flight" };
      if (result.outcome === "cooldown") {
        return { kind: "cooldown", retryAfterSec: result.retry_after_sec };
      }

      const row = result.task as AgentTaskDbRow & { last_manual_run_at: Date | null };
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

      void this.executeJob(cronJob, { skipStatusCheck: true });
      return { kind: "ok" };
    } catch (err) {
      console.error(`[task-coordinator] fireNow error for ${taskId}:`, err);
      return { kind: "not_found" };
    }
  }
}
