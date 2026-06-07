import type { ToolEntry, BackgroundExecWiring } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../../core/types.js";
import { resolveScript } from "../infra/script-resolver.js";
import { renderTextResult } from "../infra/tool-render.js";
import { postExecSecurity } from "../infra/security-pipeline.js";
import { checkPodRunning } from "../infra/k8s-checks.js";
import { loadConfig } from "../../core/config.js";
import { BACKGROUND_BASH_ENABLED } from "../../core/subagent-registry.js";
import { backgroundLaunchedResult } from "../cmd-exec/background-launch.js";
import { parseArgs, shellEscape } from "../infra/command-sets.js";
import { validatePodName, prepareExecEnv, spawnAsync, stdinExecCmd } from "../infra/exec-utils.js";
import { resolveRequiredKubeconfig } from "../infra/kubeconfig-resolver.js";
import { ensureClusterForTool } from "../infra/ensure-kubeconfigs.js";
import { backgroundPgidFile, wrapBackgroundSession, backgroundSessionKillScript } from "../infra/bg-session.js";
import { spawn } from "node:child_process";

interface PodScriptParams {
  pod: string;
  namespace?: string;
  container?: string;
  skill?: string;
  script: string;
  args?: string;
  cluster?: string;
  timeout_seconds?: number;
  run_in_background?: boolean;
}

