import type { ToolEntry, BackgroundExecWiring } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { KubeconfigRef } from "../../core/types.js";
import { renderTextResult } from "../infra/tool-render.js";
import { checkPodRunning } from "../infra/k8s-checks.js";
import { BACKGROUND_BASH_ENABLED } from "../../core/subagent-registry.js";
import { loadConfig } from "../../core/config.js";
import { parseArgs, CONTAINER_SENSITIVE_PATHS } from "../infra/command-sets.js";
import { preExecSecurity, postExecSecurity } from "../infra/security-pipeline.js";
import { backgroundNotLineSafeError, backgroundLaunchedResult } from "./background-launch.js";
import { validatePodName, prepareExecEnv, filterPodNoise } from "../infra/exec-utils.js";
import { resolveRequiredKubeconfig } from "../infra/kubeconfig-resolver.js";
import { ensureClusterForTool } from "../infra/ensure-kubeconfigs.js";

const execFileAsync = promisify(execFile);

// Re-export for backward compatibility (tests + downstream imports)
export { validatePodName } from "../infra/exec-utils.js";

interface PodExecParams {
  pod: string;
  namespace?: string;
  container?: string;
  command: string;
  cluster?: string;
  timeout_seconds?: number;
  run_in_background?: boolean;
}

export function createPodExecTool(kubeconfigRef?: KubeconfigRef, bg?: BackgroundExecWiring): ToolDefinition {
  const backgroundEnabled = BACKGROUND_BASH_ENABLED && Boolean(bg?.executor);
  return {
    name: "pod_exec",
    label: "Pod Exec",
    description: `Execute a single diagnostic command inside a running Kubernetes pod via kubectl exec. For multi-step scripts, use pod_script instead.

Runs a single whitelisted command directly inside the target pod's container.
The command runs in the pod's own environment — it uses whatever tools are available in the container image.

Use this tool for in-pod diagnostics such as:
- Checking network from the pod's perspective (ip addr, ss, netstat, ping, curl)
- Inspecting processes inside the pod (ps, top, pgrep)
- Reading config or log files (cat, head, tail, ls, find, grep)
- Checking resource usage (df, du, free)

Allowed commands (ONLY these are permitted):
  network: ip, ifconfig, ping, traceroute, tracepath, ss, netstat, route, arp, ethtool, mtr, bridge, tc, conntrack, nslookup, dig, host, curl
  text: grep, egrep, fgrep, sort, uniq, wc, head, tail, cut, tr, jq, yq, column
  process: ps, pgrep, top, free, vmstat, iostat, mpstat, df, du, mount, findmnt, nproc
  file (read-only): cat, ls, pwd, stat, file, find, readlink, realpath, basename, dirname, diff, md5sum, sha256sum
  kernel: uname, hostname, uptime, dmesg, sysctl, lsmod, modinfo
  general: date, whoami, id, env, printenv, which, echo, printf, sleep

Shell features (pipes, redirects) are NOT supported — commands are passed as argv, not through a shell.
The following will be rejected: find with -exec/-delete, sysctl with -w, mount with actual mounting,
curl with -o/-O/-T (file output/upload) and all non-read HTTP methods (POST, PUT, DELETE, PATCH) and data flags (-d/--data), env with command arguments (only listing allowed).

Examples:
- pod: "my-app-abc", namespace: "production", command: "ip addr show"
- pod: "nginx-xyz", command: "cat /etc/nginx/nginx.conf"
- pod: "my-app-abc", command: "ps aux"
- pod: "my-app-abc", namespace: "production", command: "curl -s http://localhost:8080/healthz"`,
    parameters: Type.Object({
      pod: Type.String({
        description: "Target pod name",
      }),
      namespace: Type.Optional(
        Type.String({
          description: 'Namespace (default: "default")',
        }),
      ),
      container: Type.Optional(
        Type.String({
          description: "Container name (for multi-container pods)",
        }),
      ),
      command: Type.String({
        description:
          'Diagnostic command to run in the pod (e.g. "ip addr show", "ps aux")',
      }),
      cluster: Type.Optional(
        Type.String({
          description: "Cluster name (from cluster_list). If omitted, uses the default cluster when only one is available.",
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 30, max: 120; ignored when run_in_background)",
        }),
      ),
      ...(backgroundEnabled
        ? {
            run_in_background: Type.Optional(
              Type.Boolean({
                description:
                  "Run the command inside the pod in the background instead of waiting. Returns immediately " +
                  "with a task_id and output_file. After launching, END YOUR TURN by default (do NOT poll, " +
                  "sleep, or read its output until the completion notification — then call task_output(task_id), " +
                  "not the raw output_file). EXCEPTION: when this is the " +
                  "server/listener side of a paired test, do NOT wait — IMMEDIATELY run the counterpart, then call " +
                  "task_output(task_id) when the test finishes (waiting for the server's completion first deadlocks: it " +
                  "blocks until the client connects, then times out). Note: if stopped early, the in-pod process may " +
                  "keep running until the pod ends. Output needing structural (JSON) redaction cannot run in background.",
              })
            ),
          }
        : {}),
    }),
    renderCall(args: any, theme: any) {
      const pod = args?.pod || "...";
      const ns = args?.namespace || "default";
      const cmd = args?.command || "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("pod_exec")) +
          " " + theme.fg("accent", `${ns}/${pod}`) +
          " " + theme.fg("toolTitle", theme.bold("$")) +
          " " + cmd,
        0, 0,
      );
    },
    renderResult: renderTextResult,
    async execute(toolCallId, rawParams, signal) {
      const params = rawParams as PodExecParams;

      try {
        await ensureClusterForTool(kubeconfigRef?.credentialBroker, params.cluster, "pod_exec");
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true, reason: "kubeconfig_ensure_failed" },
        };
      }

      const kubeResult = resolveRequiredKubeconfig({ broker: kubeconfigRef?.credentialBroker }, params.cluster);
      if ("error" in kubeResult) {
        return {
          content: [{ type: "text", text: `Error: ${kubeResult.error}` }],
          details: { error: true },
        };
      }
      const env = prepareExecEnv(kubeconfigRef, kubeResult.path);
      const pod = params.pod?.trim();
      const namespace = params.namespace?.trim() || "default";

      // Validate pod name
      const podErr = validatePodName(pod);
      if (podErr) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: podErr }, null, 2) }],
          details: { blocked: true, reason: "invalid_pod_name" },
        };
      }

      // Pre-exec security: validate command + determine output sanitizer
      const pre = preExecSecurity(params.command, {
        context: "pod",
        sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS,
        blockPipeline: true,
      });
      if (pre.error) {
        return {
          content: [{ type: "text", text: pre.error }],
          details: { blocked: true, reason: "command_blocked" },
        };
      }

      // Check pod exists and is Running
      const podCheckErr = await checkPodRunning(
        pod, namespace, env.childEnv, env.kubeconfigPath ?? undefined,
      );
      if (podCheckErr) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: podCheckErr }, null, 2) }],
          details: { error: true },
        };
      }

      const timeout = Math.min(params.timeout_seconds ?? 30, 120) * 1000;

      // Build kubectl exec args
      const cmdArgs = parseArgs(params.command);
      const execArgs = cmdArgs;
      const kubectlArgs = [...env.kubeconfigArgs, "exec", pod, "-n", namespace];
      if (params.container?.trim()) {
        kubectlArgs.push("-c", params.container.trim());
      }
      kubectlArgs.push("--", ...execArgs);

      // ── Background mode ──────────────────────────────────────────────
      // No debug pod / no pin — the target pod is user-managed. Wrap the in-pod command in
      // `timeout <ttl>` so a long/runaway background process (tail -f, a loop) self-terminates
      // instead of running until the pod dies: job_stop here only reaps the LOCAL kubectl, not
      // the pod-internal process. Requires `timeout` in the target pod (coreutils/busybox) —
      // without it the launch errors visibly (acceptable; far better than an unbounded leak).
      if (backgroundEnabled && params.run_in_background === true) {
        if (pre.action && !pre.action.lineSafe) {
          return backgroundNotLineSafeError();
        }
        const cfg = loadConfig();
        const ttl = Math.min(params.timeout_seconds ?? cfg.debugPodTTL, cfg.debugPodTTL);
        const bgKubectlArgs = [...env.kubeconfigArgs, "exec", pod, "-n", namespace];
        if (params.container?.trim()) bgKubectlArgs.push("-c", params.container.trim());
        bgKubectlArgs.push("--", "timeout", String(ttl), ...execArgs);
        try {
          const { jobId, outputFile } = bg!.executor!({
            file: "kubectl",
            args: bgKubectlArgs,
            env: env.childEnv as Record<string, string>,
            action: pre.action,
            hasSensitiveKubectl: pre.hasSensitiveKubectl,
            description: `pod ${namespace}/${pod}: ${params.command.length > 60 ? params.command.slice(0, 57) + "…" : params.command}`,
            parentSessionId: bg!.sessionIdRef?.current ?? "",
            jobId: toolCallId,
            isProd: process.env.NODE_ENV === "production",
            jobType: "pod",
          });
          return backgroundLaunchedResult(jobId, outputFile, "Running in the pod in the background.");
        } catch (err) {
          console.warn(`[pod-exec] background launch declined, running foreground:`, err);
        }
      }

      try {
        // Thread the turn's AbortSignal so a Stop promptly kills the LOCAL kubectl. The in-pod
        // process runs in the pod's own PID namespace and is bounded by the pod lifecycle (we do
        // not setsid/timeout-wrap it here — minimal target images may lack sh/setsid/timeout), so
        // unlike node_exec/host_exec there is no host-namespace orphan to reap over a new connection.
        const { stdout, stderr } = await execFileAsync(
          "kubectl",
          kubectlArgs,
          { timeout, env: env.childEnv, signal },
        );

        return {
          content: [{ type: "text", text: postExecSecurity(stdout.trim(), pre.action, { stderr: filterPodNoise(stderr.trim()) || undefined }) }],
          details: { exitCode: 0 },
        };
      } catch (err: any) {
        // User Stop → execFile rejects with an AbortError; surface a clean "Aborted." rather than
        // a spurious command error like "[exit code: ABORT_ERR]" (mirrors node_exec/host_exec).
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Aborted." }], details: { error: true } };
        }
        const stdout = (err.stdout?.trim() ?? "") as string;
        const stderr = filterPodNoise((err.stderr?.trim() ?? err.message) as string);
        const exitCode = err.code ?? "unknown";
        return {
          content: [{ type: "text", text: postExecSecurity(`${stdout || "(no output)"}\n[exit code: ${exitCode}]`, pre.action, { stderr: stderr || undefined }) }],
          details: { exitCode, error: true },
        };
      }
    },
  };
}

export const registration: ToolEntry = {
  category: "cmd-exec",
  create: (refs) =>
    createPodExecTool(refs.kubeconfigRef, {
      executor: refs.backgroundExecExecutor,
      sessionIdRef: refs.sessionIdRef,
    }),
};
