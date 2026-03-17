import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { resolveScript } from "./script-resolver.js";
import { processToolOutput, renderTextResult } from "./tool-render.js";
import { checkPodRunning } from "./k8s-checks.js";
import { parseArgs, shellEscape } from "./command-sets.js";
import { validatePodName, prepareExecEnv } from "./exec-utils.js";
import { resolveRequiredKubeconfig } from "./kubeconfig-resolver.js";

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

      // Build kubectl exec args
      const kubectlArgs = [...env.kubeconfigArgs, "exec", "-i", pod, "-n", namespace];
      if (params.container?.trim()) {
        kubectlArgs.push("-c", params.container.trim());
      }

      // Use the appropriate interpreter
      const ext = resolved.interpreter === "python3" ? ".py" : ".sh";
      const execCmd = escapedArgs
        ? `cat > /tmp/_s${ext} && chmod +x /tmp/_s${ext} && ${resolved.interpreter} /tmp/_s${ext} ${escapedArgs}; r=$?; rm -f /tmp/_s${ext}; exit $r`
        : `cat > /tmp/_s${ext} && chmod +x /tmp/_s${ext} && ${resolved.interpreter} /tmp/_s${ext}; r=$?; rm -f /tmp/_s${ext}; exit $r`;
      kubectlArgs.push("--", "sh", "-c", execCmd);

      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";

        const child = spawn("kubectl", kubectlArgs, {
          stdio: ["pipe", "pipe", "pipe"],
          env: env.childEnv,
        });

        const onAbort = () => child.kill("SIGKILL");
        signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, timeout);

        // Pipe script content via stdin
        child.stdin.write(resolved.content);
        child.stdin.end();

        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const output =
            stdout.trim() +
            (stderr.trim() ? `\n\nSTDERR:\n${stderr.trim()}` : "");

          if (code === 0) {
            resolve({
              content: [{ type: "text", text: processToolOutput(output) }],
              details: { exitCode: 0 },
            });
          } else {
            const errOutput = `Exit code: ${code ?? "unknown"}\n${output}`;
            resolve({
              content: [
                { type: "text", text: processToolOutput(errOutput) },
              ],
              details: { exitCode: code, error: true },
            });
          }
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve({
            content: [
              {
                type: "text",
                text: processToolOutput(`Error: ${err.message}`),
              },
            ],
            details: { error: true },
          });
        });
      });
    },
  };
}
