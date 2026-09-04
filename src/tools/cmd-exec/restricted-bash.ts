import type { ToolEntry, BackgroundExecWiring } from "../../core/tool-registry.js";
import { BACKGROUND_BASH_ENABLED } from "../../core/subagent-registry.js";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { KubeconfigRef } from "../../core/types.js";
import { renderTextResult } from "../infra/tool-render.js";
import { loadConfig } from "../../core/config.js";
import {
  CONTAINER_SENSITIVE_PATHS,
  getCommandBinary,
  parseArgs,
  validateCommandRestrictions,
} from "../infra/command-sets.js";
import { resolveRequiredKubeconfig } from "../infra/kubeconfig-resolver.js";
import { ensureClusterForTool, classifyClusterFailure } from "../infra/ensure-kubeconfigs.js";
import { sanitizeEnv } from "../infra/sanitize-env.js";
import {
  extractCommands as _extractCommands,
  validateShellOperators as _validateShellOperators,
} from "../infra/command-validator.js";
import { preExecSecurity, postExecSecurity } from "../infra/security-pipeline.js";
import { classifyExit } from "../infra/exit-classification.js";
import { tailTruncationNote } from "../infra/tail-truncation.js";
import { hasPipeline, instrumentPipeline, extractPipelineStatus } from "../infra/pipeline-status.js";
import { backgroundNotLineSafeError, backgroundLaunchedResult } from "./background-launch.js";
import { boundedExec } from "../infra/bounded-exec.js";
import { backgroundPgidFile } from "../infra/bg-session.js";
import {
  SANDBOX_KILL_GRACE_S,
  OUTER_BACKSTOP_MARGIN_S,
  buildSandboxCommand,
  reapSandboxSession,
} from "../infra/sandbox-exec.js";
import { validateKubectlInPipeline } from "../infra/kubectl-readonly-policy.js";

// ── Re-exports for backward compatibility ────────────────────────────
//
// The sandbox wrapping and the read-only kubectl policy moved to `infra/` so a second caller can
// reach them without importing a TOOL module — two `infra/` tests were already doing exactly that.
// Re-exported rather than updated at every call site because the move is meant to be invisible:
// nothing about this file's behaviour changed.

export {
  SANDBOX_KILL_GRACE_S,
  OUTER_BACKSTOP_MARGIN_S,
  buildSandboxCommand,
  reapSandboxSession,
  validateKubectlInPipeline,
};
export { extractCommands, validateShellOperators } from "../infra/command-validator.js";
export { getCommandBinary } from "../infra/command-sets.js";

// ── Compatibility wrappers ───────────────────────────────────────────

export function validateFindInPipeline(commands: string[]): string | null {
  for (const cmd of commands) {
    const binary = getCommandBinary(cmd);
    if (binary !== "find") continue;
    const err = validateCommandRestrictions(cmd);
    if (err) return err;
  }
  return null;
}

/** @deprecated awk/gawk have been removed from the allowed commands list. */
export function validateAwkInPipeline(_commands: string[]): string | null {
  return null;
}

/** @deprecated sed has been removed from the allowed commands list. */
export function validateSedInPipeline(_commands: string[]): string | null {
  return null;
}

export function validateIpInPipeline(commands: string[]): string | null {
  for (const cmd of commands) {
    const binary = getCommandBinary(cmd);
    if (binary !== "ip") continue;
    const err = validateCommandRestrictions(cmd);
    if (err) return err;
  }
  return null;
}

// ── Skill script detection ───────────────────────────────────────────

/**
 * Check if a shell command invokes a script under <cwd>/skills/.
 * Handles both forms:
 *   - "bash skills/core/xxx/run.sh --flag"   (bash/sh prefix)
 *   - "skills/core/xxx/run.sh --flag"         (direct invocation)
 * Resolves symlinks and blocks path traversal.
 */
