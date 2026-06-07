import { randomBytes } from "node:crypto";
import { shellEscape } from "./command-sets.js";

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
 */
export function wrapBackgroundSession(innerCmd: string, pgidFile: string): string {
  const launch = `echo $$ > ${pgidFile}; ${innerCmd}; rc=$?; rm -f ${pgidFile}; exit $rc`;
  return `setsid -w sh -c ${shellEscape(launch)}`;
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
