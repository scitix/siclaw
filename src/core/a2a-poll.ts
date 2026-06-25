/**
 * A2A client — submit + poll an EXTERNAL A2A agent task, packaged as a
 * BackgroundStreamHandle so it plugs into `spawnBackgroundBash`'s streamFactory
 * mode (the same path host_exec uses for ssh channels). The background runner
 * then gives us, for free: job registration, claimNotification dedup,
 * notifyParent → synthetic turn wake, job_stop, disk output + sanitization.
 *
 * Contract (see docs/design/2026-06-24-a2a-client.md):
 *   - `done` ALWAYS resolves, never rejects. On abort the registry has already
 *     marked the job "stopped"; resolving lets terminalStatus() restore it.
 *   - COMPLETED → exitCode 0; FAILED/REJECTED/CANCELED/timeout → exitCode != 0.
 *   - The remote's final text is pushed as the LAST stdout line(s) so it lands
 *     in the disk output file (sanitized) and is read back via task_output —
 *     it is NOT returned inline.
 *   - Progress lines NEVER contain the base URL, headers, or the API key.
 *   - This module owns remote cancellation (POST :cancel) because only it knows
 *     the taskId once the submit completes.
 *
 * Transport-only: uses fetch + the shared wire types in portal/a2a-protocol.ts.
 * No A2A SDK.
 */

import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import {
  A2A_JSON,
  isTerminalState,
  type A2aTaskState,
} from "../portal/a2a-protocol.js";
import type { BackgroundStreamHandle } from "./tool-registry.js";

export interface A2aPollOptions {
  /** Remote A2A interface base — already includes the agent prefix (.../a2a/agents/<id>). */
  baseUrl: string;
  /** Bearer credential for the remote agent. Never written to stdout/logs. */
  apiKey?: string;
  /** Natural-language task for the remote agent. */
  message: string;
  /** Continue a prior remote conversation (A2A contextId). */
  contextId?: string;
  /** Human label for progress lines (the registered server name); never the URL. */
  label?: string;
  pollIntervalMs?: number;
  deadlineMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_DEADLINE_MS = 600_000; // mirror node_exec's 600s ceiling
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
// A single submit/poll/cancel must not hang forever: without this, a half-dead
// remote (accepts the TCP connection but never responds / never FINs) makes the
// `await fetch` block indefinitely, so the loop-top deadline check never runs and
// the whole background job hangs past its 600s ceiling.
const PER_REQUEST_TIMEOUT_MS = 30_000;

interface A2aTaskShape {
  id?: string;
  contextId?: string;
  status?: { state?: string; message?: { parts?: Array<{ text?: string }> } };
  artifacts?: Array<{ parts?: Array<{ text?: string }> }>;
}

/** Join all text parts of a parts[] array. */
function joinParts(parts: Array<{ text?: string }> | undefined): string {
  return Array.isArray(parts) ? parts.map((p) => p?.text ?? "").filter(Boolean).join("") : "";
}

/** Pull the model-facing text out of a task: prefer the artifact, fall back to the status message (FAILED has no artifact). */
function extractTaskText(task: A2aTaskShape | undefined): string {
  const artifactText = joinParts(task?.artifacts?.[0]?.parts);
  if (artifactText) return artifactText;
  return joinParts(task?.status?.message?.parts);
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Build a BackgroundStreamHandle that submits a task to a remote A2A agent and
 * polls it to terminal state. Returns synchronously; all I/O runs inside `done`.
 */
export function createA2aPollStream(opts: A2aPollOptions): BackgroundStreamHandle {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const label = opts.label ?? "external A2A agent";
  const base = trimSlash(opts.baseUrl);

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const ac = new AbortController();
  let aborted = false;

  const abort = (): void => {
    aborted = true;
    try { ac.abort(); } catch { /* best-effort */ }
  };

  const authHeaders = (): Record<string, string> =>
    opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};

  // Per-request signal: aborts on job_stop (ac) OR a per-request timeout, so one
  // hung request can't outlive PER_REQUEST_TIMEOUT_MS and defeat the deadline.
  const reqSignal = (): AbortSignal =>
    AbortSignal.any([ac.signal, AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS)]);

  /** Write a progress line. Caller is responsible for never passing URL/headers/credentials. */
  const line = (text: string): void => {
    if (stdout.writable) stdout.write(text + "\n");
  };

  /** Abortable delay; returns early (does not reject) when aborted. */
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (aborted) return resolve();
      const t = setTimeout(() => {
        ac.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => { clearTimeout(t); resolve(); };
      ac.signal.addEventListener("abort", onAbort, { once: true });
    });

