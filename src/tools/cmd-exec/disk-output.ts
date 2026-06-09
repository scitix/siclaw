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
import { type FileHandle, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
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
 * Open a task-output file for appending. Centralizes the security-relevant flags
 * (O_NOFOLLOW anti-symlink, O_APPEND, O_CREAT — never O_TRUNC) so the writer (drain) and
 * the eager create path can't drift. Caller owns close().
 */
function openAppendHandle(filePath: string): Promise<FileHandle> {
  return open(
    filePath,
    process.platform === "win32"
      ? "a"
      : fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | O_NOFOLLOW,
  );
}

/**
 * Basenames of output files that currently have a LIVE writer (a DiskTaskOutput constructed
 * but not yet markFinal()'d). Process-wide on purpose: the opportunistic stale-output sweep
 * scans the SHARED task dir but is triggered by a single session's JobRegistry, so a
 * registry-local protect set can't see another session/agent's running jobs (local mode runs
 * one manager+registry per agent in one process). A silent long-running job has an old mtime
 * yet must never be swept — its writer would reopen an empty file on the next chunk and lose
 * output. Tracking liveness here, independent of any registry, closes that cross-registry gap.
 */
const liveTaskOutputs = new Set<string>();

/**
 * Async disk writer for one job's output. Flat-array write queue + single drain loop:
 * each chunk is released as soon as its write completes (no retained .then() closures).
 */
export class DiskTaskOutput {
  #path: string;
  #base: string;
  #fileHandle: FileHandle | null = null;
  #queue: string[] = [];
  #bytesWritten = 0;
  #capped = false;
  #flushPromise: Promise<void> | null = null;
  #flushResolve: (() => void) | null = null;

  constructor(jobId: string) {
    this.#path = getTaskOutputPath(jobId);
    this.#base = path.basename(this.#path);
    liveTaskOutputs.add(this.#base); // protected from the stale-output sweep until markFinal()
  }

  /**
   * Mark this writer permanently done (call once the job settles). Drops it from the
   * live-writer protection set so the stale-output GC may reclaim its file once it ages
   * past the cutoff. Idempotent; the file itself is left in place for the read window.
   */
  markFinal(): void {
    liveTaskOutputs.delete(this.#base);
  }

  /**
   * Eagerly create the (empty) output file at job launch. Without this the file is created
   * only on the first non-empty append(), so a background job that has not produced output
   * yet (e.g. an `ib_write_bw` server blocked waiting for a client) has NO file, and reading
   * the `output_file` handed back at launch returns ENOENT — read as "task failed/missing"
   * rather than "running, no output yet". Idempotent (O_APPEND|O_CREAT, never truncates);
   * best-effort (the first append() would create it anyway).
   */
  async ensureCreated(): Promise<void> {
    try {
      await mkdir(getTaskOutputDir(), { recursive: true });
      const fh = await openAppendHandle(this.#path);
      await fh.close();
    } catch {
      /* best-effort — drain's open() will create it on the first chunk */
    }
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
          this.#fileHandle = await openAppendHandle(this.#path);
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

/** Max bytes read back for a tail request / a whole-file request — bounds memory well below
 * the 5GB disk cap so a huge output can never OOM (or exceed V8's max string) on the read. */
const READ_TAIL_BYTE_CAP = 2 * 1024 * 1024; // 2MB
const READ_FULL_BYTE_CAP = 8 * 1024 * 1024; // 8MB

/**
 * Read a job's output file, tolerant of "not created yet" (returns empty + exists:false
 * rather than throwing ENOENT). Content is already sanitized on the write side. Reads only
 * the LAST `cap` bytes (never the whole multi-GB file), so a large output can't OOM; when
 * `tailLines` > 0 only the last N lines are returned. `bytes` is the full file size;
 * `truncated` is set when the byte cap and/or the line tail dropped content.
 */
export async function readTaskOutput(
  jobId: string,
  tailLines?: number,
): Promise<{ output: string; bytes: number; truncated: boolean; exists: boolean }> {
  let fh: FileHandle;
  try {
    // Read with O_NOFOLLOW (symmetric with the append side) so a symlink planted at the
    // output path can't redirect the read off-target. Plain "r" on win32 (no O_NOFOLLOW).
    fh = await open(
      getTaskOutputPath(jobId),
      process.platform === "win32" ? "r" : fsConstants.O_RDONLY | O_NOFOLLOW,
    );
  } catch {
    return { output: "", bytes: 0, truncated: false, exists: false }; // not created yet / cleaned
  }
  try {
    const size = (await fh.stat()).size;
    const wantTail = tailLines != null && tailLines > 0;
    const cap = wantTail ? READ_TAIL_BYTE_CAP : READ_FULL_BYTE_CAP;
    const readLen = Math.min(size, cap);
    const buf = Buffer.alloc(readLen);
    if (readLen > 0) await fh.read(buf, 0, readLen, size - readLen);
    let content = buf.toString("utf8");
    let truncated = size > readLen;
    // We read from an arbitrary byte offset — drop the (possibly partial / split-multibyte)
    // first line so we never surface a corrupted leading fragment. But if the whole window
    // has NO newline (a pathological newline-less blob, e.g. a base64 stream), keep the raw
    // bytes rather than collapse to "" — better a blob clipped at the front than empty output.
    if (truncated) {
      const nl = content.indexOf("\n");
      if (nl >= 0) content = content.slice(nl + 1);
    }
    if (!wantTail) return { output: content, bytes: size, truncated, exists: true };
    const lines = content.split("\n");
    // Output ends in "\n" → split yields a trailing "" — drop it so a tail of N returns N real lines.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length > tailLines) {
      return { output: lines.slice(-tailLines).join("\n"), bytes: size, truncated: true, exists: true };
    }
    return { output: lines.join("\n"), bytes: size, truncated, exists: true };
  } finally {
    await fh.close();
  }
}

/** Default age past which a finished job's output file is swept (24h). */
const STALE_TASK_OUTPUT_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort GC of stale task-output files. The app otherwise never deletes them, so in a
 * long-lived process (local / TUI mode) they accumulate forever. Called opportunistically at
 * each background launch — no scheduler needed, runtime-agnostic — and deletes `*.output`
 * files whose mtime is older than `maxAgeMs` (well past any read window). A K8s agentbox pod
 * is ephemeral and reclaims them on teardown anyway; this covers local/TUI and crash leftovers.
 *
 * Files with a live writer are ALWAYS skipped (via the process-wide liveTaskOutputs set), so a
 * silent long-running job — even one owned by another session/agent sharing this dir — is never
 * swept. `protect` is an optional extra set of basenames for explicit callers/tests.
 */
export async function sweepStaleTaskOutputs(
  maxAgeMs = STALE_TASK_OUTPUT_MS,
  protect?: Set<string>,
): Promise<void> {
  const dir = getTaskOutputDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // dir not created yet — nothing to sweep
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    entries.map(async (name) => {
      if (!name.endsWith(".output")) return;
      // Never delete a still-running job's file: it may be silent (old mtime) yet alive — its
      // writer would otherwise reopen an empty file on the next chunk and lose prior output.
      if (liveTaskOutputs.has(name) || protect?.has(name)) return;
      const full = path.join(dir, name);
      try {
        if ((await stat(full)).mtimeMs < cutoff) await unlink(full);
      } catch {
        /* raced with another sweep / already gone */
      }
    }),
  );
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
