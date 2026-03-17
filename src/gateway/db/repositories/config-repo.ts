/**
 * Config Repository — channels, cron jobs, triggers
 */

import crypto from "node:crypto";
import { eq, and, isNull, isNotNull, gt, lte, asc, sql } from "drizzle-orm";
import type { Database } from "../index.js";
import { channels, cronJobs, cronJobRuns, cronInstances, triggers } from "../schema.js";
import { isUniqueViolation } from "../dialect-helpers.js";

export class ConfigRepository {
  constructor(private db: Database) {}

  // ─── Channels ────────────────────────────────

  async listChannels(userId: string) {
    return this.db
      .select()
      .from(channels)
      .where(eq(channels.userId, userId));
  }

  async saveChannel(
    userId: string,
    channelType: string,
    enabled: boolean,
    config: Record<string, unknown>,
  ) {
    const existing = await this.db
      .select()
      .from(channels)
      .where(
        and(eq(channels.userId, userId), eq(channels.channelType, channelType)),
      )
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(channels)
        .set({ enabled, configJson: config })
        .where(
          and(
            eq(channels.userId, userId),
            eq(channels.channelType, channelType),
          ),
        );
    } else {
      await this.db.insert(channels).values({
        userId,
        channelType,
        enabled,
        configJson: config,
      });
    }
  }

  // ─── Cron Jobs ────────────────────────────────

  async listCronJobs(userId: string, opts?: { workspaceId?: string }) {
    const conditions = [eq(cronJobs.userId, userId)];
    if (opts?.workspaceId !== undefined) {
      conditions.push(eq(cronJobs.workspaceId, opts.workspaceId));
    }
    return this.db
      .select()
      .from(cronJobs)
      .where(and(...conditions));
  }

  async saveCronJob(
    userId: string,
    job: {
      id?: string;
      name: string;
      description?: string;
      schedule: string;
      skillId?: string;
      status?: "active" | "paused";
      workspaceId?: string | null;
    },
  ) {
    const id = job.id || crypto.randomUUID();
    const existing = job.id
      ? await this.db
          .select()
          .from(cronJobs)
          .where(eq(cronJobs.id, job.id))
          .limit(1)
      : [];

    if (existing.length > 0) {
      await this.db
        .update(cronJobs)
        .set({
          name: job.name,
          description: job.description ?? null,
          schedule: job.schedule,
          skillId: job.skillId ?? null,
          status: job.status ?? "active",
          workspaceId: job.workspaceId ?? null,
        })
        .where(eq(cronJobs.id, id));
    } else {
      await this.db.insert(cronJobs).values({
        id,
        userId,
        name: job.name,
        description: job.description ?? null,
        schedule: job.schedule,
        skillId: job.skillId ?? null,
        status: job.status ?? "active",
        workspaceId: job.workspaceId ?? null,
      });
    }
    return id;
  }

  async deleteCronJob(id: string) {
    await this.db.delete(cronJobs).where(eq(cronJobs.id, id));
  }

  async getCronJobById(id: string) {
    const rows = await this.db
      .select()
      .from(cronJobs)
      .where(eq(cronJobs.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async listAllActiveCronJobs() {
    return this.db
      .select()
      .from(cronJobs)
      .where(eq(cronJobs.status, "active"));
  }

  async listCronJobsByInstance(instanceId: string) {
    return this.db
      .select()
      .from(cronJobs)
      .where(
        and(eq(cronJobs.status, "active"), eq(cronJobs.assignedTo, instanceId)),
      );
  }

  async updateCronJobRun(id: string, result: "success" | "failure") {
    await this.db
      .update(cronJobs)
      .set({ lastRunAt: new Date(), lastResult: result })
      .where(eq(cronJobs.id, id));
  }

  // ─── Cron Job Runs (execution history) ──────

  async insertCronJobRun(params: {
    jobId: string;
    status: "success" | "failure";
    resultText?: string;
    error?: string;
    durationMs?: number;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(cronJobRuns).values({
      id,
      jobId: params.jobId,
      status: params.status,
      resultText: params.resultText ?? null,
      error: params.error ?? null,
      durationMs: params.durationMs ?? null,
    });
    return id;
  }

  async listCronJobRuns(jobId: string, limit = 20) {
    return this.db
      .select()
      .from(cronJobRuns)
      .where(eq(cronJobRuns.jobId, jobId))
      .orderBy(sql`${cronJobRuns.createdAt} DESC`)
      .limit(limit);
  }

  async assignCronJob(jobId: string, instanceId: string) {
    await this.db
      .update(cronJobs)
      .set({ assignedTo: instanceId })
      .where(eq(cronJobs.id, jobId));
  }

  /** Atomically claim an unassigned job — returns true if claimed by us */
  async claimUnassignedJob(jobId: string, instanceId: string): Promise<boolean> {
    await this.db
      .update(cronJobs)
      .set({ assignedTo: instanceId })
      .where(
        and(eq(cronJobs.id, jobId), isNull(cronJobs.assignedTo)),
      );
    // Verify by reading back — safe for both MySQL and SQLite (avoids sql.js getRowsModified race)
    const row = await this.db
      .select({ assignedTo: cronJobs.assignedTo })
      .from(cronJobs)
      .where(eq(cronJobs.id, jobId))
      .limit(1);
    return row[0]?.assignedTo === instanceId;
  }

  // ─── Cron Instances ──────────────────────────────

  async registerCronInstance(instanceId: string, endpoint: string) {
    try {
      await this.db
        .insert(cronInstances)
        .values({ instanceId, endpoint });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Already registered — update heartbeat
      await this.db
        .update(cronInstances)
        .set({ endpoint, heartbeatAt: new Date(), jobCount: 0 })
        .where(eq(cronInstances.instanceId, instanceId));
    }
  }

  async updateHeartbeat(instanceId: string, jobCount: number) {
    await this.db
      .update(cronInstances)
      .set({ heartbeatAt: new Date(), jobCount })
      .where(eq(cronInstances.instanceId, instanceId));
  }

  async listAliveInstances(thresholdMs: number = 90_000) {
    const cutoff = new Date(Date.now() - thresholdMs);
    return this.db
      .select()
      .from(cronInstances)
      .where(gt(cronInstances.heartbeatAt, cutoff));
  }

  async getDeadInstances(thresholdMs: number = 90_000) {
    const cutoff = new Date(Date.now() - thresholdMs);
    return this.db
      .select()
      .from(cronInstances)
      .where(sql`${cronInstances.heartbeatAt} <= ${cutoff}`);
  }

  async getAllCronInstances(thresholdMs: number = 90_000) {
    const cutoff = new Date(Date.now() - thresholdMs);
    return this.db
      .select({ instanceId: cronInstances.instanceId, endpoint: cronInstances.endpoint })
      .from(cronInstances)
      .where(gt(cronInstances.heartbeatAt, cutoff));
  }

  async getLeastLoadedInstance(thresholdMs: number = 90_000) {
    const cutoff = new Date(Date.now() - thresholdMs);
    const rows = await this.db
      .select()
      .from(cronInstances)
      .where(gt(cronInstances.heartbeatAt, cutoff))
      .orderBy(asc(cronInstances.jobCount))
      .limit(1);
    return rows[0] ?? null;
  }

  async reassignOrphanedJobs(deadInstanceId: string, targetInstanceId: string) {
    await this.db
      .update(cronJobs)
      .set({ assignedTo: targetInstanceId })
      .where(
        and(
          eq(cronJobs.assignedTo, deadInstanceId),
          eq(cronJobs.status, "active"),
        ),
      );
  }

  async releaseInstanceJobs(instanceId: string) {
    await this.db
      .update(cronJobs)
      .set({ assignedTo: null })
      .where(eq(cronJobs.assignedTo, instanceId));
  }

  async deleteInstance(instanceId: string) {
    await this.db
      .delete(cronInstances)
      .where(eq(cronInstances.instanceId, instanceId));
  }

  async getUnassignedActiveJobs() {
    return this.db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.status, "active"), isNull(cronJobs.assignedTo)));
  }

  /** Atomically lock a job for execution — returns true if locked by us */
  async lockJobForExecution(jobId: string, executionId: string): Promise<boolean> {
    await this.db
      .update(cronJobs)
      .set({ lockedBy: executionId, lockedAt: new Date() })
      .where(
        and(eq(cronJobs.id, jobId), isNull(cronJobs.lockedBy)),
      );
    // Verify by reading back (same pattern as claimUnassignedJob)
    const row = await this.db
      .select({ lockedBy: cronJobs.lockedBy })
      .from(cronJobs)
      .where(eq(cronJobs.id, jobId))
      .limit(1);
    return row[0]?.lockedBy === executionId;
  }

  /** Unlock a job after execution (only if still locked by us) */
  async unlockJob(jobId: string, executionId: string): Promise<void> {
    await this.db
      .update(cronJobs)
      .set({ lockedBy: null, lockedAt: null })
      .where(
        and(eq(cronJobs.id, jobId), eq(cronJobs.lockedBy, executionId)),
      );
  }

  /** Clear locks older than thresholdMs (stale lock cleanup) */
  async clearStaleLocks(thresholdMs: number): Promise<void> {
    const cutoff = new Date(Date.now() - thresholdMs);
    await this.db
      .update(cronJobs)
      .set({ lockedBy: null, lockedAt: null })
      .where(
        and(
          isNotNull(cronJobs.lockedBy),
          lte(cronJobs.lockedAt, cutoff),
        ),
      );
  }

  // ─── Cron Limits Queries ─────────────────────────

  /** Count active (non-paused) jobs owned by a user */
  async countActiveJobsByUser(userId: string): Promise<number> {
    const rows = await this.db
      .select({ cnt: sql<number>`count(*)` })
      .from(cronJobs)
      .where(and(eq(cronJobs.userId, userId), eq(cronJobs.status, "active")));
    return Number(rows[0]?.cnt ?? 0);
  }

  /** Count jobs currently locked for execution (lockedBy IS NOT NULL) */
  async countCurrentlyExecutingJobs(): Promise<number> {
    const rows = await this.db
      .select({ cnt: sql<number>`count(*)` })
      .from(cronJobs)
      .where(isNotNull(cronJobs.lockedBy));
    return Number(rows[0]?.cnt ?? 0);
  }

  // ─── Triggers ─────────────────────────────────

  async listTriggers(userId: string) {
    return this.db
      .select()
      .from(triggers)
      .where(eq(triggers.userId, userId));
  }

  async saveTrigger(
    userId: string,
    trigger: {
      id?: string;
      name: string;
      type: "webhook" | "websocket";
      status?: "active" | "inactive";
      secret?: string;
      config?: Record<string, unknown>;
    },
  ) {
    const id = trigger.id || crypto.randomUUID();
    const existing = trigger.id
      ? await this.db
          .select()
          .from(triggers)
          .where(eq(triggers.id, trigger.id))
          .limit(1)
      : [];

    if (existing.length > 0) {
      await this.db
        .update(triggers)
        .set({
          name: trigger.name,
          type: trigger.type,
          status: trigger.status ?? "active",
          secret: trigger.secret ?? null,
          configJson: trigger.config ?? null,
        })
        .where(eq(triggers.id, id));
    } else {
      await this.db.insert(triggers).values({
        id,
        userId,
        name: trigger.name,
        type: trigger.type,
        status: trigger.status ?? "active",
        secret: trigger.secret ?? null,
        configJson: trigger.config ?? null,
      });
    }
    return id;
  }

  async getTriggerById(id: string) {
    const rows = await this.db
      .select()
      .from(triggers)
      .where(eq(triggers.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async deleteTrigger(userId: string, id: string) {
    await this.db.delete(triggers).where(and(eq(triggers.id, id), eq(triggers.userId, userId)));
  }
}