export function isSkillScript(cmd: string): boolean {
  const parts = cmd.trim().split(/\s+/);
  const binary = (parts[0] ?? "").split("/").pop()?.toLowerCase() ?? "";

  let scriptArg: string | undefined;
  if (binary === "bash" || binary === "sh" || binary === "python3" || binary === "python") {
    // Find the first positional argument (skip flags like -e, -x)
    for (let i = 1; i < parts.length; i++) {
      if (parts[i] === "-c") return false; // inline command — block
      if (parts[i].startsWith("-")) continue;
      scriptArg = parts[i];
      break;
    }
  } else {
    // Direct invocation: strip env var assignments, take first token
    let stripped = cmd.trim();
    while (/^\s*\w+=\S*\s+/.test(stripped)) {
      stripped = stripped.replace(/^\s*\w+=\S*\s+/, "");
    }
    scriptArg = stripped.trim().split(/\s+/)[0];
  }

  if (!scriptArg) return false;
  const cwd = process.cwd();
  const absPath = path.resolve(cwd, scriptArg);
  try {
    const realPath = fs.realpathSync(absPath);
    // Check 1: cwd/skills/ (local dev, Docker-baked skills)
    const cwdRoot = path.join(cwd, "skills") + path.sep;
    if (realPath.startsWith(cwdRoot)) return true;
    // Check 2: config skillsDir (K8s PV mount, e.g. /mnt/skills)
    const skillsDir = path.resolve(process.cwd(), loadConfig().paths.skillsDir);
    const envRoot = skillsDir + path.sep;
    if (realPath.startsWith(envRoot)) return true;
    return false;
  } catch {
    return false;
  }
}

// ── Sensitive path patterns ──────────────────────────────────────────

const SENSITIVE_PATH_RE = [
  ...CONTAINER_SENSITIVE_PATHS,
  // Local-only patterns (protect agentbox's own credentials)
  /\.siclaw\/credentials\//,
  /\.siclaw\/config\//,
  /\$\{?KUBECONFIG\}?/,
  /\/etc\/siclaw\//,
  /\.kube\//,
  /\.credentials\//,
];

// ── Tool definition ─────────────────────────────────────────────────

interface RestrictedBashParams {
  command: string;
  cluster?: string;
  timeout_seconds?: number;
  run_in_background?: boolean;
}

