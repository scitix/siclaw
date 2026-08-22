/**
 * Run a shell command with a timeout that actually bounds the call.
 *
 * The defect this replaces had three layers, and only the first was visible in the code:
 *
 * 1. `child_process.exec`'s own `timeout` sends SIGTERM to the DIRECT child. In production that
 *    child is `sudo`, not the kubectl underneath it, and a command can ignore SIGTERM outright.
 *
 * 2. The result settled on `close`, which fires when the stdio streams close — not when the process
 *    exits. Any surviving descendant that inherited stdout holds the pipe open, so `close` never
 *    fires and the call outlives its timeout indefinitely.
 *
 * 3. The escape hatch for (1) and (2) was `process.kill(-child.pid)` — kill the whole process group,
 *    which `detached: true` was supposed to make the child the leader of. **`exec` silently drops
 *    `detached`.** It is a `spawn` option, and `exec` → `execFile` → `spawn` forwards only a fixed
 *    set (cwd, env, uid, gid, shell, signal, windowsHide). Measured: the child's PGID equalled the
 *    NODE process's group, identically with `detached` true and false, so `-child.pid` was ESRCH on
 *    every call and always fell back to killing the direct child alone. The group kill had never
 *    worked, on any platform — and the real pgid could not be used instead, since signalling it
 *    would have killed the agent's own process group.
 *
 * Production cost of the three together: three conversations held for 12280s, 12106s and 6465s by
 * one kubectl each — 8.6 hours in a month, 12% of all wall time, from three commands.
 *
 * So: `spawn` (which honours `detached`, verified by the child's pgid equalling its own pid), our own
 * timer, SIGKILL to the group, and a bounded grace after that in case the kill still does not land.
 * The same path serves an abort, which had the same weakness.
 */

import { spawn } from "node:child_process";

/**
 * How long to wait for `close` after the kill before settling anyway.
 *
 * With a real process group the SIGKILL closes the pipes at once, so this window is normally unused.
 * It is the guarantee rather than the mechanism: `sudo` can place a command in a session of its own,
 * where `-pid` reaches nothing, and the alternative to bounding the wait is hanging for the rest of
 * the turn — the defect being fixed. A fix that only works when its assumption holds is what
 * produced this bug in the first place.
 */
export const TIMEOUT_KILL_GRACE_MS = 2000;

export const DEFAULT_MAX_BUFFER = 1024 * 1024 * 10;

export type BoundedExecResult = { stdout: string; stderr: string };

/**
 * Thrown when OUR cap stopped the command — as opposed to the command reporting a failure.
 *
 * `code: null` + `signal: "SIGKILL"` is not decoration: that pair is what classifyExit reads to
 * reach `interrupted`, and it is the shape a signalled `exec` child used to arrive in. Presenting it
 * means the timeout gets the reviewed annotation there rather than a second, parallel wording here.
 */
export class BoundedExecTimeout extends Error {
  readonly timedOut = true;
  readonly code = null;
  readonly signal = "SIGKILL" as const;
  constructor(
    readonly stdout: string,
    readonly stderr: string,
    readonly timeoutMs: number,
  ) {
    super("timeout");
    this.name = "BoundedExecTimeout";
  }
}

/** Thrown on a non-zero exit (or a signal), carrying whatever the command had already written. */
export class BoundedExecFailure extends Error {
  constructor(
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly signal?: NodeJS.Signals | null,
  ) {
    super(`exit ${code}`);
    this.name = "BoundedExecFailure";
  }
}

/**
 * Thrown when the CALLER cancelled — a user Stop, or a turn that was abandoned.
 *
 * Separate from the timeout despite arriving in the same code=null/SIGKILL shape, because a caller
 * reading only that pair describes it as "killed at the tool's timeout, raise timeout_seconds" —
 * advice that has nothing to do with what happened, over a limit that was never reached.
 */
export class BoundedExecAborted extends BoundedExecFailure {
  readonly aborted = true;
  constructor(stdout: string, stderr: string) {
    super(null, stdout, stderr, "SIGKILL");
    this.name = "BoundedExecAborted";
  }
}

/**
 * Thrown when output passed the cap — the role exec's maxBuffer played, which spawn does not have.
 *
 * It reports Node's own `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` as its `code` because that string is what
 * classifyExit matches to reach `output_truncated`. Moving off `exec` stopped Node producing it, and
 * a caller that no longer recognises this case reads a cut-off prefix as a complete result — a search
 * over it finding nothing then "proves" something. Keeping the code keeps that classification.
 */
export class BoundedExecOverflow extends Error {
  readonly overflow = true;
  readonly code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" as const;
  constructor(
    readonly stdout: string,
    readonly stderr: string,
    readonly maxBuffer: number,
  ) {
    super(`output exceeded ${maxBuffer} bytes (maxBuffer length exceeded)`);
    this.name = "BoundedExecOverflow";
  }
}

