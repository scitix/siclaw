/**
 * Background execution host for one non-interactive CLI session.
 * Shares the job registry, execution limits and cleanup policy with AgentBox.
 * Completed jobs can notify the active turn. The print runner owns completion;
 * background jobs must never start another turn after its final answer.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { JobRegistry } from "./job-registry.js";
import { spawnBackgroundBash } from "./background-bash-runner.js";
import { getBackgroundBashConcurrency } from "./subagent-registry.js";
import { buildTaskNotificationText, type TaskNotification } from "./task-notification.js";
import type {
  BackgroundExecExecutor,
  JobStopExecutor,
  TaskOutputReader,
} from "./tool-registry.js";
import { cleanupTaskOutput } from "../tools/cmd-exec/disk-output.js";

export class CliBackgroundHost {
  private jobs = new JobRegistry();
  private closed = false;
  // One invocation owns one session and its background jobs.
  private sessionRef: { current: AgentSession | null } = { current: null };

  setSession(session: AgentSession): void {
    if (this.closed) return;
    this.sessionRef.current = session;
  }

  /**
   * Abort all still-running jobs. Call on CLI shutdown (SIGINT/SIGTERM/exit): background
   * children are spawned `detached` and are their own process-group leaders, so terminal
   * SIGINT does NOT reach them — without this they orphan in the host/pod. Best-effort,
   * synchronous (process-group SIGKILL), safe to call more than once.
   */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.sessionRef.current = null;
    for (const job of this.jobs.list()) {
      if (job.status === "running") {
        // Mark before abort, including jobs still dialing SSH. The launcher
        // observes this state when an asynchronous connection becomes ready.
        this.jobs.setStatus(job.jobId, "stopped", { suppressNotifyTurn: true });
        try {
          job.abort?.();
        } catch {
          /* already gone */
        }
      }
      // The session is ending — the model won't read these again, so reclaim the output
      // files now rather than retaining them until the stale-output sweep.
      if (job.outputFile) void cleanupTaskOutput(job.jobId);
    }
  }

  createBackgroundExecExecutor(): BackgroundExecExecutor {
    return (req) => {
      if (this.closed) throw new Error("CLI background execution is closed.");
      // Same per-session concurrency cap as the agentbox path — without it the CLI could
      // launch unbounded detached jobs (each with a 5GB output file) and back-pressure
      // nothing. Throwing makes the calling tool fall back to a foreground run.
      const cap = getBackgroundBashConcurrency();
      const running = this.jobs
        .list(req.parentSessionId)
        .filter((j) => j.type !== "subagent" && j.status === "running").length;
      if (running >= cap) {
        throw new Error(
          `Background exec concurrency cap reached (${running}/${cap}); run this command in the foreground.`,
        );
      }
      return spawnBackgroundBash(req, this.jobs, (jobId, n) => this.notify(jobId, n));
    };
  }

  createJobStopExecutor(): JobStopExecutor {
    // Shared stop logic lives on JobRegistry (same as the agentbox path).
    return async (jobId) => this.jobs.stopJob(jobId);
  }

  createTaskOutputReader(): TaskOutputReader {
    return (jobId) => this.jobs.snapshot(jobId);
  }

  private notify(jobId: string, n: TaskNotification): void {
    if (this.closed) return;
    if (!this.jobs.claimNotification(jobId)) return;
    const session = this.sessionRef.current;
    if (!session?.isStreaming) return;
    const text = buildTaskNotificationText(n);
    const message = {
      customType: "task-notification",
      content: text,
      display: true,
      details: { jobId, status: n.status },
    };
    // Delivered before the active turn stops; never wake an idle print session.
    void session.sendCustomMessage(message, { deliverAs: "followUp" }).catch(() => {});
  }
}
