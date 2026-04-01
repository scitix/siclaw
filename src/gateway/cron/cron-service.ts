/**
 * CronService — In-process cron scheduler for Gateway
 *
 * Replaces the standalone cron process. Runs timers directly in the
 * Gateway process and calls configRepo for DB access (no HTTP proxy).
 * Job execution delegates to /api/internal/agent-prompt on localhost.
 */

import crypto from "node:crypto";
import { CronScheduler, type CronJobRow } from "../../cron/cron-scheduler.js";
import type { ConfigRepository } from "../db/repositories/config-repo.js";
import type { NotificationRepository } from "../db/repositories/notification-repo.js";
import { CRON_LIMITS } from "../../cron/cron-limits.js";

const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STALE_LOCK_CLEANUP_MS = 6 * 60 * 1000; // 6 min
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NOTIFICATION_RETENTION_DAYS = 30;
const SESSION_SOFT_DELETE_DAYS = 180;
const SESSION_HARD_DELETE_DAYS = 30;
const STATS_RETENTION_DAYS = 90;

export type SendToUserFn = (userId: string, event: string, payload: Record<string, unknown>) => void;

export class CronService {
  readonly scheduler: CronScheduler;
  /** Channel notification callback — set by gateway-main after construction */
  onNotify?: (data: { userId: string; jobName: string; result: string; resultText: string; error?: string }) => void;

