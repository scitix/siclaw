/**
 * Cron Scheduler — Event-driven, one setTimeout per job
 *
 * Pure timer manager. Each active job gets its own timer.
 * CRUD operations update timers in real-time.
 */

import { getNextCronDelay, getNextCronTime } from "./cron-matcher.js";

export interface CronJobRow {
  id: string;
  name: string;
  description: string | null;
  schedule: string;
  status: "active" | "paused";
  lastRunAt: Date | null;
  lastResult: string | null;
  // Gateway uses these:
  userId?: string;
  skillId?: string | null;
  assignedTo?: string | null;
  lockedBy?: string | null;
  lockedAt?: Date | null;
  workspaceId?: string | null;
  agentId?: string | null;
  // Portal uses these:
  prompt?: string;
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

  /**
   * Add or update a job.
   *
   * Idempotent on purpose: the reconcile loop re-sends every active job on a fixed
   * interval, almost always unchanged. Re-arming an identical timer each pass is churn
   * that also drowned the log — two lines per job per pass, so a busy runtime's log was
   * mostly this. An already-armed job whose scheduling inputs (`schedule`, `status`)
   * did not change is left alone. The stored row is refreshed either way, and the fire
   * path reads it back, so a changed prompt/agent still takes effect on the next fire
   * without a re-arm.
   *
   * A job mid-fire has no timer — the fire path re-arms when it finishes — so a pass
   * that lands there DOES arm one. That is deliberate: it is the only thing that gets a
   * job whose fire never settles (a hang before the execution timeout is armed) back on
   * a schedule. Arming is safe because {@link scheduleNext} replaces whatever timer the
   * job already has instead of leaving a second one running.
   */
  addOrUpdate(job: CronJobRow): void {
    const prev = this.jobs.get(job.id);
    this.jobs.set(job.id, job);

    if (job.status !== "active") {
      this.clearTimer(job.id);
      if (prev?.status !== job.status) {
        console.log(`[cron-scheduler] Job ${job.id} (${job.name}) is paused, not scheduling`);
      }
      return;
    }

    const unchanged = prev?.schedule === job.schedule && prev?.status === job.status;
    if (this.timers.has(job.id) && unchanged) return;

    this.scheduleNext(job);
    // Announce a real (re)schedule only. Nothing armed means scheduleNext rejected the
    // expression and already said so; a mid-fire arm is a safety net, not news.
    if (this.timers.has(job.id) && !this.executing.has(job.id)) {
      console.log(`[cron-scheduler] Scheduled job ${job.id} (${job.name})`);
    }
  }

  /** Cancel a job's timer */
  cancel(jobId: string): void {
    this.clearTimer(jobId);
    this.jobs.delete(jobId);
  }

  /** Drop a job's timer without forgetting the job itself. */
  private clearTimer(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
  }

  /**
   * Schedule next fire for a job.
   *
   * Replaces the job's timer rather than adding one: both callers (a re-schedule and the
   * fire path's tail) can reach a job that already has one armed, and `timers` holds a
   * single handle per job — so setting without clearing would drop a live timer out of
   * the map, where neither `cancel()` nor `stop()` can ever reach it and it fires the
   * job a second time.
   */
  private scheduleNext(job: CronJobRow): void {
    this.clearTimer(job.id);
    try {
      const delay = getNextCronDelay(job.schedule);
      const nextTime = getNextCronTime(job.schedule);

      console.log(
        `[cron-scheduler] Job ${job.id} (${job.name}) next fire at ${nextTime.toISOString()} (in ${Math.round(delay / 1000)}s)`,
      );

      const timer = setTimeout(async () => {
        this.timers.delete(job.id);

        if (this.executing.has(job.id)) {
          // The previous fire has not finished. Skipping this one is right — two runs of
          // the same job must not overlap — but returning bare would leave the job with no
          // timer at all until a reconcile pass noticed, and none is guaranteed to come.
          this.scheduleNext(this.jobs.get(job.id) ?? job);
          return;
        }
        this.executing.add(job.id);

        // Fire the row as it stands now, not as it looked when the timer was armed —
        // an unchanged schedule keeps its timer across reconciles, so the captured
        // `job` can be several syncs stale (different prompt, agent, name).
        const firing = this.jobs.get(job.id) ?? job;
        console.log(`[cron-scheduler] Firing job ${firing.id} (${firing.name})`);
        try {
          await this.onFire(firing);
        } catch (err) {
          console.error(`[cron-scheduler] Job ${job.id} fire error:`, err);
        } finally {
          this.executing.delete(job.id);
        }

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

  get jobCount(): number {
    return this.timers.size;
  }

  /** Get IDs of all scheduled jobs (for reconciliation) */
  get scheduledJobIds(): string[] {
    return [...this.timers.keys()];
  }
}
