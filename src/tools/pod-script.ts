import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { resolveScript } from "./script-resolver.js";
import { processToolOutput, renderTextResult } from "./tool-render.js";
import { checkPodRunning } from "./k8s-checks.js";

interface PodScriptParams {
  pod: string;
  namespace?: string;
  container?: string;
  skill?: string;
  script: string;
  args?: string;
  timeout_seconds?: number;
}

// Valid pod name: RFC 1123 subdomain
const POD_NAME_RE = /^[a-z0-9][a-z0-9.\-]*$/;

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
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 180, max: 300)",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as PodScriptParams;
      const pod = params.pod?.trim();
      const namespace = params.namespace?.trim() || "default";

      if (!pod || !POD_NAME_RE.test(pod)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: invalid pod name "${pod}". Pod names may only contain lowercase letters, digits, hyphens, and dots.`,
            },
          ],
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
      const timeout = Math.min(params.timeout_seconds ?? 180, 300) * 1000;

      // Pre-check: pod exists and is Running
      const childEnv = {
        ...process.env,
        ...(kubeconfigRef?.credentialsDir ? { SICLAW_CREDENTIALS_DIR: kubeconfigRef.credentialsDir } : {}),
      };
      const podCheckErr = await checkPodRunning(pod, namespace, childEnv);
      if (podCheckErr) {
        return {
          content: [{ type: "text", text: `Error: ${podCheckErr}` }],
          details: { error: true },
        };
      }

      // Build kubectl exec args
      const kubectlArgs = ["exec", "-i", pod, "-n", namespace];
      if (params.container?.trim()) {
        kubectlArgs.push("-c", params.container.trim());
      }

      // Use the appropriate interpreter
      const ext = resolved.interpreter === "python3" ? ".py" : ".sh";
      const execCmd = args
        ? `cat > /tmp/_s${ext} && chmod +x /tmp/_s${ext} && ${resolved.interpreter} /tmp/_s${ext} ${args}; r=$?; rm -f /tmp/_s${ext}; exit $r`
        : `cat > /tmp/_s${ext} && chmod +x /tmp/_s${ext} && ${resolved.interpreter} /tmp/_s${ext}; r=$?; rm -f /tmp/_s${ext}; exit $r`;
      kubectlArgs.push("--", "sh", "-c", execCmd);

      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";

        const child = spawn("kubectl", kubectlArgs, {
          stdio: ["pipe", "pipe", "pipe"],
          env: childEnv,
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
