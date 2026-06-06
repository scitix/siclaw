/**
 * Disk-streaming output for background bash jobs.
 *
 * Ported from Claude Code's `utils/task/diskOutput.ts` (DiskTaskOutput): an async
 * write queue drained by a single loop so each chunk is GC'd right after its write,
 * O_NOFOLLOW to defeat sandbox symlink attacks, and a hard disk cap.
 *
 * Differences from CC:
 *  - Output lives under <cwd>/<userDataDir>/agent/tasks/<jobId>.output. userDataDir is
 *    in BOTH readAllowedDirs and writeAllowedDirs (see agent-factory.ts), so the model
 *    reads progress with the built-in `read` tool — matching CC's "Use Read to read
 *    the output later" contract.
 *  - The file is created and written ONLY by the node main process; the command runs
 *    as the `sandbox` user and never touches the file (no cross-user fd handoff).
 *  - SanitizingLineBuffer enforces siclaw's sanitization contract on the WRITE side:
 *    the model must never read unsanitized background output. Sanitization is per
 *    complete line using the same `pre.action` resolved for the foreground path; only
 *    line-safe actions are allowed here (structural JSON sanitizers are rejected
 *    upstream in restricted-bash).
 */

import { constants as fsConstants } from "node:fs";
import { type FileHandle, mkdir, open, stat, unlink } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../../core/config.js";
import {
  applySanitizer,
  redactSensitiveContent,
  REDACTION_NOTICE,
  type OutputAction,
} from "../infra/output-sanitizer.js";

// O_NOFOLLOW: never follow a symlink when opening the output file. Without it, a
// process in the sandbox could plant a symlink at the tasks path pointing at an
// arbitrary host file, redirecting our writes. Not on Windows; sandbox is Unix-only.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** Hard disk cap per background job output file. Past this, further chunks are dropped. */
export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024; // 5GB
const MAX_TASK_OUTPUT_BYTES_DISPLAY = "5GB";

/** <cwd>/<userDataDir>/agent/tasks — created lazily. */
export function getTaskOutputDir(): string {
  const userDataDir = path.resolve(process.cwd(), loadConfig().paths.userDataDir);
  return path.join(userDataDir, "agent", "tasks");
}

// jobId comes from the LLM provider's tool-call id and is interpolated into a file path.
// Provider ids are NOT always plain tokens — e.g. some emit "functions.bash:0" (dots,
// colons). SANITIZE rather than reject: replace every char outside [A-Za-z0-9_-] with
// "_", which collapses "/" and ".." so no path traversal survives (O_NOFOLLOW only blocks
// a final-component symlink, not "../"). Rejecting would make restricted-bash silently
// fall back to foreground for such providers. Deterministic, so the returned path matches
// what we write and what the model later reads.
export function getTaskOutputPath(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!safe || /^_+$/.test(safe)) {
    // Degenerate id (empty / all-unsafe) — never happens for real tool-call ids.
    throw new Error(`Invalid job id for output path: ${JSON.stringify(jobId)}`);
  }
  return path.join(getTaskOutputDir(), `${safe}.output`);
}

/**
 * Async disk writer for one job's output. Flat-array write queue + single drain loop:
 * each chunk is released as soon as its write completes (no retained .then() closures).
 */
export class DiskTaskOutput {
  #path: string;
  #fileHandle: FileHandle | null = null;
  #queue: string[] = [];
  #bytesWritten = 0;
  #capped = false;
  #flushPromise: Promise<void> | null = null;
  #flushResolve: (() => void) | null = null;

  constructor(jobId: string) {
    this.#path = getTaskOutputPath(jobId);
  }

  append(content: string): void {
    if (this.#capped || content.length === 0) return;
    // content.length (UTF-16 units) undercounts UTF-8 bytes by ≤3× — fine for a coarse cap.
    this.#bytesWritten += content.length;
    if (this.#bytesWritten > MAX_TASK_OUTPUT_BYTES) {
      this.#capped = true;
      this.#queue.push(`\n[output truncated: exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY} disk cap]\n`);
    } else {
      this.#queue.push(content);
    }
    if (!this.#flushPromise) {
      this.#flushPromise = new Promise<void>((resolve) => {
        this.#flushResolve = resolve;
      });
      void this.#drain();
    }
  }

  /** Resolves when all queued writes have been flushed to disk. */
  flush(): Promise<void> {
    return this.#flushPromise ?? Promise.resolve();
  }

  private async drainAllChunks(): Promise<void> {
    while (true) {
      try {
        if (!this.#fileHandle) {
          await mkdir(getTaskOutputDir(), { recursive: true });
          this.#fileHandle = await open(
            this.#path,
            process.platform === "win32"
              ? "a"
              : fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | O_NOFOLLOW,
          );
        }
        while (this.#queue.length > 0) {
          const queue = this.#queue.splice(0, this.#queue.length);
          await this.#fileHandle.appendFile(queue.join(""));
        }
      } finally {
        if (this.#fileHandle) {
          const fh = this.#fileHandle;
          this.#fileHandle = null;
          await fh.close();
        }
      }
      if (this.#queue.length) continue; // an append() raced the close
      break;
    }
  }

  async #drain(): Promise<void> {
    try {
      await this.drainAllChunks();
    } catch {
      // Retry once for transient fs errors (EMFILE on busy CI); the queue is intact
      // if open() failed. Then give up silently — a dropped chunk must not crash the run.
      if (this.#queue.length > 0) {
        try {
          await this.drainAllChunks();
        } catch {
          /* swallow */
        }
      }
    } finally {
      const resolve = this.#flushResolve!;
      this.#flushPromise = null;
      this.#flushResolve = null;
      resolve();
    }
  }
}

