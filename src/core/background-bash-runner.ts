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
  sweepStaleTaskOutputs,
} from "../tools/cmd-exec/disk-output.js";

export type NotifyFn = (jobId: string, n: TaskNotification) => void;

// Throttle the opportunistic stale-output GC: it's a 24h-granularity sweep, so running it on
// EVERY launch (full readdir + stat per file) is pure waste. At most once per hour per process.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastSweepAt = 0;

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
  // Create the file NOW so reading `output_file` before any output exists yields an empty
  // file (= "running, no output yet"), not ENOENT.
  void disk.ensureCreated();
  // Opportunistic GC of stale leftovers (throttled to once/hour). sweepStaleTaskOutputs
  // self-protects every file with a live writer (process-wide, registry-independent), so a
  // silent long-running job — including one owned by another session/agent sharing this dir —
  // is never swept.
  const now = Date.now();
  if (now - lastSweepAt > SWEEP_INTERVAL_MS) {
    lastSweepAt = now;
    void sweepStaleTaskOutputs();
  }
  // SanitizingLineBuffer throws on a non-line-safe action (defense-in-depth) and spawn() below
  // can throw synchronously. Either way settle() — the one place disk.markFinal() runs — was
  // never wired, so release the live-writer guard here or the basename leaks in liveTaskOutputs
  // forever (its file would also never become GC-eligible).
  let outSink: SanitizingLineBuffer;
  let errSink: SanitizingLineBuffer;
  try {
    outSink = new SanitizingLineBuffer(disk, req.action, req.hasSensitiveKubectl);
    errSink = new SanitizingLineBuffer(disk, req.action, req.hasSensitiveKubectl);
  } catch (err) {
    disk.markFinal();
    throw err;
  }
  const flushAll = async () => {
    try {
      await Promise.all([outSink.flush(), errSink.flush()]);
    } catch {
      /* best-effort flush */
    }
  };

  // Settle (notify + onSettled) runs EXACTLY once — shared by all three modes. Node can
  // emit both 'error' and 'close' for a child; ssh can resolve done after an abort. Without
  // this latch onSettled would double-decrement the parent's background-work count.
  let settled = false;
  const settle = async (status: "completed" | "failed" | "killed" | "stopped", code: number | null, summary: string) => {
    if (settled) return;
    settled = true;
    await flushAll();
    disk.markFinal(); // writer done — release it from the stale-output sweep's live-writer guard
    jobs.setStatus(req.jobId, status, code != null ? { exitCode: code } : undefined);
    // Per-job cleanup (node_exec unpins its debug pod) — before notify so the pod is
    // released even if notify throws. Independent of onSettled (parent work-count).
    try { req.onComplete?.(); } catch { /* best-effort */ }
    notify(req.jobId, { taskId: req.jobId, outputFile, status, summary });
    onSettled?.();
  };

  // Map a terminal exit code to (status, summary), honouring a prior job_stop ("stopped").
  const terminalStatus = (code: number | null) => {
    const wasStopped = jobs.get(req.jobId)?.status === "stopped";
    const status = wasStopped ? "stopped" : code === 0 ? "completed" : "failed";
    const summary =
      status === "completed"
        ? `Background command "${req.description}" completed${code != null ? ` (exit ${code})` : ""}`
        : status === "stopped"
          ? `Background command "${req.description}" was stopped`
          : `Background command "${req.description}" failed${code != null ? ` (exit ${code})` : ""}`;
    return { status, summary } as const;
  };

  // ── Stream mode (host_exec / host_script via ssh2) ──────────────────
  // No child process: an in-process factory dials ssh and hands back live streams. The
  // job is registered immediately (so job_stop can abort the dial-in-flight), then the
  // streams are wired once the async factory resolves.
  if (req.streamFactory) {
    let abortStream = () => {};
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
        try { req.onAbort?.(); } catch { /* best-effort */ }
        try { abortStream(); } catch { /* best-effort */ }
      },
    });
    void (async () => {
      let handle;
      try {
        handle = await req.streamFactory!();
      } catch (err) {
        await settle("failed", null, `Background command "${req.description}" failed to start: ${(err as Error).message}`);
        return;
      }
      abortStream = handle.abort;
      // Dial-race: a job_stop that fired while the stream factory was still dialing ran the
      // registry abort() when abortStream was still a no-op, so the stop was lost. Now that
      // the streams are live, honour a prior stop immediately (close the channel + re-run the
      // remote kill — both idempotent) instead of letting the command run to completion.
      if (jobs.get(req.jobId)?.status === "stopped") {
        try { req.onAbort?.(); } catch { /* best-effort */ }
        try { abortStream(); } catch { /* best-effort */ }
      }
      handle.stdout.setEncoding("utf8");
      handle.stderr.setEncoding("utf8");
      handle.stdout.on("data", (c: string) => outSink.append(c));
      handle.stderr.on("data", (c: string) => errSink.append(c));
      try {
        const { exitCode } = await handle.done;
        const { status, summary } = terminalStatus(exitCode);
        await settle(status, exitCode, summary);
      } catch (err) {
        await settle("failed", null, `Background command "${req.description}" failed: ${(err as Error).message}`);
      }
    })();
    return { jobId: req.jobId, outputFile };
  }

  // spawn (not exec) so output streams to disk instead of buffering in memory — a long
  // background command can emit far more than exec's maxBuffer. detached:true makes the
  // child a process-group leader, so kill(-pid) reaps the whole tree (matches the
  // foreground group-kill). Two modes:
  //  - argv (node/pod): spawn the kubectl-exec binary + args WITHOUT a shell, so the
  //    nested `nsenter … <cmd>` is passed verbatim (no re-tokenizing/quoting).
  //  - shell (bash): run the already-wrapped string (incl. sudo -E -u sandbox in prod).
  let child: ReturnType<typeof spawn>;
  try {
    child =
      req.file != null
        ? spawn(req.file, req.args ?? [], { cwd: req.cwd, env: req.env, detached: true })
        : spawn(req.command!, { cwd: req.cwd, env: req.env, shell: "/bin/bash", detached: true });
  } catch (err) {
    disk.markFinal(); // spawn threw before the exit handlers wired settle() — release the guard
    throw err;
  }
  // Decode as UTF-8 via StringDecoder so a multibyte char split across two data chunks
  // is not corrupted into U+FFFD (raw Buffer.toString() per chunk would garble it).
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  // Script body (node/pod/local scripts) is piped via stdin — the calling tool builds the
  // argv (kubectl exec / interpreter) and hands the script here rather than as a temp file.
  if (req.stdin !== undefined) {
    // The child may close stdin early (interpreter errors out) → EPIPE on this writable,
    // emitted asynchronously, which a try/catch around .end() cannot catch. Without an
    // 'error' listener Node throws unhandled. Swallow it; close/error drives the settle.
    child.stdin?.on("error", () => { /* EPIPE / broken pipe — ignore */ });
    try { child.stdin?.end(req.stdin); } catch { /* child may have failed to start */ }
  }

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
    const { status, summary } = terminalStatus(code);
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
