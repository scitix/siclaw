import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { resolveScript } from "./script-resolver.js";
import { renderTextResult } from "./tool-render.js";
import { loadConfig } from "../core/config.js";
import { parseArgs, shellEscape } from "./command-sets.js";
import {
  validatePodName,
  prepareExecEnv,
  resolveContainerNetns,
  runInDebugPod,
  formatExecOutput,
} from "./exec-utils.js";

interface NetnsScriptParams {
  pod: string;
  namespace?: string;
  container?: string;
  skill?: string;
  script: string;
  args?: string;
  image?: string;
  timeout_seconds?: number;
}

export function createNetnsScriptTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
  return {
    name: "pod_netns_script",
    label: "Pod Netns Script",
    renderCall(args: any, theme: any) {
      const ns = args?.namespace && args.namespace !== "default" ? `-n ${args.namespace}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("pod_netns_script")) +
          " " + theme.fg("accent", args?.pod || "") +
          (ns ? " " + theme.fg("muted", ns) : "") +
          " " + theme.fg("accent", args?.node || "") +
          " " + theme.fg("muted", (args?.skill || "") + "/" + (args?.script || "")) +
          (args?.args ? " " + args.args : ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Execute a skill or user script in a pod's network namespace using the host's tools.

Creates a privileged debug pod on the same node as the target pod, then uses double nsenter:
1. Outer nsenter: enters the host's full namespaces (to access host tools like tcpdump, ss, ip, etc.)
2. Inner nsenter: enters only the pod's network namespace (to see the pod's network interfaces, IPs, routes)

This gives the ideal environment for network diagnostics: host tools + pod's network view.

Scripts must come from a skill's scripts/ directory or from user-uploaded scripts.

Node requirements: the host must have jq and crictl installed.

Parameters:
- pod: Target pod name (the pod whose network namespace to enter)
- namespace: Namespace (default: "default")
- container: Container name (for multi-container pods, to determine which netns)
- skill: Skill name. If omitted, looks in user scripts
- script: Script filename
- args: Optional arguments to pass to the script
- image: Debug container image (default: SICLAW_DEBUG_IMAGE)
- timeout_seconds: Timeout (default: 180, max: 300)

Examples:
- pod: "my-app-pod", namespace: "production", skill: "pod-network-debug", script: "capture-traffic.sh", args: "--port 8080"
- pod: "gateway-pod", script: "check-routes.sh"`,
    parameters: Type.Object({
      pod: Type.String({
        description: "Target pod name (whose network namespace to enter)",
      }),
      namespace: Type.Optional(
        Type.String({ description: 'Namespace (default: "default")' }),
      ),
      container: Type.Optional(
        Type.String({
          description:
            "Container name (for multi-container pods, to determine netns)",
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
      image: Type.Optional(
        Type.String({
          description: "Debug container image (default: SICLAW_DEBUG_IMAGE)",
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 180, max: 300)",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as NetnsScriptParams;
      const env = prepareExecEnv(kubeconfigRef);
      const pod = params.pod?.trim();
      const namespace = params.namespace?.trim() || "default";

      // Validate pod name
      const podErr = validatePodName(pod);
      if (podErr) {
        return {
          content: [{
            type: "text",
            text: `Error: ${podErr}`,
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

      // Resolve container network namespace
      const netns = await resolveContainerNetns(pod, namespace, params.container, env);
      if ("error" in netns) {
        return {
          content: [{ type: "text", text: `Error: ${netns.error}` }],
          details: { error: true },
        };
      }

      const image = params.image || loadConfig().debugImage;
      const timeout = Math.min(params.timeout_seconds ?? 180, 300) * 1000;
      const args = params.args?.trim() || "";

      // Base64 encode script content
      const b64 = Buffer.from(resolved.content).toString("base64");
      const ext = resolved.interpreter === "python3" ? ".py" : ".sh";
      // Security: shell-escape each argument to prevent injection via args parameter
      const escapedArgs = args ? parseArgs(args).map(shellEscape).join(" ") : "";
      const scriptArgs = escapedArgs ? ` ${escapedArgs}` : "";

      // The inner script that runs inside nsenter on the host.
      // Uses unshare --mount + sysfs remount so that /sys reflects the pod's
      // network namespace (sysfs is mount-namespace-dependent, not netns-dependent).
      const innerScript = `
CONTAINER_ID="${netns.containerID}"
PID=$(crictl inspect "$CONTAINER_ID" 2>/dev/null | jq -r ".info.pid")
if [ -z "$PID" ] || [ "$PID" = "null" ]; then
  echo "Error: cannot find PID for container $CONTAINER_ID" >&2
  exit 1
fi
echo '${b64}' | base64 -d > /tmp/_s${ext}
unshare --mount nsenter -t "$PID" -n -- sh -c 'mount -t sysfs none /sys 2>/dev/null; ${resolved.interpreter} /tmp/_s${ext}${scriptArgs}'
`.trim();

      const nsenterCmd = [
        "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p",
        "--", "sh", "-c", innerScript,
      ];

      const execResult = await runInDebugPod(
        { nodeName: netns.nodeName, command: nsenterCmd, image },
        env,
        { timeoutMs: timeout, signal },
      );

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted." }],
          details: { error: true },
        };
      }

      return formatExecOutput(execResult);
    },
  };
}
