/**
 * TUI-side background-job host.
 *
 * The TUI (cli-main) has no agentbox session manager and no HTTP /prompt loop — the
 * agent is parked in pi's interactive `getUserInput()` when idle. This host owns the
 * JobRegistry for the single TUI session and delivers a completed background job's
 * <task_notification> back into the agent:
 *
 *  - agent streaming  → sendCustomMessage(deliverAs: "followUp"): rides the running turn.
 *  - agent idle       → sendCustomMessage(triggerTurn: true): pi's AgentSession routes a
 *                       not-streaming triggerTurn through agent.prompt(), starting a fresh
 *                       turn (followUp alone does NOT wake an idle agent).
 *
 * Background bash AND node_exec/pod_exec are all wired for the TUI — they share one
 * executor (spawnBackgroundBash handles both the shell and the kubectl-exec argv forms).
 * Only background SUB-AGENTS are unavailable here: they need the agentbox child-session
 * machinery, which the TUI lacks.
 *
 * Delivery is not session-scoped: the JobRegistry is per-host (not per chat session), and a
 * job that completes after a /new or /fork notifies whatever session is current. The TUI has
 * only ONE live AgentSession at a time (the prior one is gone), so delivering the completion
 * to the current session surfaces it rather than dropping it — intentional for a single-user
 * terminal where losing a "your background job finished" notice is worse than minor context drift.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { JobRegistry } from "./job-registry.js";
import { spawnBackgroundBash } from "./background-bash-runner.js";
import { getBackgroundBashConcurrency } from "./subagent-registry.js";
import { buildTaskNotificationText, type TaskNotification } from "./task-notification.js";
import type {
  BackgroundExecExecutor,
  JobStopExecutor,
} from "./tool-registry.js";

export class TuiBackgroundHost {
  private jobs = new JobRegistry();
  // Updated on every session swap (/new, /resume, /fork) so a job that completes after a
  // swap still notifies whatever session is current. Single-user TUI → not session-scoped.
  private sessionRef: { current: AgentSession | null } = { current: null };

  setSession(session: AgentSession): void {
    this.sessionRef.current = session;
  }

  /**
   * Abort all still-running jobs. Call on TUI shutdown (SIGINT/SIGTERM/exit): background
   * children are spawned `detached` and are their own process-group leaders, so terminal
   * SIGINT does NOT reach them — without this they orphan in the host/pod. Best-effort,
   * synchronous (process-group SIGKILL), safe to call more than once.
   */
  shutdown(): void {
    for (const job of this.jobs.list()) {
      if (job.status === "running" && job.abort) {
        try {
          job.abort();
        } catch {
          /* already gone */
        }
      }
    }
  }

  createBackgroundExecExecutor(): BackgroundExecExecutor {
    return (req) => {
      // Same per-session concurrency cap as the agentbox path — without it the TUI could
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

  private notify(jobId: string, n: TaskNotification): void {
    if (!this.jobs.claimNotification(jobId)) return;
    const session = this.sessionRef.current;
    if (!session) return;
    const text = buildTaskNotificationText(n);
    const message = {
      customType: "task-notification",
      content: text,
      display: true,
      details: { jobId, status: n.status },
    };
    if (session.isStreaming) {
      // A turn is running — queue to it; delivered when the agent would otherwise stop.
      void session.sendCustomMessage(message, { deliverAs: "followUp" }).catch(() => {});
    } else {
      // Idle — wake a fresh turn. Fall back to followUp if the user started a turn
      // in the same tick (sendCustomMessage re-checks isStreaming internally).
      void session
        .sendCustomMessage(message, { deliverAs: "followUp", triggerTurn: true })
        .catch(() =>
          session.sendCustomMessage(message, { deliverAs: "followUp" }).catch(() => {}),
        );
    }
  }
}