  /** Best-effort remote cancel with a fresh (short) signal — ac.signal is already aborted by now. */
  const cancelRemote = async (taskId: string): Promise<void> => {
    try {
      await fetchImpl(`${base}/tasks/${encodeURIComponent(taskId)}:cancel`, {
        method: "POST",
        headers: authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* best-effort */ }
  };

  const done = (async (): Promise<{ exitCode: number | null }> => {
    let taskId = "";
    try {
      // ── Submit ──────────────────────────────────────────────────────
      let submitRes: Response;
      try {
        submitRes = await fetchImpl(`${base}/message:send`, {
          method: "POST",
          headers: { "Content-Type": A2A_JSON, ...authHeaders() },
          body: JSON.stringify({
            message: {
              role: "ROLE_USER",
              parts: [{ text: opts.message }],
              ...(opts.contextId ? { contextId: opts.contextId } : {}),
            },
          }),
          signal: reqSignal(),
        });
      } catch (err) {
        if (aborted) { line(`Canceled before ${label} accepted the task.`); return { exitCode: null }; }
        line(`Failed to reach ${label}: ${(err as Error).message}`);
        return { exitCode: 1 };
      }
      if (!submitRes.ok) {
        line(`${label} rejected the task (HTTP ${submitRes.status}).`);
        return { exitCode: 1 };
      }
      let task: A2aTaskShape | undefined;
      try {
        task = ((await submitRes.json()) as { task?: A2aTaskShape }).task;
      } catch { task = undefined; }
      taskId = task?.id ?? "";
      if (!taskId) {
        line(`${label} returned no task id; cannot track the task.`);
        return { exitCode: 1 };
      }
      line(`Task ${taskId} submitted to ${label}.`);

      // The submit response may already carry a terminal state (some agents
      // complete synchronously) — honour it before entering the poll loop.
      let state = task?.status?.state as A2aTaskState | undefined;
      if (state && isTerminalState(state)) {
        return finish(state, task);
      }

      // ── Poll ────────────────────────────────────────────────────────
      const start = now();
      let consecutiveFailures = 0;
      while (!aborted) {
        if (now() - start > deadlineMs) {
          line(`Timed out after ${Math.round(deadlineMs / 1000)}s waiting on ${label}.`);
          await cancelRemote(taskId);
          return { exitCode: 1 };
        }
        await delay(pollIntervalMs);
        if (aborted) break;

        let pollRes: Response;
        try {
          pollRes = await fetchImpl(`${base}/tasks/${encodeURIComponent(taskId)}`, {
            method: "GET",
            headers: authHeaders(),
            signal: reqSignal(),
          });
        } catch (err) {
          if (aborted) break;
          if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            line(`Lost contact with ${label} after ${consecutiveFailures} attempts: ${(err as Error).message}`);
            return { exitCode: 1 };
          }
          continue;
        }
        // 4xx is a client error that will not recover (task gone, auth changed) — fail fast.
        if (pollRes.status >= 400 && pollRes.status < 500) {
          line(`${label} returned HTTP ${pollRes.status} for task ${taskId}; stopping.`);
          return { exitCode: 1 };
        }
        if (!pollRes.ok) {
          if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            line(`${label} kept returning HTTP ${pollRes.status}; stopping.`);
            return { exitCode: 1 };
          }
          continue;
        }
        try {
          task = ((await pollRes.json()) as { task?: A2aTaskShape }).task;
        } catch {
          // A 200 with an unparseable body is a failure signal, not "keep going" —
          // count it so a broken remote can't spin silently until the deadline.
          if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            line(`${label} returned unparseable responses; stopping.`);
            return { exitCode: 1 };
          }
          continue;
        }
        consecutiveFailures = 0;
        state = task?.status?.state as A2aTaskState | undefined;
        if (state && isTerminalState(state)) {
          return finish(state, task);
        }
      }

      // Aborted (job_stop). The registry already set status "stopped"; resolving
      // with null lets terminalStatus() render it as stopped.
      line(`Stopped; requesting ${label} to cancel task ${taskId}.`);
      await cancelRemote(taskId);
      return { exitCode: null };
    } finally {
      stdout.end();
      stderr.end();
      // Resolve `done` only AFTER the consumer (background-bash-runner's `data`
      // listener) has drained stdout — otherwise the runner's settle→flush→notify
      // can fire before the final artifact line reaches the disk sink. Relies on
      // the streamFactory contract that the runner consumes stdout (it always
      // attaches a `data` handler); `finished` resolves immediately if already ended.
      await finished(stdout).catch(() => { /* no consumer / already closed */ });
    }

    function finish(terminal: A2aTaskState, task: A2aTaskShape | undefined): { exitCode: number | null } {
      const text = extractTaskText(task);
      if (text) line(text);
      if (terminal === "TASK_STATE_COMPLETED") {
        if (!text) line(`${label} completed but returned no text output.`);
        return { exitCode: 0 };
      }
      line(`Remote task ended: ${terminal}.`);
      return { exitCode: 1 };
    }
  })();

  return { stdout, stderr, done, abort };
}