export function createPodScriptTool(
  kubeconfigRef?: KubeconfigRef,
  bg?: BackgroundExecWiring,
): ToolDefinition {
  const backgroundEnabled = BACKGROUND_BASH_ENABLED && Boolean(bg?.executor);
  return {
    name: "pod_script",
    label: "Pod Script",
    renderCall(args: any, theme: any) {
      const ns = args?.namespace && args.namespace !== "default" ? `-n ${args.namespace}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("pod_script")) +
          " " + theme.fg("accent", args?.pod || "") +
          (ns ? " " + theme.fg("muted", ns) : "") +
          " " + theme.fg("muted", (args?.skill || "") + "/" + (args?.script || "")) +
          (args?.args ? " " + args.args : ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Execute a skill or user script inside a Kubernetes pod via kubectl exec.

The script is piped via stdin into the pod and executed with sh. This means the target pod only needs sh (and python3 for .py scripts).
No base64 or tar is required in the target container.

Use this for running diagnostic or operational scripts inside a running pod.

Scripts must come from a skill's scripts/ directory or from user-uploaded scripts. Read the skill's SKILL.md first for the exact script name, arguments, and usage — don't guess the filename.

Parameters:
- pod: Target pod name
- namespace: Namespace (default: "default")
- container: Container name (for multi-container pods)
- skill: Skill name. If omitted, looks in user scripts
- script: Script filename
- args: Optional arguments to pass to the script
- cluster: Cluster name (from cluster_list); omit to use the default cluster when only one is available
- timeout_seconds: Timeout (default: 180, max: 300)

Examples:
- pod: "my-app-pod-abc", namespace: "production", skill: "pod-diagnose", script: "check-health.sh"
- pod: "my-pod", script: "debug.sh", args: "--verbose"`,
    parameters: Type.Object({
      pod: Type.String({ description: "Target pod name" }),
      namespace: Type.Optional(
        Type.String({ description: 'Namespace (default: "default")' }),
      ),
      container: Type.Optional(
        Type.String({
          description: "Container name (for multi-container pods)",
        }),
      ),
      skill: Type.Optional(
        Type.String({
          description: "Skill name (omit to use user scripts)",
        }),
      ),
      script: Type.String({ description: "Exact script filename from the skill's scripts/ directory, as listed in its SKILL.md. Use it verbatim — do not guess or modify the name." }),
      args: Type.Optional(
        Type.String({ description: "Arguments to pass to the script" }),
      ),
      cluster: Type.Optional(
        Type.String({
          description: "Cluster name (from cluster_list). If omitted, uses the default cluster when only one is available.",
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 180, max: 300)",
        }),
      ),
      ...(backgroundEnabled
        ? {
            run_in_background: Type.Optional(
              Type.Boolean({
                description:
                  "Run the script in the pod in the background instead of waiting. Returns immediately with " +
                  "a task_id and output_file. IMPORTANT: after launching, END YOUR TURN — do NOT read the file " +
                  "or call any tool, and do NOT sleep/wait. You are notified automatically when it completes; " +
                  "ONLY THEN read the output_file. The script is wrapped in `timeout` (requires coreutils/busybox " +
                  "`timeout` in the pod). Use for long-running in-pod scripts (soak, load).",
              }),
            ),
          }
        : {}),
    }),
    async execute(toolCallId, rawParams, signal) {
      const params = rawParams as PodScriptParams;

      try {
        await ensureClusterForTool(kubeconfigRef?.credentialBroker, params.cluster, "pod_script");
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
          content: [{
            type: "text",
            text: `Error: invalid pod name "${pod}". Pod names may only contain lowercase letters, digits, hyphens, and dots.`,
          }],
          details: { error: true },
        };
      }

      // Resolve script
      const resolved = resolveScript({
        skill: params.skill,
        script: params.script,
      });
      if ("error" in resolved) {
        return {
          content: [{ type: "text", text: `Error: ${resolved.error}` }],
          details: { error: true },
        };
      }

      const args = params.args?.trim() || "";
      // Security: shell-escape each argument to prevent injection via args parameter
      const escapedArgs = args ? parseArgs(args).map(shellEscape).join(" ") : "";
      const timeout = Math.min(params.timeout_seconds ?? 180, 300) * 1000;

      // Pre-check: pod exists and is Running
      const podCheckErr = await checkPodRunning(
        pod, namespace, env.childEnv, env.kubeconfigPath ?? undefined,
      );
      if (podCheckErr) {
        return {
          content: [{ type: "text", text: `Error: ${podCheckErr}` }],
          details: { error: true },
        };
      }

      // Build kubectl exec args — pipe script via stdin, no temp files inside pod.
      // `-i` is an `exec` flag (not a global one), so it MUST come AFTER the `exec`
      // subcommand — placing it before makes kubectl stop at `-i`, fail to find a command,
      // and fall into plugin resolution ("flags cannot be placed before plugin name").
      const kubectlArgs = [...env.kubeconfigArgs, "-n", namespace, "exec", "-i", pod];
      if (params.container?.trim()) {
        kubectlArgs.push("-c", params.container.trim());
      }
      const execCmd = stdinExecCmd(resolved.interpreter, escapedArgs || undefined);
      kubectlArgs.push("--", "sh", "-c", execCmd);

      // ── Background mode ──────────────────────────────────────────────
      // Run the in-pod command under `setsid` (own session) wrapped in `timeout <ttl>`, with the
      // script piped via stdin. job_stop only reaps the LOCAL kubectl, so on abort we kubectl-exec
      // a session-kill in the pod (mirrors node_script) — closing the exec channel does not
      // reliably reap the in-pod process tree. Scripts are trusted assets → action null (line-safe).
      // Requires `timeout`/`setsid` in the pod.
      if (backgroundEnabled && params.run_in_background === true) {
        const cfg = loadConfig();
        const ttl = Math.min(params.timeout_seconds ?? cfg.debugPodTTL, cfg.debugPodTTL);
        const pgidFile = backgroundPgidFile(toolCallId);
        const wrapped = wrapBackgroundSession(`timeout ${ttl} ${execCmd}`, pgidFile);
        const bgArgs = [...env.kubeconfigArgs, "-n", namespace, "exec", "-i", pod];
        if (params.container?.trim()) bgArgs.push("-c", params.container.trim());
        bgArgs.push("--", "sh", "-c", wrapped);
        const killScript = backgroundSessionKillScript(pgidFile);
        const killArgs = [...env.kubeconfigArgs, "-n", namespace, "exec", pod];
        if (params.container?.trim()) killArgs.push("-c", params.container.trim());
        killArgs.push("--", "sh", "-c", killScript);
        const onAbort = () => {
          try {
            const killer = spawn("kubectl", killArgs, { env: env.childEnv as Record<string, string>, detached: true });
            killer.on("error", () => {});
            setTimeout(() => { try { killer.kill("SIGKILL"); } catch { /* gone */ } }, 15_000).unref();
            killer.unref();
          } catch { /* best-effort */ }
        };
        try {
          const { jobId, outputFile } = bg!.executor!({
            file: "kubectl",
            args: bgArgs,
            stdin: resolved.content,
            env: env.childEnv as Record<string, string>,
            action: null,
            hasSensitiveKubectl: false,
            description: `pod ${namespace}/${pod}: ${[params.skill, params.script].filter(Boolean).join("/")}`,
            parentSessionId: bg!.sessionIdRef?.current ?? "",
            jobId: toolCallId,
            isProd: process.env.NODE_ENV === "production",
            jobType: "pod",
            onAbort,
          });
          return backgroundLaunchedResult(jobId, outputFile, "Running the script in the pod in the background.");
        } catch (err) {
          console.warn(`[pod-script] background launch declined, running foreground:`, err);
        }
      }

      try {
        const result = await spawnAsync("kubectl", kubectlArgs, timeout, env.childEnv, signal, resolved.content);
        return {
          content: [{ type: "text", text: postExecSecurity(result.stdout.trim(), null, { stderr: result.stderr.trim() || undefined }) }],
          details: { exitCode: 0 },
        };
      } catch (err: any) {
        const stdout = err.stdout?.trim() ?? "";
        const stderr = err.stderr?.trim() ?? err.message;
        return {
          content: [{ type: "text", text: postExecSecurity(`${stdout || "(no output)"}\n[exit code: ${err.code ?? "unknown"}]`, null, { stderr: stderr || undefined }) }],
          details: { exitCode: err.code ?? null, error: true },
        };
      }
    },
  };
}

export const registration: ToolEntry = {
  category: "script-exec",
  create: (refs) =>
    createPodScriptTool(refs.kubeconfigRef, {
      executor: refs.backgroundExecExecutor,
      sessionIdRef: refs.sessionIdRef,
    }),
};
