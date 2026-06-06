import type { ToolEntry, BackgroundExecWiring } from "../../core/tool-registry.js";
import { BACKGROUND_BASH_ENABLED } from "../../core/subagent-registry.js";
import { Type } from "@sinclair/typebox";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../../core/types.js";
import { renderTextResult } from "../infra/tool-render.js";
import { SAFE_SUBCOMMANDS, checkAllNamespacesRestriction } from "../infra/command-sets.js";
import { loadConfig } from "../../core/config.js";
import {
  CONTAINER_SENSITIVE_PATHS,
  getCommandBinary,
  parseArgs,
  validateCommandRestrictions,
} from "../infra/command-sets.js";
import { resolveRequiredKubeconfig } from "../infra/kubeconfig-resolver.js";
import { ensureClusterForTool } from "../infra/ensure-kubeconfigs.js";
import { sanitizeEnv } from "../infra/sanitize-env.js";
import {
  extractCommands as _extractCommands,
  validateShellOperators as _validateShellOperators,
} from "../infra/command-validator.js";
import { preExecSecurity, postExecSecurity } from "../infra/security-pipeline.js";
import { backgroundNotLineSafeError, backgroundLaunchedResult } from "./background-launch.js";

const execAsync = promisify(exec);

// ── Re-exports for backward compatibility ────────────────────────────

export { extractCommands, validateShellOperators } from "../infra/command-validator.js";
export { getCommandBinary } from "../infra/command-sets.js";

// ── kubectl pipeline validator ───────────────────────────────────────

/**
 * Validate kubectl commands within a pipeline.
 * Checks that subcommands are in the safe whitelist.
 * Returns an error message if blocked, or null if all kubectl commands are safe.
 */
