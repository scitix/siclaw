import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../../core/agent-factory.js";
import { resolveScript } from "../infra/script-resolver.js";
import { renderTextResult } from "../infra/tool-render.js";
import { postExecSecurity } from "../infra/security-pipeline.js";
import { checkPodRunning } from "../infra/k8s-checks.js";
import { parseArgs, shellEscape } from "../infra/command-sets.js";
import { validatePodName, prepareExecEnv, spawnAsync, stdinExecCmd } from "../infra/exec-utils.js";
import { resolveRequiredKubeconfig } from "../infra/kubeconfig-resolver.js";

interface PodScriptParams {
  pod: string;
  namespace?: string;
  container?: string;
  skill?: string;
  script: string;
  args?: string;
  kubeconfig?: string;
  timeout_seconds?: number;
}

export function createPodScriptTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
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

Scripts must come from a skill's scripts/ directory or from user-uploaded scripts.

Parameters:
- pod: Target pod name
- namespace: Namespace (default: "default")
- container: Container name (for multi-container pods)
- skill: Skill name. If omitted, looks in user scripts
- script: Script filename
- args: Optional arguments to pass to the script
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
      script: Type.String({ description: "Script filename" }),
      args: Type.Optional(
        Type.String({ description: "Arguments to pass to the script" }),
      ),
      kubeconfig: Type.Optional(
        Type.String({
          description: "Credential name of the target cluster (from credential_list). If omitted, uses the default kubeconfig.",
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 180, max: 300)",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as PodScriptParams;

      const kubeResult = resolveRequiredKubeconfig(kubeconfigRef?.credentialsDir, params.kubeconfig);
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

      // Build kubectl exec args — pipe script via stdin, no temp files inside pod
      const kubectlArgs = [...env.kubeconfigArgs, "-n", namespace, "-i", "exec", pod];
      if (params.container?.trim()) {
        kubectlArgs.push("-c", params.container.trim());
      }
      const execCmd = stdinExecCmd(resolved.interpreter, escapedArgs || undefined);
      kubectlArgs.push("--", "sh", "-c", execCmd);

      try {
        const result = await spawnAsync("kubectl", kubectlArgs, timeout, env.childEnv, signal, resolved.content);
        const output = result.stdout.trim() +
          (result.stderr.trim() ? `\n\nSTDERR:\n${result.stderr.trim()}` : "");
        return {
          content: [{ type: "text", text: postExecSecurity(output, null) }],
          details: { exitCode: 0 },
        };
      } catch (err: any) {
        const stdout = err.stdout?.trim() ?? "";
        const stderr = err.stderr?.trim() ?? err.message;
        const output = `Exit code: ${err.code ?? "unknown"}\n${stdout}${stderr ? `\n\nSTDERR:\n${stderr}` : ""}`;
        return {
          content: [{ type: "text", text: postExecSecurity(output, null) }],
          details: { exitCode: err.code ?? null, error: true },
        };
      }
    },
  };
}
