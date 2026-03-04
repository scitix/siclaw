/**
 * Cron Coordinator — Multi-instance coordination
 *
 * Handles:
 * - Instance registration + heartbeat
 * - Dead instance detection + orphan job claiming
 * - Graceful shutdown (release jobs immediately)
 */

import type { GatewayClient } from "./gateway-client.js";
import type { CronScheduler } from "./cron-scheduler.js";

const HEARTBEAT_INTERVAL_MS = 30_000; // 30s
const RECONCILE_INTERVAL_MS = 60_000; // 60s
const DEAD_THRESHOLD_MS = 90_000; // 90s

export class CronCoordinator {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(
    private instanceId: string,
    private endpoint: string,
    private configRepo: GatewayClient,
    private scheduler: CronScheduler,
  ) {}

  /** Register instance and start heartbeat + reconciliation loops */
  async start(): Promise<void> {
    // Register ourselves
    await this.configRepo.registerCronInstance(this.instanceId, this.endpoint);
    console.log(
      `[coordinator] Registered instance ${this.instanceId} at ${this.endpoint}`,
    );

    // Immediately reconcile: detect dead instances + claim orphaned/unassigned jobs
    await this.reconcile();

    // Load our assigned jobs into the scheduler
    const myJobs = await this.configRepo.listCronJobsByInstance(this.instanceId);
    console.log(
      `[coordinator] Loading ${myJobs.length} jobs assigned to this instance`,
    );
    for (const job of myJobs) {
      this.scheduler.addOrUpdate(job as Parameters<typeof this.scheduler.addOrUpdate>[0]);
    }

    // Start heartbeat loop
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.configRepo.updateHeartbeat(
          this.instanceId,
          this.scheduler.jobCount,
        );
      } catch (err) {
        console.error("[coordinator] Heartbeat failed:", err);
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();

    // Start reconciliation loop
    this.reconcileTimer = setInterval(async () => {
      try {
        await this.reconcile();
      } catch (err) {
        console.error("[coordinator] Reconcile failed:", err);
      }
    }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();

    console.log(
      `[coordinator] Started — heartbeat every ${HEARTBEAT_INTERVAL_MS / 1000}s, reconcile every ${RECONCILE_INTERVAL_MS / 1000}s`,
    );
  }

  /** Claim unassigned active jobs and schedule them */
  private async claimUnassignedJobs(): Promise<void> {
    const unassigned = await this.configRepo.getUnassignedActiveJobs();
    if (unassigned.length === 0) return;

    for (const job of unassigned) {
      // Re-check least-loaded each iteration (our count changes as we claim)
      const leastLoaded = await this.configRepo.getLeastLoadedInstance(
        DEAD_THRESHOLD_MS,
      );
      if (leastLoaded && leastLoaded.instanceId === this.instanceId) {
        // Atomic claim — only succeeds if job is still unassigned
        const claimed = await this.configRepo.claimUnassignedJob(
          job.id,
          this.instanceId,
        );
        if (!claimed) continue; // Another instance claimed it first

        await this.configRepo.updateHeartbeat(
          this.instanceId,
          this.scheduler.jobCount + 1,
        );
        // Schedule immediately
        this.scheduler.addOrUpdate(
          job as Parameters<typeof this.scheduler.addOrUpdate>[0],
        );
        console.log(
          `[coordinator] Claimed unassigned job ${job.id} (${job.name})`,
        );
      } else {
        // Another instance is less loaded, let them claim it
        break;
      }
    }
  }

  /** Detect dead instances and claim their orphaned jobs */
  private async reconcile(): Promise<void> {
    // 1. Find dead instances
    const deadInstances = await this.configRepo.getDeadInstances(
      DEAD_THRESHOLD_MS,
    );

    for (const dead of deadInstances) {
      console.log(
        `[coordinator] Detected dead instance ${dead.instanceId} (last heartbeat: ${dead.heartbeatAt.toISOString()})`,
      );

      // Reassign orphaned jobs to least-loaded alive instance
      const leastLoaded = await this.configRepo.getLeastLoadedInstance(
        DEAD_THRESHOLD_MS,
      );
      if (!leastLoaded) {
        console.warn("[coordinator] No alive instances to reassign jobs to");
        continue;
      }

      await this.configRepo.reassignOrphanedJobs(
        dead.instanceId,
        leastLoaded.instanceId,
      );

      // Clean up dead instance record
      await this.configRepo.deleteInstance(dead.instanceId);
      console.log(
        `[coordinator] Reassigned jobs from ${dead.instanceId} → ${leastLoaded.instanceId}, removed dead instance`,
      );

      // If we got the jobs, load them into our scheduler
      if (leastLoaded.instanceId === this.instanceId) {
        const newJobs = await this.configRepo.listCronJobsByInstance(
          this.instanceId,
        );
        for (const job of newJobs) {
          // addOrUpdate is idempotent — won't duplicate existing timers
          this.scheduler.addOrUpdate(
            job as Parameters<typeof this.scheduler.addOrUpdate>[0],
          );
        }
      }
    }

    // 2. Cancel jobs that are no longer active in DB (handles missed pause/delete notifications)
    await this.cancelStaleJobs();

    // 3. Claim any unassigned jobs (from new cron.save or graceful shutdown)
    await this.claimUnassignedJobs();
  }

  /** Cancel scheduled jobs whose DB status is no longer active */
  private async cancelStaleJobs(): Promise<void> {
    const scheduledIds = this.scheduler.scheduledJobIds;
    if (scheduledIds.length === 0) return;

    for (const jobId of scheduledIds) {
      try {
        const dbJob = await this.configRepo.getCronJobById(jobId);
        if (!dbJob || dbJob.status !== "active" || dbJob.assignedTo !== this.instanceId) {
          this.scheduler.cancel(jobId);
          console.log(
            `[coordinator] Cancelled stale job ${jobId} (${
              !dbJob ? "deleted" : dbJob.status !== "active" ? "paused" : "reassigned"
            })`,
          );
        }
      } catch (err) {
        console.warn(`[coordinator] Failed to check job ${jobId}:`, err);
      }
    }
  }

  /** Graceful shutdown — release all jobs immediately so other instances can claim them */
  async shutdown(): Promise<void> {
    // Stop loops
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    // Release all our jobs (set assignedTo = null)
    await this.configRepo.releaseInstanceJobs(this.instanceId);

    // Remove ourselves from instances table
    await this.configRepo.deleteInstance(this.instanceId);

    console.log(
      `[coordinator] Shutdown complete — released jobs and deregistered instance ${this.instanceId}`,
    );
  }
}