export function validateKubectlInPipeline(commands: string[]): string | null {
  for (const cmd of commands) {
    const binary = getCommandBinary(cmd);
    if (binary !== "kubectl") continue;

    // Extract the kubectl arguments from the command string
    const stripped = cmd.trim().replace(/^\S+\s+/, ""); // remove "kubectl" prefix
    const args = parseArgs(stripped);
    // Skip flags and their values to find the actual subcommand.
    // Flags like -n, --namespace, --kubeconfig consume the next arg as a value,
    // so "kubectl -n kube-system get pods" must not treat "kube-system" as subcommand.
    const KUBECTL_VALUE_FLAGS = new Set([
      "-n", "--namespace", "--kubeconfig", "--context", "--cluster",
      "--user", "--server", "-s", "--token", "--certificate-authority",
      "--client-certificate", "--client-key", "--tls-server-name",
    ]);
    let subcommand: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith("-")) {
        // Skip flag + its value if it's a known value-taking flag (without =)
        if (KUBECTL_VALUE_FLAGS.has(a) && !a.includes("=")) i++;
        continue;
      }
      subcommand = a.toLowerCase();
      break;
    }

    if (subcommand === "exec") {
      return JSON.stringify({
        error: "kubectl exec is not available through restricted_bash.",
        hint: "Use the pod_exec tool to run commands inside a pod, or node_exec for host-level diagnostics.",
      }, null, 2);
    }

    if (!subcommand || !SAFE_SUBCOMMANDS.has(subcommand)) {
      return JSON.stringify({
        error: `kubectl subcommand "${subcommand || "(empty)"}" is not allowed in read-only mode.`,
        allowed: [...SAFE_SUBCOMMANDS],
      }, null, 2);
    }

    // The inline --kubeconfig flag is removed — selecting a cluster is done via the
    // tool's `cluster` parameter (whole-command KUBECONFIG injection). This also
    // closes the file-path-in-flag footgun. To query a different cluster, make a
    // separate bash call with that `cluster`.
    if (args.some((a) => a === "--kubeconfig" || a.startsWith("--kubeconfig="))) {
      return JSON.stringify({
        error: "The --kubeconfig flag is not supported.",
        hint: "Set the `cluster` parameter to the target cluster's name (from cluster_list) instead. For multiple clusters, make a separate bash call per cluster.",
      }, null, 2);
    }

    // ── Rate protection: logs without --tail/--since ─────────────
    if (subcommand === "logs") {
      const hasTail = args.some(a => a === "--tail" || a.startsWith("--tail="));
      const hasSince = args.some(a =>
        a === "--since" || a.startsWith("--since=") ||
        a === "--since-time" || a.startsWith("--since-time="),
      );
      if (!hasTail && !hasSince) {
        return JSON.stringify({
          error: "kubectl logs without --tail or --since can pull excessive data from the kubelet.",
          hint: 'Add --tail=<N> or --since=<duration>, e.g. "kubectl logs my-pod --tail=1000".',
        }, null, 2);
      }
    }

    // ── Rate protection: -A/--all-namespaces ───
    const allNsErr = checkAllNamespacesRestriction(args, subcommand);
    if (allNsErr) {
      return JSON.stringify({
        error: allNsErr,
        hint: "Use -n <namespace> to target a specific namespace, or add -l <label> / --field-selector <selector> to narrow the query.",
      }, null, 2);
    }

    // Block "kubectl config view --raw" — leaks full kubeconfig with certs/tokens
    if (subcommand === "config") {
      const configSub = args.filter((a) => !a.startsWith("-"));
      const hasView = configSub.includes("view");
      const hasRaw = args.includes("--raw");
      if (hasView && hasRaw) {
        return JSON.stringify({
          error: "kubectl config view --raw is not allowed — it exposes credentials.",
        }, null, 2);
      }
    }

    // Sensitive resource access (Secret, ConfigMap, Pod) is handled by
    // post-execution sanitization via OUTPUT_RULES["kubectl"] + pipeline
    // fallback redaction. No pre-execution blocking needed here.
  }
  return null;
}

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
                  "automatically notified when it completes; ONLY THEN read the output_file. Polling " +
                  "the file before the notification just wastes turns (it will not be there yet). Use " +
                  "for long-running work (perftest, follow logs, big collections). Output that needs " +
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
          return {
            content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            details: { error: true, reason: "kubeconfig_ensure_failed" },
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

      const timeout = Math.min(params.timeout_seconds ?? defaultTimeout, 300) * 1000;

      // Sanitized env + KUBECONFIG injection — identical for foreground and background.
      const isProd = process.env.NODE_ENV === "production";
      const env: Record<string, string> = {
        ...sanitizeEnv(process.env as Record<string, string>),
        SICLAW_DEBUG_IMAGE: loadConfig().debugImage,
        ...(kubeconfigRef?.credentialsDir ? { SICLAW_CREDENTIALS_DIR: kubeconfigRef.credentialsDir } : {}),
        // KUBECONFIG from the resolved `cluster` param (see above): the cluster's
        // kubeconfig when set, else /dev/null. Inline --kubeconfig is rejected by
        // validation, so the `cluster` param is the only way to select a cluster.
        KUBECONFIG: selectedKubeconfigPath,
      };

      // In production (K8s pods), run child processes as the sandbox user.
      // sudo's SUID elevates to root, then drops to sandbox; -E preserves our
      // sanitized env (allowed by SETENV in sudoers).
      let execCommand = command;
      if (isProd) {
        const escaped = command.replace(/'/g, "'\\''");
        execCommand = `sudo -E -u sandbox -- bash -c '${escaped}'`;
      }

      // ── Background mode ──────────────────────────────────────────────
      // Hand the fully-wrapped command to the runtime executor and return immediately.
      // The model reads progress via `read` on output_file and is notified on completion.
      if (backgroundEnabled && params.run_in_background === true) {
        // Structural (JSON) sanitizers are not line-safe and cannot be streamed
        // per line without risking a leak — reject background mode for them.
        if (pre.action && !pre.action.lineSafe) {
          return backgroundNotLineSafeError();
        }
        try {
          const { jobId, outputFile } = bg!.executor!({
            command: execCommand,
            env,
            cwd: process.cwd(),
            action: pre.action,
            hasSensitiveKubectl: pre.hasSensitiveKubectl,
            description: command.length > 80 ? command.slice(0, 77) + "…" : command,
            parentSessionId: bg!.sessionIdRef?.current ?? "",
            jobId: toolCallId,
            isProd,
          });
          return backgroundLaunchedResult(jobId, outputFile, "Running in the background.");
        } catch (err) {
          // Concurrency cap (or executor failure) → fall through to a foreground run
          // so the command still executes, with a note for the model.
          console.warn(`[restricted-bash] background launch declined, running foreground:`, err);
        }
      }

      try {
        const execOpts = {
          timeout,
          maxBuffer: 1024 * 1024 * 10,
          shell: "/bin/bash",
          detached: true, // make child a process group leader for clean group kill
          env,
        };

        const child = exec(execCommand, execOpts as any);

        // Kill the entire process group (shell + all child processes like kubectl exec)
        // detached: true makes the shell a process group leader, so -pid kills the whole group
        const onAbort = () => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
          child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
          child.on("close", (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(Object.assign(new Error(`exit ${code}`), { code, stdout, stderr }));
          });
          child.on("error", reject);
        });

        signal?.removeEventListener("abort", onAbort);

        return {
          content: [{ type: "text", text: postExecSecurity(stdout.trim(), pre.action, { stderr: stderr.trim() || undefined, hasSensitiveKubectl: pre.hasSensitiveKubectl }) }],
          details: { exitCode: 0 },
        };
      } catch (err: any) {
        const errStderr = err.stderr?.trim() ?? err.message;
        return {
          content: [{ type: "text", text: postExecSecurity(`${err.stdout?.trim() || "(no output)"}\n[exit code: ${err.code ?? "unknown"}]`, pre.action, { stderr: errStderr || undefined, hasSensitiveKubectl: pre.hasSensitiveKubectl }) }],
          details: { exitCode: err.code, error: true },
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
