/**
 * Running a command as `sandbox`, and stopping it again.
 *
 * Lifted out of `cmd-exec/restricted-bash.ts` unchanged. It lives here because it is not specific to
 * that tool: anything that needs to run a command under the UID boundary needs this exact wrapping,
 * and reaching into a tool module for it would point the dependency the wrong way (two `infra/` tests
 * already import from `../cmd-exec/restricted-bash.js`, which is the same mistake one layer up).
 */
import { spawn } from "node:child_process";
import { wrapBackgroundSession, backgroundSessionKillScript } from "./bg-session.js";

/**
 * SIGTERM-to-SIGKILL grace given to the sandbox-side `timeout`, and how much longer the outer
 * boundedExec timer waits.
 *
 * The two deadlines are deliberately ordered. `timeout` runs as the same user as the command and can
 * end it; the outer timer runs as `agentbox` and, without CAP_KILL, cannot — it only bounds the
 * CALL. So the inner one must always fire first, and the margin has to cover `timeout`'s own
 * TERM-then-KILL sequence plus the time for the pipes to close afterwards.
 */
export const SANDBOX_KILL_GRACE_S = 5;
export const OUTER_BACKSTOP_MARGIN_S = 10;

/**
 * The production command line: drop to `sandbox`, and put the deadline on that side of the UID
 * boundary.
 *
 * The order matters and is the whole point. `sudo` execs `timeout`, which then runs the command — so
 * `timeout` is itself a `sandbox` process and shares the UID of what it must kill. Wrapping the
 * other way round (`timeout sudo …`) would put it back outside the boundary, where signalling fails
 * exactly as it does from the agent.
 */
export function buildSandboxCommand(
  command: string,
  opts: { timeoutS?: number; graceS?: number; pgidFile?: string },
): string {
  const grace = opts.graceS ?? SANDBOX_KILL_GRACE_S;
  const quoted = `bash -c '${command.replace(/'/g, "'\\''")}'`;
  // No deadline for a background job. It exists to outlive the turn, and it had no cap before —
  // wrapping it in the foreground default would have started killing long jobs at 60 seconds. Its
  // stop condition is job_stop, which is what the session below is for.
  const inner = opts.timeoutS === undefined
    ? quoted
    : `timeout -k ${grace} ${opts.timeoutS} ${quoted}`;
  // Natural expiry is only ONE of three ways a run stops. An abort and an output overflow are
  // decided out here, and out here cannot signal a `sandbox` process — so those two need a handle on
  // the sandbox side. A SESSION is that handle: `timeout` puts its child in its own process GROUP,
  // so a group is not enough, while a session id is inherited across that sub-group and reaps the
  // lot (bg-session.ts documents this from the node_exec path, where it was found the same way).
  const withSession = opts.pgidFile
    ? wrapBackgroundSession(inner, opts.pgidFile)
    : inner;
  const escaped = withSession.replace(/'/g, "'\\''");
  return `sudo -E -u sandbox -- bash -c '${escaped}'`;
}

/**
 * Reap everything the sandbox-side session still holds, AS sandbox.
 *
 * sudoers grants `agentbox ALL=(sandbox) NOPASSWD: ALL`, so becoming sandbox is the whole trick:
 * the same signal that returns EPERM from the agent lands from here. Measured in the image —
 * `kill -- -<pgid>` as sandbox still failed, because `timeout` had re-grouped its child; the session
 * is what covers it.
 *
 * Best-effort by construction: it races the command finishing on its own, and the sandbox-side
 * `timeout` remains the backstop if this misses.
 */
export function reapSandboxSession(pgidFile: string): void {
  try {
    const script = backgroundSessionKillScript(pgidFile);
    // Detached and unref'd: this runs while the caller is settling, and must not hold the loop.
    const child = spawn("sudo", ["-n", "-E", "-u", "sandbox", "--", "bash", "-c", script], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => { /* best-effort */ });
    child.unref();
  } catch { /* best-effort */ }
}
