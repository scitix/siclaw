/**
 * Cron Scheduler — Event-driven, one setTimeout per job
 *
 * Pure timer manager. Each active job gets its own timer.
 * CRUD operations update timers in real-time.
 * DB coordination is handled by CronCoordinator.
 */

import { getNextCronDelay, getNextCronTime } from "./cron-matcher.js";

export interface CronJobRow {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  schedule: string;
  skillId: string | null;
  status: "active" | "paused";
  lastRunAt: Date | null;
  lastResult: string | null;
  assignedTo: string | null;
  lockedBy: string | null;
  lockedAt: Date | null;
  envId: string | null;
}

export type OnFireFn = (job: CronJobRow) => Promise<void>;

export class CronScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private jobs = new Map<string, CronJobRow>();
  private executing = new Set<string>();
  private onFire: OnFireFn;

  constructor(onFire: OnFireFn) {
    this.onFire = onFire;
  }

  /** Add or update a job — cancels old timer and reschedules */
  addOrUpdate(job: CronJobRow): void {
    this.cancel(job.id);
    this.jobs.set(job.id, job);
    if (job.status === "active") {
      this.scheduleNext(job);
      console.log(`[cron-scheduler] Scheduled job ${job.id} (${job.name})`);
    } else {
      console.log(`[cron-scheduler] Job ${job.id} (${job.name}) is paused, not scheduling`);
    }
  }

  /** Cancel a job's timer */
  cancel(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
    this.jobs.delete(jobId);
  }

  /** Schedule next fire for a job */
  private scheduleNext(job: CronJobRow): void {
    try {
      const delay = getNextCronDelay(job.schedule);
      const nextTime = getNextCronTime(job.schedule);

      console.log(
        `[cron-scheduler] Job ${job.id} (${job.name}) next fire at ${nextTime.toISOString()} (in ${Math.round(delay / 1000)}s)`,
      );

      const timer = setTimeout(async () => {
        this.timers.delete(job.id);

        // Guard against concurrent execution from race with addOrUpdate
        if (this.executing.has(job.id)) return;
        this.executing.add(job.id);

        console.log(`[cron-scheduler] Firing job ${job.id} (${job.name})`);
        try {
          await this.onFire(job);
        } catch (err) {
          console.error(`[cron-scheduler] Job ${job.id} fire error:`, err);
        } finally {
          this.executing.delete(job.id);
        }

        // Reschedule if still in our job list and active
        const current = this.jobs.get(job.id);
        if (current && current.status === "active") {
          this.scheduleNext(current);
        }
      }, delay);

      timer.unref();
      this.timers.set(job.id, timer);
    } catch (err) {
      console.error(`[cron-scheduler] Failed to schedule job ${job.id}:`, err);
    }
  }

  /** Stop all timers */
  stop(): void {
    for (const [, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.jobs.clear();
    console.log("[cron-scheduler] Stopped all timers");
  }

  /** Get current job count */
  get jobCount(): number {
    return this.timers.size;
  }

  /** Get IDs of all scheduled jobs (for reconciliation) */
  get scheduledJobIds(): string[] {
    return [...this.timers.keys()];
  }
}
