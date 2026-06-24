import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { shellEscape } from "./command-sets.js";
import { sshExec, type SshTarget } from "./ssh-client.js";

/**
 * Shared shell-string builders for background jobs that run a command on a REMOTE shell
 * (host_exec / host_script over SSH, pod_script via kubectl-exec). The transport differs per
 * tool, but the "run as a killable session + reap it on job_stop" shell logic is identical and
 * quoting-sensitive, so it lives here once (and is covered by an e2e remote-reap smoke).
 *
 * Why a SESSION (setsid), not just a process group: GNU `timeout` puts its child in its OWN
 * process group, so a single `kill -<pgid>` of the launcher's group misses timeout's subtree.
 * setsid starts a new session whose id every descendant inherits (across timeout's sub-group),
 * so `pkill -s <sid>` reaps them all.
 *
 * Why NOT `setsid -w`: the `-w`/`--wait` flag only exists in util-linux >= 2.24 (2013). CentOS 7 /
 * RHEL 7 ship util-linux 2.23.2, and busybox `setsid` has no `-w` either, so `setsid -w` aborts
 * with "setsid: invalid option -- 'w'" and the command never runs. We get the same "wait + real
 * exit status" behavior portably by running setsid as a NON process-group-leader child (see
 * {@link wrapBackgroundSession}): when its caller isn't a process-group leader, setsid exec's the
 * program in place (no fork), so the launching shell's `wait` observes the real exit status on any
 * setsid version. The session is still created, so `pkill -s <sid>` reaping is unchanged.
 */

/** A unique pidfile path holding the setsid session id (`$$` of the leader) for one job. */
export function backgroundPgidFile(toolCallId: string): string {
  const safe = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `/tmp/siclaw-bg-${safe}-${randomBytes(4).toString("hex")}.pgid`;
}

/**
 * Wrap `innerCmd` so it runs as its own session leader (setsid), records the session id to
 * `pgidFile`, and removes the pidfile on normal exit. Returns ONE remote-shell command string.
 * `echo $$` consumes no stdin, so a piped script body flows through to `innerCmd` unchanged.
 *
 * The wrapper is `setsid sh -c '<launch>'; exit $?` (NOT `setsid -w`): the trailing `exit $?` is a
 * second command, so the launching shell can't exec-optimize the single `setsid` invocation and
 * must run it as a forked CHILD. That child is never a process-group leader, so setsid exec's
 * `sh -c '<launch>'` in place (no fork) on EVERY setsid version — incl. CentOS 7 / RHEL 7's
 * util-linux 2.23.2 and busybox, neither of which support `setsid -w`. Because there's no fork,
 * the launching shell `wait`s for the real command and `exit $?` propagates its true exit status.
 * It runs synchronously (no `&`), so a script body piped on stdin still reaches `innerCmd` (an `&`
 * async list would have its stdin redirected to /dev/null when job control is off).
 *
 * The inner `sh -c` records its own pid via `echo $$`; setsid has already made that pid the new
 * session id, so `pkill -s <sid>` still reaps the whole tree (incl. timeout's own process group).
 */
export function wrapBackgroundSession(innerCmd: string, pgidFile: string): string {
  const launch = `echo $$ > ${pgidFile}; ${innerCmd}; rc=$?; rm -f ${pgidFile}; exit $rc`;
  return `setsid sh -c ${shellEscape(launch)}; exit $?`;
}

/**
 * Shell that reaps a job started with {@link wrapBackgroundSession}: read the recorded session
 * id (retry briefly in case the file isn't written yet) and kill the whole session — `pkill -s`
 * first (catches timeout's sub-group), process-group `kill -<sid>` as a fallback when pkill is
 * absent. Idempotent; meant to run over a fresh connection on job_stop.
 */
export function backgroundSessionKillScript(pgidFile: string): string {
  return `sid=""; for i in 1 2 3; do sid=$(cat ${pgidFile} 2>/dev/null); [ -n "$sid" ] && break; sleep 1; done; if [ -n "$sid" ]; then pkill -TERM -s "$sid" 2>/dev/null || kill -TERM -"$sid" 2>/dev/null; sleep 1; pkill -KILL -s "$sid" 2>/dev/null || kill -KILL -"$sid" 2>/dev/null; fi; rm -f ${pgidFile}`;
}

/**
 * Fire {@link backgroundSessionKillScript} on a node's debug pod over a FRESH `kubectl exec`
 * connection — used to reap a remote session started with {@link wrapBackgroundSession} when the
 * caller can no longer use the streaming channel (it is being torn down on abort). Detached and
 * self-killed after `timeoutMs` so a hung reap can never keep the process alive or leak a client.
 *
 * `nsenterPrefix` is the host-namespace prefix the command was launched under (e.g.
 * `["nsenter","-t","1",...,"--"]` for node_exec) so the kill lands in the SAME PID namespace as
 * the target; pass `[]` to run the kill directly inside the pod. Best-effort: errors are swallowed
 * (the local-client kill and the remote `timeout` backstop are complementary safety nets).
 */
export function killRemoteSessionViaKubectl(opts: {
  kubeconfigArgs: string[];
  childEnv: Record<string, string>;
  namespace: string;
  podName: string;
  nsenterPrefix: string[];
  pgidFile: string;
  timeoutMs?: number;
}): void {
  const { kubeconfigArgs, childEnv, namespace, podName, nsenterPrefix, pgidFile } = opts;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    const killer = spawn(
      "kubectl",
      [...kubeconfigArgs, "-n", namespace, "exec", podName, "--", ...nsenterPrefix, "sh", "-c", backgroundSessionKillScript(pgidFile)],
      { env: childEnv, detached: true },
    );
    killer.on("error", () => {});
    setTimeout(() => { try { killer.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs).unref();
    killer.unref();
  } catch { /* best-effort */ }
}

/**
 * Fire {@link backgroundSessionKillScript} on a host over a FRESH ssh connection — the foreground
 * (and background) counterpart of {@link killRemoteSessionViaKubectl} for the SSH transport. The
 * streaming channel is being torn down on abort and closing it does NOT reliably SIGHUP a non-PTY
 * remote process, so the reap runs over a new, time-boxed connection. Best-effort; errors swallowed.
 */
export function killRemoteSessionViaSsh(opts: {
  target: SshTarget;
  pgidFile: string;
  timeoutMs?: number;
}): void {
  const { target, pgidFile } = opts;
  void sshExec(target, backgroundSessionKillScript(pgidFile), { timeoutMs: opts.timeoutMs ?? 20_000 }).catch(() => {});
}