/** Current byte size of a job's output file (0 if not yet created). */
export async function getTaskOutputSize(jobId: string): Promise<number> {
  try {
    return (await stat(getTaskOutputPath(jobId))).size;
  } catch {
    return 0;
  }
}

/** Best-effort delete of a job's output file. */
export async function cleanupTaskOutput(jobId: string): Promise<void> {
  try {
    await unlink(getTaskOutputPath(jobId));
  } catch {
    /* ENOENT or already gone */
  }
}

/**
 * Streams process output to disk, sanitizing per COMPLETE line so the model never
 * reads an unredacted secret. Mirrors postExecSecurity's order (applySanitizer →
 * redactSensitiveContent for sensitive kubectl) minus truncation (a read-time concern).
 *
 * A residual buffer holds the trailing partial line until its newline arrives; on
 * close, `flush()` drains it through the same sanitizer. The advisory REDACTION_NOTICE
 * footer is stripped from each batch (the inline **REDACTED** markers carry the
 * security property; a per-batch footer would be noise).
 *
 * Writes to a SHARED DiskTaskOutput so stdout and stderr each get their OWN line buffer
 * (own residual) but the same on-disk file — this prevents a partial (newline-less)
 * stdout line from being concatenated with the next stderr line into one garbled line.
 */
export class SanitizingLineBuffer {
  #disk: DiskTaskOutput;
  #action: OutputAction | null;
  #hasSensitiveKubectl: boolean;
  #residual = "";

  // Force-flush a newline-less residual past this size so a pathological stream with no
  // newlines (e.g. `base64 /dev/urandom`) can't grow the node main-process heap without
  // bound (the disk cap only counts what reaches DiskTaskOutput). Large enough that real
  // log lines never trip it; line-safe redactors still scan the flushed chunk.
  static readonly #MAX_RESIDUAL_BYTES = 1024 * 1024; // 1MB
  // When force-flushing a newline-less residual at the cap, retain this much trailing
  // context (carried RAW into the next residual, emitted exactly once later) so a secret
  // straddling the flush boundary is re-scanned with full context — otherwise the value
  // redactors (sk-…, AKIA…, JWTs, etc., which match anywhere in a line) could miss a token
  // split across the cut. Comfortably larger than any credential token.
  static readonly #RESIDUAL_OVERLAP_BYTES = 8192; // 8KB

  constructor(disk: DiskTaskOutput, action: OutputAction | null, hasSensitiveKubectl: boolean) {
    if (action && !action.lineSafe) {
      // Defense-in-depth: callers (restricted-bash) must reject non-line-safe actions
      // BEFORE backgrounding. If one slips through, fail closed rather than stream a
      // structural sanitizer per line (which could leak).
      throw new Error("SanitizingLineBuffer: non-line-safe OutputAction cannot be streamed");
    }
    this.#disk = disk;
    this.#action = action;
    this.#hasSensitiveKubectl = hasSensitiveKubectl;
  }

  #sanitize(text: string): string {
    let out = applySanitizer(text, this.#action);
    if (this.#hasSensitiveKubectl) out = redactSensitiveContent(out);
    // Strip the trailing advisory footer; inline **REDACTED** markers remain. The
    // redactors only ever append it once, at the end, so a single endsWith suffices.
    return out.endsWith(REDACTION_NOTICE) ? out.slice(0, -REDACTION_NOTICE.length) : out;
  }

  /** Feed a decoded stdout/stderr chunk. Complete lines are sanitized + written immediately. */
  append(chunk: string): void {
    this.#residual += chunk;
    const lastNl = this.#residual.lastIndexOf("\n");
    if (lastNl !== -1) {
      const complete = this.#residual.slice(0, lastNl + 1);
      this.#residual = this.#residual.slice(lastNl + 1);
      this.#disk.append(this.#sanitize(complete));
      return;
    }
    // No newline yet — but bound the residual so a newline-less stream can't OOM. Emit all
    // but a trailing overlap window; keep the overlap RAW so a secret straddling this cut is
    // re-scanned (and emitted exactly once) when the next chunk flushes it.
    if (this.#residual.length >= SanitizingLineBuffer.#MAX_RESIDUAL_BYTES) {
      const overlap = SanitizingLineBuffer.#RESIDUAL_OVERLAP_BYTES;
      const emit = this.#residual.slice(0, -overlap);
      this.#residual = this.#residual.slice(-overlap);
      this.#disk.append(this.#sanitize(emit));
    }
  }

  /** Flush the trailing partial line and await all disk writes. Call once on process exit. */
  async flush(): Promise<void> {
    if (this.#residual.length > 0) {
      this.#disk.append(this.#sanitize(this.#residual));
      this.#residual = "";
    }
    await this.#disk.flush();
  }
}
