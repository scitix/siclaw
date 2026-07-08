/**
 * Unified background-job registry.
 *
 * Both background modes — detached sub-agents (`spawn_subagent run_in_background`)
 * and background bash commands (`bash run_in_background`) — register here, so they
 * share one completion-notification path, one `job_stop` surface, and one dedup latch.
 *
 * Modeled on Claude Code's `AppState.tasks` (Task.ts) + the `notified` flag dedup in
 * LocalShellTask (`enqueueShellNotification` / `markTaskNotified`). The key invariant:
 * a job's completion notification is sent EXACTLY once, even when the process-exit
 * handler and `job_stop` race to send it. `claimNotification()` is the atomic gate.
 *
 * One registry instance per parent runtime: the agentbox session manager owns one
 * (replacing the old inline `subagentJobs` map); the TUI host owns its own.
 */

import type { JobStopResult, TaskOutputSnapshot } from "./tool-registry.js";

export type JobType = "subagent" | "bash" | "node" | "pod" | "host" | "local";

/**
 * Terminal + live states a background job can be in. A superset of SpawnSubagentStatus's
 * terminal values, so a sub-agent's terminal status assigns straight into a JobStatus.
 */
export type JobStatus =
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "stopped"
  | "timed_out"
  // sub-agent-specific terminal variants (kept so the capsule summary reads naturally)
  | "done"
  | "partial";

/** A job is terminal when it will not transition further. */
export function isTerminalJobStatus(status: JobStatus): boolean {
  return status !== "running";
}

export interface JobRecord {
  jobId: string;
  type: JobType;
  /** The session that spawned this job — where its completion notification is delivered. */
  parentSessionId: string;
  /** Short, model-facing label (the spawn description / command description). */
  description: string;
  status: JobStatus;
  startedAt: number;
  /**
   * Dedup latch. Set to true by whoever sends the completion notification first
   * (the process-exit handler OR job_stop). Guarded by {@link JobRegistry.claimNotification}.
   */
  notified: boolean;
  /**
   * Set when the job was stopped by the USER's Stop button (not the model's job_stop tool, and
   * not natural completion). The completion still folds the launching card to "stopped", but the
   * parent is NOT woken with a synthetic turn — a user Stop is terminal; the model reacting to its
   * own cancellation is exactly the "it won't stop" behavior the Stop button must avoid.
   */
  suppressNotifyTurn?: boolean;
  /**
   * Kill hook. subagent → requestStop(); bash → process.kill(-pid, SIGKILL).
   * Undefined while the job is still starting up (no PID/controller yet).
   */
  abort?: () => void;
  // ── subagent-only ───────────────────────────────────────────────
  childSessionId?: string;
  /**
   * Set on a `spawn_subagent` batch (map→reduce) job. The job `type` stays "subagent" (reused
   * deliberately so the three `type === "subagent"` branches — notifyParent event routing,
   * background-bash concurrency exclusion, stopJob wording — stay correct without a new
   * JobType). This flag is display/stats-only, so a group can be told apart from a single
   * sub-agent where that matters (e.g. the Jobs bar / group card).
   */
  isGroup?: boolean;
  // ── bash-only ───────────────────────────────────────────────────
  /** Absolute path to the streamed output file, under <userDataDir>/agent/tasks/. */
  outputFile?: string;
  exitCode?: number;
}

export class JobRegistry {
  private jobs = new Map<string, JobRecord>();

  register(rec: JobRecord): void {
    this.jobs.set(rec.jobId, rec);
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Atomic compare-and-set on `notified`. Returns true EXACTLY ONCE for a given job
   * — the first caller wins and may send the notification; every later caller gets
   * false and must stay silent. Returns false for an unknown job.
   *
   * Single-threaded JS guarantees atomicity: the read + write happen with no
   * intervening `await`, so two synchronous callers cannot both observe `false`.
   */
  claimNotification(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.notified) return false;
    job.notified = true;
    return true;
  }

  setStatus(jobId: string, status: JobStatus, patch?: Partial<JobRecord>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = status;
    if (patch) Object.assign(job, patch);
  }

  /** Attach the kill hook once the underlying process/controller exists. */
  setAbort(jobId: string, abort: () => void): void {
    const job = this.jobs.get(jobId);
    if (job) job.abort = abort;
  }

  /**
   * Project a job to the status shape the task_output tool consumes. One owner of the
   * registry→snapshot mapping so the agentbox and TUI readers can't drift.
   */
  snapshot(jobId: string): TaskOutputSnapshot {
    const job = this.jobs.get(jobId);
    return job
      ? { found: true, status: job.status, exitCode: job.exitCode, outputFile: job.outputFile }
      : { found: false };
  }

  /** All jobs, optionally filtered to one parent session. */
  list(parentSessionId?: string): JobRecord[] {
    const all = [...this.jobs.values()];
    return parentSessionId
      ? all.filter((j) => j.parentSessionId === parentSessionId)
      : all;
  }

  delete(jobId: string): void {
    this.jobs.delete(jobId);
  }

  /**
   * Stop a running job: fire its kill hook and mark it "stopped". Shared by both runtimes
   * (agentbox + TUI) so the guard sequence and the stopped-status transition can't drift.
   * The message wording adapts to the job type ("sub-agent" vs "command").
   */
  stopJob(jobId: string, opts?: { suppressNotifyTurn?: boolean }): JobStopResult {
    const job = this.jobs.get(jobId);
    if (!job) return { stopped: false, message: `No background job "${jobId}".` };
    if (job.status !== "running") return { stopped: false, message: `Job "${jobId}" is not running (${job.status}).` };
    if (!job.abort) return { stopped: false, message: `Job "${jobId}" is starting up; try again shortly.` };
    // Set BEFORE abort() so the (later, async) settle → notifyParent already sees the flag.
    if (opts?.suppressNotifyTurn) job.suppressNotifyTurn = true;
    job.abort();
    this.setStatus(jobId, "stopped");
    return { stopped: true, message: `Stopping background ${job.type === "subagent" ? "sub-agent" : "command"} "${jobId}".` };
  }
}