export function createRestrictedBashTool(
  kubeconfigRef?: KubeconfigRef,
  bg?: BackgroundExecWiring,
): ToolDefinition {
  // run_in_background is exposed to the model only when the master switch is on AND a
  // runtime executor was injected — otherwise the param stays out of the schema.
  const backgroundEnabled = BACKGROUND_BASH_ENABLED && Boolean(bg?.executor);
  return {
    name: "bash",
    label: "Bash",
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("bash")) +
          " " + (args?.command || ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Execute kubectl and shell commands for Kubernetes cluster operations.
This is the primary tool for all kubectl interactions. It runs through a shell, so pipes (|), &&, and redirections are fully supported.

Allowed commands: kubectl, grep, sort, uniq, wc, head, tail, cut, tr, jq, yq, column, and other text processing tools.
kubectl is restricted to read-only subcommands: get, describe, logs, top, events, api-resources, explain, config, version, cluster-info, auth.
In local mode, text processing commands (grep, cut, sort, etc.) only work after a pipe — direct file access is blocked. Use dedicated read/grep/glob tools for file operations.
All other binaries are blocked — except bash/sh/python3 invoking scripts under skills/.

Selecting a cluster: for kubectl commands, set the \`cluster\` parameter to the target cluster's credential name (from cluster_list) — its kubeconfig is injected automatically so plain "kubectl get ..." works. Omit \`cluster\` for non-Kubernetes commands. To query several clusters, make a separate call per cluster. The --kubeconfig flag and KUBECONFIG= env prefix are not supported — use the \`cluster\` parameter.

Rate protection rules for kubectl:
- "kubectl logs" requires --tail=<N> or --since=<duration>; bare logs without these will be rejected.
- "kubectl get -A -o yaml" and "kubectl get -A -o json" are blocked (bulk serialization). Use -o wide, -o name, or -o jsonpath instead.
- "kubectl describe/events/top -A" requires a selector (-l, --field-selector).

Examples:
- Simple: "kubectl get pods -n monitoring -o wide"
- With filter: "kubectl get pods -A -l app=web --field-selector status.phase!=Running"
- With pipe: "kubectl get pods -n default | grep -i error"
- Logs: "kubectl logs my-pod --tail=500 | grep ERROR"
- JSON query: "kubectl get pod my-pod -o json | jq '.status.conditions'"
- Skill scripts: "python3 skills/core/<skill>/scripts/run.py --flag value"

For long node-side work (e.g. RDMA perftest打流: a server on node A, a client on node B), do NOT hand-roll shell '&' here — use node_exec with run_in_background (it runs the command on the node, streams output to a file, and notifies you on completion).

Prefer kubectl built-in filtering (-l, --field-selector, -o jsonpath, -o custom-columns) over piping to grep when possible.
Do NOT use for non-kubectl tasks (file editing, package management, etc.).`,
    parameters: Type.Object({
      command: Type.String({
        description: "Shell command to execute, e.g. 'kubectl get pods -n default -o wide'",
      }),
      cluster: Type.Optional(
        Type.String({
          description:
            "Cluster name (from cluster_list) for kubectl commands — its kubeconfig " +
            "is injected so plain 'kubectl ...' works. Omit for non-Kubernetes shell commands (grep, jq, skill scripts, etc.).",
        })
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 60, max: 300)",
        })
      ),
      ...(backgroundEnabled
        ? {
            run_in_background: Type.Optional(
              Type.Boolean({
                description:
                  "Run the command in the background instead of waiting. Returns immediately with a " +
                  "task_id and output_file. IMPORTANT: after launching, END YOUR TURN — do NOT call " +
                  "read (or any other tool) to check on it, and do NOT sleep or wait. You will be " +
                  "automatically notified when it completes; ONLY THEN call task_output(task_id). Polling " +
                  "the file before the notification just wastes turns (it will not be there yet). Use " +
                  "for long-running work (perftest, follow logs, big collections). ALSO use it when one " +
                  "expensive collection has to answer SEVERAL questions (e.g. counting status codes AND " +
                  "duration buckets in the same log): launch it once, then run your greps against the " +
                  "output file, instead of re-running the collection per question. Output that needs " +
                  "structural (JSON) redaction cannot run in the background — use -o wide/name or run foreground.",
              })
            ),
          }
        : {}),
    }),
    async execute(toolCallId, rawParams, signal) {
      const params = rawParams as RestrictedBashParams;
      const command = params.command.trim();

      if (!command) {
        return {
          content: [{ type: "text", text: "Error: empty command." }],
          details: { blocked: true },
        };
      }

      // Async prefetch: load the cluster named by the `cluster` param into the
      // broker registry before the synchronous resolver runs.
      if (params.cluster) {
        try {
          await ensureClusterForTool(kubeconfigRef?.credentialBroker, params.cluster, "restricted_bash");
        } catch (err) {
          const failure = await classifyClusterFailure(kubeconfigRef?.credentialBroker, params.cluster, err);
          return {
            content: [{ type: "text", text: JSON.stringify(failure, null, 2) }],
            details: { error: true, reason: failure.reason },
          };
        }
      }

      // Resolve the selected cluster to a KUBECONFIG path. The `cluster` param is
      // the explicit, model-facing way to target a cluster (matching node_exec /
      // pod_exec etc.); when set we inject its kubeconfig so plain `kubectl ...`
      // works without an inline flag. When omitted, KUBECONFIG stays /dev/null so
      // non-Kubernetes shell commands run fine and a kubectl call fails clearly,
      // prompting the model to pass `cluster` (it decides — no command sniffing).
      let selectedKubeconfigPath = "/dev/null";
      if (params.cluster) {
        const r = resolveRequiredKubeconfig({ broker: kubeconfigRef?.credentialBroker }, params.cluster);
        if ("error" in r) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: true, message: r.error, available_clusters: r.availableNames }) }],
            details: { error: true, reason: "unknown_cluster" },
          };
        }
        selectedKubeconfigPath = r.path ?? "/dev/null";
      }

      // Pre-exec security: validate command + determine output sanitizer
      const pre = preExecSecurity(command, {
        context: "local",
        extraAllowed: new Set(["kubectl"]),
        isAllowed: (cmd) => isSkillScript(cmd),
        pipelineValidators: [validateKubectlInPipeline],
        sensitivePathPatterns: SENSITIVE_PATH_RE,
        analyzeTarget: "auto",
      });
      if (pre.error) {
        return {
          content: [{ type: "text", text: pre.error }],
          details: { blocked: true },
        };
      }

      // Skill scripts (debug pods, perftest, etc.) need longer timeouts
      const commands = _extractCommands(command);
      const isSkill = commands.some((c) => isSkillScript(c));
      const defaultTimeout = isSkill ? 180 : 60;

      // Sanitized env + KUBECONFIG injection — identical for foreground and background.
      const isProd = process.env.NODE_ENV === "production";

      // Whose deadline is it. In production the sandbox-side `timeout` owns it and the boundedExec
      // timer is only a backstop for a channel that never returns — so it must fire LATER, or it
      // pre-empts the only timer that can actually stop the command. Outside production there is no
      // sudo and no wrapper, so the boundedExec timer IS the deadline and must not be padded:
      // extending it unconditionally turned `timeout_seconds: 1` into a 16-second ceiling, and a
      // command that should have timed out returned successfully instead.
      const sandboxTimeoutS = Math.min(params.timeout_seconds ?? defaultTimeout, 300);
      const timeout = isProd
        ? (sandboxTimeoutS + SANDBOX_KILL_GRACE_S + OUTER_BACKSTOP_MARGIN_S) * 1000
        : sandboxTimeoutS * 1000;
      const env: Record<string, string> = {
        ...sanitizeEnv(process.env as Record<string, string>),
        SICLAW_DEBUG_IMAGE: loadConfig().debugImage,
        // KUBECONFIG from the resolved `cluster` param (see above): the cluster's
        // kubeconfig when set, else /dev/null. Inline --kubeconfig is rejected by
        // validation, so the `cluster` param is the only way to select a cluster.
        KUBECONFIG: selectedKubeconfigPath,
      };

      // In production (K8s pods), run child processes as the sandbox user.
      // sudo's SUID elevates to root, then drops to sandbox; -E preserves our
      // sanitized env (allowed by SETENV in sudoers).
      // Instrument a PIPELINE so bash reports each stage's status. Only for restricted_bash, and only
      // when there is a pipeline — see pipeline-status.ts for why nowhere else and what it does not cover.
      // Applied BEFORE the sudo wrapping so it runs in the inner bash, whose PIPESTATUS we want.
      //
      // FOREGROUND ONLY. The background writer streams straight to a file and never strips the sentinel
      // or classifies the result, so instrumenting it put `__siclaw_pipe_status_…` into the output the
      // model reads — breaking any JSON in it — while `kubectl get x | jq .` with kubectl exiting 1 still
      // completed as a success. That is the exact false empty-result this whole change set exists to
      // remove, reintroduced on the path that reports last.
      const wantsBackground = backgroundEnabled && params.run_in_background === true;
      const instrumented = !wantsBackground && hasPipeline(command);
      const baseCommand = instrumented ? instrumentPipeline(command) : command;
      // Set in production only, where the command runs as another user: it is both the sandbox-side
      // session's record and the handle used to reap it. Outside production there is no UID boundary
      // and the group kill already reaches everything.
      const sandboxPgidFile = isProd ? backgroundPgidFile(toolCallId) : undefined;
      /**
       * The command line for one mode, built per mode rather than once.
       *
       * The deadline differs between them — a background job keeps its old unbounded lifetime, a
       * foreground one must be bounded — and the two are NOT decided at the same point: a background
       * launch that the executor declines falls through and runs in the foreground. Baking the
       * choice in up front meant that fallback inherited the background command, so a foreground run
       * went out with no sandbox deadline at all and only the padded outer backstop, stopping a
       * `timeout_seconds: 1` command at about 16 seconds.
       *
       * The session is on both, because both have to be stoppable.
       */
      const wrapForMode = (mode: "foreground" | "background"): string => {
        if (!isProd) return baseCommand;
        // The deadline goes on the SANDBOX side. The pod drops CAP_KILL (security.md §5.2 grants
        // only SETUID, SETGID, CHOWN, FOWNER, AUDIT_WRITE) and the command runs as `sandbox` while
        // the agent runs as `agentbox`, so signalling from out here reaches the outer shell and
        // nothing beneath it. `kill(-pgid)` still SUCCEEDS in that case — one group member was
        // signalled — which is why this looked like it worked: the call returned and the command
        // kept running. Same shape node_exec already uses.
        return buildSandboxCommand(baseCommand, {
          ...(mode === "foreground" ? { timeoutS: sandboxTimeoutS } : {}),
          pgidFile: sandboxPgidFile,
        });
      };

      // ── Background mode ──────────────────────────────────────────────
      // Hand the fully-wrapped command to the runtime executor and return immediately.
      // The model reads progress via task_output(task_id) and is notified on completion.
      if (wantsBackground) {
        // Structural (JSON) sanitizers are not line-safe and cannot be streamed
        // per line without risking a leak — reject background mode for them.
        if (pre.action && !pre.action.lineSafe) {
          return backgroundNotLineSafeError();
        }
        try {
          const { jobId, outputFile } = bg!.executor!({
            command: wrapForMode("background"),
            env,
            cwd: process.cwd(),
            action: pre.action,
            hasSensitiveKubectl: pre.hasSensitiveKubectl,
            description: command.length > 80 ? command.slice(0, 77) + "…" : command,
            parentSessionId: bg!.sessionIdRef?.current ?? "",
            jobId: toolCallId,
            isProd,
            // The FOURTH way a run stops, and the one that has no deadline of its own: job_stop.
            // The runner's own kill is a process-group kill from this UID, which is why onAbort
            // exists at all — node_exec uses it to reap across a boundary the local kill cannot
            // cross, and a production background command is behind the same one. Without it a
            // stopped job keeps running as `sandbox` until the inner timeout expires, up to 300s
            // after the user asked it to stop.
            ...(sandboxPgidFile ? { onAbort: () => reapSandboxSession(sandboxPgidFile) } : {}),
          });
          return backgroundLaunchedResult(jobId, outputFile, "Running in the background.");
        } catch (err) {
          // Concurrency cap (or executor failure) → fall through to a foreground run
          // so the command still executes, with a note for the model.
          console.warn(`[restricted-bash] background launch declined, running foreground:`, err);
        }
      }

      try {
        // The timeout is enforced by boundedExec, not by child_process.exec's own `timeout` —
        // see bounded-exec.ts for why that one does not bound the call.
        // Also the path a declined background launch lands on, which is why the mode is named
        // here rather than inherited: a fallback must carry the foreground deadline.
        const { stdout, stderr } = await boundedExec(wrapForMode("foreground"), {
          env,
          timeoutMs: timeout,
          signal,
          // Covers the two stop conditions the sandbox-side `timeout` does not: an abort and an
          // output overflow are decided here, and the group kill this process can perform does not
          // cross the UID boundary.
          ...(sandboxPgidFile ? { reap: () => reapSandboxSession(sandboxPgidFile) } : {}),
        });

        // Strip the sentinel BEFORE anything reads the output: a structural sanitizer parses the whole
        // payload, so a trailing marker would make every instrumented `-o json` pipeline "not JSON".
        const okStages = instrumented ? extractPipelineStatus(stdout) : { stdout, statuses: [] };
        const okStdout = okStages.stdout;

        // Exit 0 does not mean every stage succeeded — it means the LAST one did. This is where
        // `kubectl get x | jq .` stops being reported as a successful empty result.
        const okJudgment = classifyExit({
          command: params.command, exitCode: 0, stdout: okStdout, stderr,
          context: "local", pipeStatuses: okStages.statuses,
        });
        const okNotes = (okJudgment.annotation ? `\n${okJudgment.annotation}` : "")
          + (tailTruncationNote(params.command, okStdout) ? `\n${tailTruncationNote(params.command, okStdout)}` : "");
        return {
          content: [{ type: "text", text: postExecSecurity(okStdout.trim(), pre.action, {
            stderr: stderr.trim() || undefined,
            hasSensitiveKubectl: pre.hasSensitiveKubectl,
            ...(okNotes ? { notes: okNotes } : {}),
          }) }],
          details: {
            exitCode: 0,
            exit_class: okJudgment.exitClass,
            ...(okStages.statuses.length > 1 ? { pipe_statuses: okStages.statuses } : {}),
            ...(okJudgment.isError && { error: true }),
          },
        };
      } catch (err: any) {
        const errStderr = err.stderr?.trim() ?? err.message;
        const errStages = instrumented
          ? extractPipelineStatus((err.stdout ?? "") as string)
          : { stdout: (err.stdout ?? "") as string, statuses: [] };
        const errStdout = errStages.stdout.trim();
        // An ABORT is not a timeout, and must not be described as one. Both arrive as
        // code=null/SIGKILL, which classifyExit reads as "killed at the tool's timeout — raise
        // timeout_seconds": advice that makes no sense for a user pressing Stop, and it contradicted
        // `details`, which only ever set timed_out for a real cap.
        const aborted = err?.aborted === true;
        // `timeout` exits 124 when the deadline fires — the documented, distinctive code, and now the
        // usual way a cap is reported since the sandbox-side wrapper owns the deadline. NOT 137:
        // that is "killed by SIGKILL", which a container OOM kill produces identically, so claiming
        // the cap there would misreport it. 137 falls through and is described by its signal.
        const hitCap = !aborted && (err?.timedOut === true || err?.code === 124);
        const judgment = aborted
          ? {
            exitClass: "interrupted" as const,
            isError: true,
            annotation: "[aborted: the run was stopped from outside — a user Stop or a cancelled "
              + "turn — so the command was killed before it finished. Nothing is wrong with the "
              + "command and the limit has nothing to do with it; re-run it if the work is still "
              + "wanted.]",
            channelLeg: undefined,
          }
          : classifyExit({
            command: params.command,
            exitCode: err.code,
            stdout: errStdout,
            stderr: errStderr,
            signal: err.signal,
            context: "local",
            pipeStatuses: errStages.statuses,
          });
        // classifyExit's `interrupted` annotation says to raise timeout_seconds but cannot say what
        // it currently is — it does not know. Naming the cap is the difference between advice and an
        // actionable number, so it is appended rather than reworded there. The cap named is the
        // SANDBOX one, which is what `timeout_seconds` sets; the outer backstop is not the caller's
        // to tune.
        const notes = (judgment.annotation ? `\n${judgment.annotation}` : "")
          + (hitCap ? `\n[cap in force: ${sandboxTimeoutS}s]` : "");
        return {
          content: [{ type: "text", text: postExecSecurity(errStdout, pre.action, {
            stderr: errStderr || undefined,
            hasSensitiveKubectl: pre.hasSensitiveKubectl,
            ...(notes ? { notes } : {}),
            exitCode: err.code ?? "unknown",
            ...(err.signal ? { signal: err.signal } : {}),
          }) }],
          details: {
            exitCode: err.code,
            exit_class: judgment.exitClass,
            ...(errStages.statuses.length > 1 ? { pipe_statuses: errStages.statuses } : {}),
            ...(judgment.channelLeg ? { channel_leg: judgment.channelLeg } : {}),
            // The text and these fields describe the same event, so they are set from the same
            // condition. They disagreed before: an abort read as a timeout in prose while
            // `timed_out` stayed unset.
            ...(hitCap ? { timed_out: true, timeout_seconds: sandboxTimeoutS } : {}),
            ...(aborted ? { aborted: true } : {}),
            ...(judgment.isError && { error: true }),
          },
        };
      }
    },
  };
}

export const registration: ToolEntry = {
  category: "cmd-exec",
  create: (refs) =>
    createRestrictedBashTool(refs.kubeconfigRef, {
      executor: refs.backgroundExecExecutor,
      sessionIdRef: refs.sessionIdRef,
    }),
};
