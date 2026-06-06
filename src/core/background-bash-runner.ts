/**
 * Runtime-agnostic background exec launcher (bash / node_exec / pod_exec).
 *
 * Shared by BOTH runtimes: the agentbox session manager and the TUI host each call
 * `spawnBackgroundBash` with their own JobRegistry and notify closure. The spawn +
 * disk-streaming + completion logic lives here once; only WHERE the notification is
 * delivered (followUp / synthetic prompt / TUI custom message) differs per runtime.
 *
 * Mirrors Claude Code's spawnShellTask: detach the process, stream output to disk,
 * and on exit fire a single completion notification. Command construction, security
 * validation, env, and any sudo/kubectl-exec wrapping are all done UPSTREAM in the
 * calling tool — this function only spawns the already-final command (shell string for
 * bash, or file+argv for node/pod's `kubectl exec …`).
 */

import { spawn } from "node:child_process";
import type { JobRegistry } from "./job-registry.js";
import type { TaskNotification } from "./task-notification.js";
import type { BackgroundExecRequest, BackgroundExecResult } from "./tool-registry.js";
import {
  DiskTaskOutput,
  getTaskOutputPath,
  SanitizingLineBuffer,
} from "../tools/cmd-exec/disk-output.js";

export type NotifyFn = (jobId: string, n: TaskNotification) => void;

/**
 * Launch `req.command` detached, streaming sanitized output to disk. Registers the
 * job, returns immediately, and fires `notify` exactly once on process exit.
 *
 * `onSettled` (optional) runs after the exit handler finishes — the agentbox uses it
 * to decrement `_backgroundWorkCount` and re-arm session release.
 */
export function spawnBackgroundBash(
  req: BackgroundExecRequest,
  jobs: JobRegistry,
  notify: NotifyFn,
  onSettled?: () => void,
): BackgroundExecResult {
  const outputFile = getTaskOutputPath(req.jobId);
  // One disk file, but a separate line buffer per stream so a partial (newline-less)
  // stdout line is never glued to the next stderr line.
  const disk = new DiskTaskOutput(req.jobId);
  const outSink = new SanitizingLineBuffer(disk, req.action, req.hasSensitiveKubectl);
  const errSink = new SanitizingLineBuffer(disk, req.action, req.hasSensitiveKubectl);
  const flushAll = async () => {
    try {
      await Promise.all([outSink.flush(), errSink.flush()]);
    } catch {
      /* best-effort flush */
    }
  };

  // spawn (not exec) so output streams to disk instead of buffering in memory — a long
  // background command can emit far more than exec's maxBuffer. detached:true makes the
  // child a process-group leader, so kill(-pid) reaps the whole tree (matches the
  // foreground group-kill). Two modes:
  //  - argv (node/pod): spawn the kubectl-exec binary + args WITHOUT a shell, so the
  //    nested `nsenter … <cmd>` is passed verbatim (no re-tokenizing/quoting).
  //  - shell (bash): run the already-wrapped string (incl. sudo -E -u sandbox in prod).
  const child =
    req.file != null
      ? spawn(req.file, req.args ?? [], { cwd: req.cwd, env: req.env, detached: true })
      : spawn(req.command!, { cwd: req.cwd, env: req.env, shell: "/bin/bash", detached: true });
  // Decode as UTF-8 via StringDecoder so a multibyte char split across two data chunks
  // is not corrupted into U+FFFD (raw Buffer.toString() per chunk would garble it).
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  // Settle (notify + onSettled) runs EXACTLY once. Node can emit both 'error' and 'close'
  // for one process; without this latch onSettled would double-decrement the parent's
  // background-work count and release the session while a sibling job still runs.
  let settled = false;
  const settle = async (status: "completed" | "failed" | "killed" | "stopped", code: number | null, summary: string) => {
    if (settled) return;
    settled = true;
    await flushAll();
    jobs.setStatus(req.jobId, status, code != null ? { exitCode: code } : undefined);
    // Per-job cleanup (e.g. node_exec unpins its debug pod) — before notify so the pod is
    // released even if notify throws. Independent of onSettled (parent work-count).
    try { req.onComplete?.(); } catch { /* best-effort */ }
    notify(req.jobId, { taskId: req.jobId, outputFile, status, summary });
    onSettled?.();
  };

  jobs.register({
    jobId: req.jobId,
    type: req.jobType ?? "bash",
    parentSessionId: req.parentSessionId,
    description: req.description,
    status: "running",
    startedAt: Date.now(),
    notified: false,
    outputFile,
    abort: () => {
      // Remote-side kill first (node_exec: kill the host process group on the node) —
      // the local kill below only reaps the local kubectl-exec, not the remote process.
      try { req.onAbort?.(); } catch { /* best-effort */ }
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    },
  });

  child.stdout?.on("data", (c: string) => outSink.append(c));
  child.stderr?.on("data", (c: string) => errSink.append(c));

  child.on("close", (code) => {
    // A "stopped" status was set by job_stop before the SIGKILL that produced this exit.
    // Keep it "stopped" (not "killed") so the terminal status + notification match the
    // sub-agent stop path (job-registry maps a stopped sub-agent to "stopped" too).
    const wasStopped = jobs.get(req.jobId)?.status === "stopped";
    const status = wasStopped ? "stopped" : code === 0 ? "completed" : "failed";
    const summary =
      status === "completed"
        ? `Background command "${req.description}" completed${code != null ? ` (exit ${code})` : ""}`
        : status === "stopped"
          ? `Background command "${req.description}" was stopped`
          : `Background command "${req.description}" failed${code != null ? ` (exit ${code})` : ""}`;
    void settle(status, code, summary);
  });

  child.on("error", (err) => {
    void settle(
      "failed",
      null,
      `Background command "${req.description}" failed to start: ${err.message}`,
    );
  });

  return { jobId: req.jobId, outputFile };
}
