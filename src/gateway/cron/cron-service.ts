/**
 * CronService — In-process cron scheduler for Gateway
 *
 * Replaces the standalone cron process. Runs timers directly in the
 * Gateway process and calls configRepo for DB access (no HTTP proxy).
 * Job execution delegates to /api/internal/agent-prompt on localhost.
 *
 * Multi-replica coordination: when `instanceId` is set (K8s mode),
 * each replica registers as a cron instance, heartbeats, and only
 * schedules jobs assigned to it. Single-instance mode (local/dev)
 * skips coordination and schedules all active jobs.
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

// Coordination constants (tuned values from old CronCoordinator — commit 7c41fa6)
const RECONCILE_INTERVAL_MS = 15_000;  // 15s (includes heartbeat)
const DEAD_THRESHOLD_MS = 30_000;      // 30s = 2× reconcile interval

export type SendToUserFn = (userId: string, event: string, payload: Record<string, unknown>) => void;

export class CronService {
  readonly scheduler: CronScheduler;
  readonly instanceId: string | undefined;
  /** Channel notification callback — set by gateway-main after construction */
  onNotify?: (data: { userId: string; jobName: string; result: string; resultText: string; error?: string }) => void;

  private configRepo: ConfigRepository;
  private notifRepo: NotificationRepository;
  private sendToUser: SendToUserFn;
  private gatewayPort: number;
  private staleLockTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private sessionPurgeTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    configRepo: ConfigRepository;
    notifRepo: NotificationRepository;
    sendToUser: SendToUserFn;
    gatewayPort: number;
    instanceId?: string;
  }) {
    this.configRepo = opts.configRepo;
    this.notifRepo = opts.notifRepo;
    this.sendToUser = opts.sendToUser;
    this.gatewayPort = opts.gatewayPort;
    this.instanceId = opts.instanceId;
    this.scheduler = new CronScheduler((job) => this.execute(job));
  }

  /** Load all active jobs and start background timers */
  async start(): Promise<void> {
    // Register this instance (multi-replica mode only)
    if (this.instanceId) {
      const endpoint = `http://${process.env.SICLAW_POD_IP || "localhost"}:${this.gatewayPort}`;
      await this.configRepo.registerCronInstance(this.instanceId, endpoint);
    }

    // Initial reconcile — loads jobs (all in single-instance, assigned in multi)
    await this.reconcile();

    // Reconcile loop (15s — includes heartbeat in multi-replica mode)
    if (this.instanceId) {
      this.reconcileTimer = setInterval(() => this.reconcileTick(), RECONCILE_INTERVAL_MS);
      this.reconcileTimer.unref();
    }

    // Stale lock cleanup every 6 minutes (single-instance keeps this too)
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

    console.log(`[cron-service] Started${this.instanceId ? ` (instance=${this.instanceId})` : ""}`);
  }

  // ── Coordination (ported from old CronCoordinator — commit 7c41fa6) ───

  /** Main reconcile loop — single-instance fast path or full coordination */
  private async reconcile(): Promise<void> {
    if (!this.instanceId) {
      // Single-instance: schedule everything (backward compatible)
      const jobs = await this.configRepo.listAllActiveCronJobs();
      for (const job of jobs) this.scheduler.addOrUpdate(job as CronJobRow);
      console.log(`[cron-service] Loaded ${jobs.length} active jobs`);
      return;
    }

    // 0. Heartbeat
    await this.configRepo.updateHeartbeat(this.instanceId, this.scheduler.jobCount);

    // 1. Clear stale execution locks
    await this.configRepo.clearStaleLocks(STALE_LOCK_CLEANUP_MS);

    // 2. Detect dead instances → reassign orphaned jobs
    const dead = await this.configRepo.getDeadInstances(DEAD_THRESHOLD_MS);
    for (const inst of dead) {
      const target = await this.configRepo.getLeastLoadedInstance(DEAD_THRESHOLD_MS);
      if (target) {
        await this.configRepo.reassignOrphanedJobs(inst.instanceId, target.instanceId);
        console.log(`[cron-service] Reassigned jobs from dead instance ${inst.instanceId} → ${target.instanceId}`);
      }
      await this.configRepo.deleteInstance(inst.instanceId);
    }

    // 3. Cancel stale local timers (DB deleted/paused/reassigned)
    await this.cancelStaleJobs();

    // 4. Claim unassigned jobs (only if we are least-loaded)
    await this.claimUnassignedJobs();

    // 5. Sync: load DB-assigned jobs missing from local scheduler
    await this.syncAssignedJobs();
  }

  /** Claim unassigned active jobs — only if this instance is least-loaded */
  private async claimUnassignedJobs(): Promise<void> {
    const unassigned = await this.configRepo.getUnassignedActiveJobs();
    if (!unassigned.length) return;

    for (const job of unassigned) {
      const leastLoaded = await this.configRepo.getLeastLoadedInstance(DEAD_THRESHOLD_MS);
      if (!leastLoaded) break;
      if (leastLoaded.instanceId !== this.instanceId!) break; // not least-loaded, let another instance claim

      const claimed = await this.configRepo.claimUnassignedJob(job.id, this.instanceId!);
      if (!claimed) continue; // another instance claimed first

      await this.configRepo.updateHeartbeat(this.instanceId!, this.scheduler.jobCount + 1);
      this.scheduler.addOrUpdate(job as CronJobRow);
      console.log(`[cron-service] Claimed job ${job.id} (${job.name})`);
    }
  }

  /** Cancel local timers for jobs that are deleted/paused/reassigned in DB */
  private async cancelStaleJobs(): Promise<void> {
    for (const jobId of this.scheduler.scheduledJobIds) {
      const dbJob = await this.configRepo.getCronJobById(jobId);
      if (!dbJob || dbJob.status !== "active" || dbJob.assignedTo !== this.instanceId) {
        this.scheduler.cancel(jobId);
      }
    }
  }

  /** Load DB-assigned jobs that are missing from local scheduler */
  private async syncAssignedJobs(): Promise<void> {
    const dbJobs = await this.configRepo.listCronJobsByInstance(this.instanceId!);
    const scheduled = new Set(this.scheduler.scheduledJobIds);
    for (const job of dbJobs) {
      if (!scheduled.has(job.id)) {
        this.scheduler.addOrUpdate(job as CronJobRow);
      }
    }
  }

  /** Timer callback for reconcile loop */
  private async reconcileTick(): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      console.warn("[cron-service] Reconcile failed:", err instanceof Error ? err.message : err);
    }
  }

  // ── Job execution ─────────────────────────────────────────────────────

  /** Execute a single cron job */
  private async execute(job: CronJobRow): Promise<void> {
    // Re-validate from DB
    const current = await this.configRepo.getCronJobById(job.id);
    if (!current || current.status !== "active") {
      console.log(`[cron-service] Job ${job.id} no longer active, skipping`);
      return;
    }

    // In multi-replica mode, verify we still own this job
    if (this.instanceId && current.assignedTo !== this.instanceId) {
      console.log(`[cron-service] Job ${job.id} reassigned to ${current.assignedTo}, skipping`);
      this.scheduler.cancel(job.id);
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

  /** Stop all timers and clean up. Deregisters instance in multi-replica mode. */
  async stop(): Promise<void> {
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
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    // Deregister instance and release jobs (multi-replica only)
    if (this.instanceId) {
      try {
        await this.configRepo.releaseInstanceJobs(this.instanceId);
        await this.configRepo.deleteInstance(this.instanceId);
      } catch (err) {
        console.warn("[cron-service] Deregister failed:", err instanceof Error ? err.message : err);
      }
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
  const parts = [
    `[System: You are executing an automated scheduled task in NON-INTERACTIVE mode.

Rules:
- Perform the task described below directly and report the result.
- Do NOT ask the user any questions or request confirmations — there is no user to respond.
- If multiple environments, hosts, or credentials are available, operate on ALL of them unless the task description specifies a particular target.
- Do NOT create, modify, delete, pause, or manage any schedules.
- Keep the output concise and structured.
- Respond in the same language as the task name and description below.]`,
    `Task: ${job.name}`,
  ];
  if (job.description) {
    parts.push(`Instructions: ${job.description}`);
  }
  if (job.skillId) {
    parts.push(`Execute skill: ${job.skillId}`);
  }
  return parts.join("\n\n");
}