  private configRepo: ConfigRepository;
  private notifRepo: NotificationRepository;
  private sendToUser: SendToUserFn;
  private gatewayPort: number;
  private staleLockTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private sessionPurgeTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    configRepo: ConfigRepository;
    notifRepo: NotificationRepository;
    sendToUser: SendToUserFn;
    gatewayPort: number;
  }) {
    this.configRepo = opts.configRepo;
    this.notifRepo = opts.notifRepo;
    this.sendToUser = opts.sendToUser;
    this.gatewayPort = opts.gatewayPort;
    this.scheduler = new CronScheduler((job) => this.execute(job));
  }

  /** Load all active jobs and start background timers */
  async start(): Promise<void> {
    // Load all active jobs
    const jobs = await this.configRepo.listAllActiveCronJobs();
    for (const job of jobs) {
      this.scheduler.addOrUpdate(job as CronJobRow);
    }
    console.log(`[cron-service] Loaded ${jobs.length} active jobs`);

    // Stale lock cleanup every 6 minutes
    this.staleLockTimer = setInterval(async () => {
      try {
        await this.configRepo.clearStaleLocks(STALE_LOCK_CLEANUP_MS);
      } catch (err) {
        console.warn("[cron-service] clearStaleLocks failed:", err instanceof Error ? err.message : err);
      }
    }, STALE_LOCK_CLEANUP_MS);
    this.staleLockTimer.unref();

    // Daily notification purge
    this.purgeNotifications();
    this.purgeTimer = setInterval(() => this.purgeNotifications(), PURGE_INTERVAL_MS);
    this.purgeTimer.unref();

    // Daily session purge
    this.purgeSessions();
    this.sessionPurgeTimer = setInterval(() => this.purgeSessions(), PURGE_INTERVAL_MS);
    this.sessionPurgeTimer.unref();

    console.log("[cron-service] Started");
  }

  /** Execute a single cron job */
  private async execute(job: CronJobRow): Promise<void> {
    // Re-validate from DB
    const current = await this.configRepo.getCronJobById(job.id);
    if (!current || current.status !== "active") {
      console.log(`[cron-service] Job ${job.id} no longer active, skipping`);
      return;
    }

    // Soft concurrent-execution limit — skip this run, retry next cycle
    const executing = await this.configRepo.countCurrentlyExecutingJobs();
    if (executing >= CRON_LIMITS.MAX_CONCURRENT_EXECUTIONS) {
      console.warn(
        `[cron-service] Job ${job.id} skipped: concurrent limit reached (${executing}/${CRON_LIMITS.MAX_CONCURRENT_EXECUTIONS})`,
      );
      return;
    }

    // Acquire execution lock
    const executionId = crypto.randomUUID();
    const locked = await this.configRepo.lockJobForExecution(job.id, executionId);
    if (!locked) {
      console.log(`[cron-service] Job ${job.id} already locked, skipping`);
      return;
    }

    const workspaceId = current.workspaceId ?? undefined;
    console.log(`[cron-service] Executing job ${job.id} (${job.name}) for user ${job.userId}${workspaceId ? ` ws=${workspaceId}` : ""}`);

    try {
      const sessionId = `cron-${job.id}-${Date.now()}`;
      const prompt = buildCronPrompt(current);

      const resp = await fetch(`http://localhost:${this.gatewayPort}/api/internal/agent-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: current.userId,
          sessionId,
          text: prompt,
          timeoutMs: EXECUTION_TIMEOUT_MS,
          caller: "cron",
          workspaceId,
        }),
        signal: AbortSignal.timeout(EXECUTION_TIMEOUT_MS + 10_000),
      });

      const data = await resp.json() as {
        status: string; resultText?: string; error?: string; durationMs?: number;
      };

      if (!resp.ok || data.status !== "success") {
        throw new Error(data.error || `agent-prompt returned status=${data.status} http=${resp.status}`);
      }

      const resultText = data.resultText || "";

      // Record success
      try { await this.configRepo.updateCronJobRun(job.id, "success"); } catch (e) {
        console.warn(`[cron-service] updateCronJobRun failed for ${job.id}:`, e instanceof Error ? e.message : e);
      }
      console.log(`[cron-service] Job ${job.id} completed in ${data.durationMs}ms, resultText length=${resultText.length}`);

      // Write run record + notification
      await this.recordResult(job, "success", resultText, undefined, data.durationMs);
    } catch (err) {
      console.error(`[cron-service] Job ${job.id} failed:`, err);
      try { await this.configRepo.updateCronJobRun(job.id, "failure"); } catch (e) {
        console.warn(`[cron-service] updateCronJobRun failed for ${job.id}:`, e instanceof Error ? e.message : e);
      }
      await this.recordResult(job, "failure", "", err instanceof Error ? err.message : String(err));
    } finally {
      try {
        await this.configRepo.unlockJob(job.id, executionId);
      } catch (err) {
        console.warn(`[cron-service] Failed to unlock job ${job.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** Record run history + push notification */
  private async recordResult(
    job: CronJobRow,
    result: "success" | "failure",
    resultText: string,
    error?: string,
    durationMs?: number,
  ): Promise<void> {
    // Persist run record
    try {
      await this.configRepo.insertCronJobRun({
        jobId: job.id,
        status: result,
        resultText: resultText || undefined,
        error,
        durationMs,
      });
    } catch (runErr) {
      console.warn("[cron-service] Failed to insert cron run:", runErr instanceof Error ? runErr.message : runErr);
    }

    // Create notification
    const notifType = result === "success" ? "cron_success" : "cron_failure";
    const notifMessage = result === "success" ? resultText : (error || "Unknown error");
    const notifId = await this.notifRepo.create({
      userId: job.userId,
      type: notifType,
      title: job.name,
      message: notifMessage,
      relatedId: job.id,
    });

    // Push via WebSocket
    this.sendToUser(job.userId, "notification", {
      id: notifId,
      type: notifType,
      title: job.name,
      message: notifMessage,
      relatedId: job.id,
      isRead: false,
      createdAt: new Date().toISOString(),
    });

    // Channel notification callback
    if (this.onNotify) {
      this.onNotify({
        userId: job.userId,
        jobName: job.name,
        result,
        resultText,
        error,
      });
    }
  }

  /** Add or update a job in the scheduler */
  addOrUpdate(job: CronJobRow): void {
    this.scheduler.addOrUpdate(job);
  }

  /** Cancel a job from the scheduler */
  cancel(jobId: string): void {
    this.scheduler.cancel(jobId);
  }

  /** Stop all timers and clean up */
  stop(): void {
    this.scheduler.stop();
    if (this.staleLockTimer) {
      clearInterval(this.staleLockTimer);
      this.staleLockTimer = null;
    }
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
    if (this.sessionPurgeTimer) {
      clearInterval(this.sessionPurgeTimer);
      this.sessionPurgeTimer = null;
    }
    console.log("[cron-service] Stopped");
  }

  private async purgeNotifications(): Promise<void> {
    try {
      const resp = await fetch(`http://localhost:${this.gatewayPort}/api/internal/notifications/purge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: NOTIFICATION_RETENTION_DAYS }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await resp.json() as { deleted?: number };
      console.log(`[cron-service] Notification purge: deleted=${data.deleted ?? 0}`);
    } catch (err) {
      console.warn("[cron-service] Notification purge failed:", err instanceof Error ? err.message : err);
    }
  }

  private async purgeSessions(): Promise<void> {
    try {
      const resp = await fetch(`http://localhost:${this.gatewayPort}/api/internal/sessions/purge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          statsRetentionDays: STATS_RETENTION_DAYS,
          softDeleteInactiveDays: SESSION_SOFT_DELETE_DAYS,
          hardDeleteAfterDays: SESSION_HARD_DELETE_DAYS,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await resp.json()) as Record<string, number>;
      console.log(
        `[cron-service] Session purge: softDeleted=${data.softDeleted}, ` +
          `statsPurged=${data.statsPurged}, sessionsPurged=${data.sessionsPurged}`,
      );
    } catch (err) {
      console.warn("[cron-service] Session purge failed:", err instanceof Error ? err.message : err);
    }
  }
}

function buildCronPrompt(job: CronJobRow): string {
  // Behavioral rules (non-interactive, task_report, fail-fast) are in the
  // system prompt via CRON_SECTION — user message only carries the task.
  const parts = [`Task: ${job.name}`];
  if (job.description) {
    parts.push(`Instructions: ${job.description}`);
  }
  if (job.skillId) {
    parts.push(`Execute skill: ${job.skillId}`);
  }
  return parts.join("\n\n");
}