export type BoundedExecOptions = {
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBuffer?: number;
  /** Overridable so tests do not have to wait out the real grace. */
  graceMs?: number;
  cwd?: string;
  /**
   * Stop whatever this process cannot reach itself, called once on the first stop condition.
   *
   * The group kill below only reaches processes this UID may signal. Where the command runs as
   * someone else — production drops to `sandbox` — it reaches the outer shell and nothing under it,
   * and still reports success for having signalled one member. Without this hook a timeout was
   * handled (the command carries its own deadline) while an abort and an overflow returned over a
   * command that kept running. Best-effort and asynchronous: the deadline is still enforced.
   */
  reap?: () => void;
};

export function boundedExec(command: string, opts: BoundedExecOptions): Promise<BoundedExecResult> {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  // Checked before spawning, not after: an already-aborted turn should not run a kubectl at all,
  // and the abort handler below would otherwise start one only to kill it.
  if (opts.signal?.aborted) {
    return Promise.reject(new BoundedExecAborted("", ""));
  }
  const child = spawn("/bin/bash", ["-c", command], {
    detached: true, // honoured by spawn — this is why the group kill below can work at all
    env: opts.env,
    // stdin is /dev/null rather than an open pipe nobody writes to: a command that reads stdin gets
    // EOF instead of blocking until the cap.
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  const killGroup = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // The group is gone, or was never ours to signal. Killing the direct child is all that is
      // left; the grace below is what keeps that from becoming a hang.
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }
  };

  let timer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;

  return new Promise<BoundedExecResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    // Per stream, not combined. `exec`'s maxBuffer was "the most allowed on stdout OR stderr" and
    // Node tracked the two separately, so a command writing 6 MB to each passed a 10 MB cap. One
    // shared counter would fail it, and would fail a legitimate 10 MB total that no single stream
    // exceeded.
    let outBytes = 0;
    let errBytes = 0;
    /**
     * The FIRST stop condition, latched.
     *
     * Whichever of timeout / abort / overflow arrives first owns both the deadline and the reported
     * error. Re-arming on a later one extended the wait it had just set and swapped the error under
     * it: a timeout at 100ms would arm a 400ms grace, a descendant that escaped the process group
     * would keep writing, the overflow would then re-arm to ~700ms, and the call reported Overflow
     * — or Timeout if the pipes happened to close first, i.e. the outcome was a race. The latch is
     * also what `close` reads, so the two paths can no longer disagree about which one it was.
     */
    let stopping: (() => Error) | null = null;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // Decode on the stream so a multibyte character split across two data events survives;
    // per-chunk decoding yields two U+FFFD instead.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    /** Kill, then settle whatever happens — the shape all three stop conditions share. */
    const killAndBound = (makeError: () => Error) => {
      if (stopping) return; // first reason wins: neither the deadline nor the error moves
      stopping = makeError;
      killGroup();
      // After the group kill, not instead of it: the two cover different halves of the tree, and
      // this one is the only half that can reach a command running as another user.
      try { opts.reap?.(); } catch { /* best-effort */ }
      graceTimer = setTimeout(() => settle(() => {
        // Reaching here means the kill did not land and the process is still alive. Detaching the
        // pipes keeps it from feeding a buffer nobody reads, and unref releases the handle it holds
        // on the event loop — this is a long-lived process, so one leaked handle per hung command
        // would accumulate for the life of the pod.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(makeError());
      }), opts.graceMs ?? TIMEOUT_KILL_GRACE_MS);
    };

    // Byte length, not string length: `.length` counts UTF-16 units, which lets CJK output run
    // well past the cap.
    const collect = (append: (chunk: string) => void, addTo: (n: number) => number) =>
      (chunk: string) => {
        // Nothing is appended once a stop condition has fired. The prefix already captured is what
        // gets reported, and a producer that outlives the kill — `yes` writes ~100 MB/s — would
        // otherwise keep growing the string for the whole grace window on a call already failing.
        if (stopping) return;
        append(chunk);
        if (addTo(Buffer.byteLength(chunk, "utf8")) > maxBuffer) {
          killAndBound(() => new BoundedExecOverflow(stdout, stderr, maxBuffer));
        }
      };
    child.stdout.on("data", collect((c) => { stdout += c; }, (n) => (outBytes += n)));
    child.stderr.on("data", collect((c) => { stderr += c; }, (n) => (errBytes += n)));

    child.on("close", (code, sig) => settle(() => {
      if (stopping) reject(stopping());
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new BoundedExecFailure(code, stdout, stderr, sig));
    }));
    child.on("error", (e) => settle(() => reject(e)));

    // An abort gets the same treatment as a timeout, grace included: it had the identical
    // never-settles weakness, since it relied on the same group kill.
    onAbort = () => killAndBound(() => new BoundedExecAborted(stdout, stderr));
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      killAndBound(() => new BoundedExecTimeout(stdout, stderr, opts.timeoutMs));
    }, opts.timeoutMs);
  }).finally(() => {
    clearTimeout(timer);
    clearTimeout(graceTimer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  });
}
