import type { ToolEntry, BackgroundExecWiring } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../../core/types.js";
import { checkNodeReady } from "../infra/k8s-checks.js";
import { resolveScript } from "../infra/script-resolver.js";
import { renderTextResult } from "../infra/tool-render.js";
import { loadConfig } from "../../core/config.js";
import { BACKGROUND_BASH_ENABLED } from "../../core/subagent-registry.js";
import { backgroundLaunchedResult } from "../cmd-exec/background-launch.js";
import { parseArgs, shellEscape } from "../infra/command-sets.js";
import {
  validateNodeName,
  validatePodName,
  prepareExecEnv,
  filterPodNoise,
  stdinExecCmd,
} from "../infra/exec-utils.js";
import { resolvePodNetnsViaKubectl, validateNetnsName } from "../infra/pod-netns-resolve.js";
import { postExecSecurity } from "../infra/security-pipeline.js";
import { runInDebugPod, ensureDebugPodReady, acquireDebugPod, releaseDebugPod } from "../infra/debug-pod.js";
import { resolveRequiredKubeconfig, resolveDebugImage } from "../infra/kubeconfig-resolver.js";
import { ensureClusterForTool } from "../infra/ensure-kubeconfigs.js";

interface NodeScriptParams {
  node?: string;
  skill?: string;
  script: string;
  args?: string;
  netns?: string;
  pod?: string;
  namespace?: string;
  container?: string;
  cluster?: string;
  image?: string;
  timeout_seconds?: number;
  run_in_background?: boolean;
}

export function createNodeScriptTool(
  kubeconfigRef?: KubeconfigRef,
  userId?: string,
  bg?: BackgroundExecWiring,
): ToolDefinition {
  const backgroundEnabled = BACKGROUND_BASH_ENABLED && Boolean(bg?.executor);
  return {
    name: "node_script",
    label: "Node Script",
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("node_script")) +
          " " + theme.fg("accent", args?.node || "") +
          " " + theme.fg("muted", (args?.skill || "") + "/" + (args?.script || "")) +
          (args?.args ? " " + args.args : ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Execute a skill or user script on a Kubernetes node via a privileged debug pod with nsenter.

PREFER host_script when the node is reachable via SSH (check host_list by the node's IP or name): SSH runs the script with NO debug pod. Use node_script when the node is NOT a bound SSH host, or when the script needs pod-namespace access (e.g. a pod's netns) that only the debug pod provides.

The script runs in the host's full namespaces (mount, UTS, IPC, network, PID) — it has access to the host's tools, filesystem, devices, /proc, /sys, and /dev.

Use this for complex node-level diagnostics that need scripts (pipes, loops, functions), not just single commands.
For single commands, use node_exec instead.

Scripts must come from a skill's scripts/ directory or from user-uploaded scripts. Read the skill's SKILL.md first for the exact script name, arguments, and usage — don't guess the filename.

Parameters:
- node: Target Kubernetes node name (optional when pod= is given)
- pod: Target pod — run the script inside THIS pod's network namespace using host tools (one step; node resolved for you)
- namespace: Pod namespace (default "default"); only with pod
- skill: Skill name (e.g. "node-logs"). If omitted, looks in user scripts
- script: Script filename (e.g. "get-node-logs.sh")
- args: Optional arguments to pass to the script
- netns: Advanced — a pre-resolved netns (from resolve_pod_netns) + node, to reuse one resolution across many runs
- cluster: Cluster name (from cluster_list); omit to use the default cluster when only one is available
- image: Debug container image (default: SICLAW_DEBUG_IMAGE)
- timeout_seconds: Timeout (default: 180, max: 300)

Examples:
- node: "node-1", skill: "node-logs", script: "get-node-logs.sh", args: "--lines 100"
- node: "node-1", script: "my-check.sh"
- pod: "rdma-a", namespace: "rdma-test", skill: "gateway-diagnostics", script: "ping-gateway.sh", args: "--interface net1"   (one step into the pod's netns)`,
    parameters: Type.Object({
      node: Type.Optional(Type.String({ description: "Kubernetes node name. Optional when `pod` is given (the node is resolved from the pod)." })),
      skill: Type.Optional(
        Type.String({
          description: "Skill name (omit to use user scripts)",
        }),
      ),
      script: Type.String({ description: "Exact script filename from the skill's scripts/ directory, as listed in its SKILL.md. Use it verbatim — do not guess or modify the name." }),
      args: Type.Optional(
        Type.String({ description: "Arguments to pass to the script" }),
      ),
      pod: Type.Optional(
        Type.String({
          description: "Target pod name. When set, the script runs inside THIS POD's network namespace using host tools (one step — no resolve_pod_netns needed); the node is resolved automatically.",
        }),
      ),
      namespace: Type.Optional(
        Type.String({ description: 'Pod namespace (default: "default"). Only used with `pod`.' }),
      ),
      container: Type.Optional(
        Type.String({ description: "Container name (multi-container pods). Only used with `pod`." }),
      ),
      netns: Type.Optional(
        Type.String({
          description: 'Advanced: a pre-resolved network namespace name (from resolve_pod_netns) + `node`. Prefer `pod` for one step; use `netns` to reuse one resolution across many commands.',
        }),
      ),
      cluster: Type.Optional(
        Type.String({
          description: "Cluster name (from cluster_list). If omitted, uses the default cluster when only one is available.",
        }),
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
      ...(backgroundEnabled
        ? {
            run_in_background: Type.Optional(
              Type.Boolean({
                description:
                  "Run the script on the node in the background instead of waiting. Returns immediately with " +
                  "a task_id and output_file. IMPORTANT: after launching, END YOUR TURN — do NOT read the file " +
                  "or call any tool, and do NOT sleep/wait. You are notified automatically when it completes; " +
                  "ONLY THEN read the output_file. The script is wrapped in `timeout` and capped at the " +
                  "debug-pod lifetime (~600s). Use for long-running node skill scripts (orchestration, soak).",
              }),
            ),
          }
        : {}),
    }),
    async execute(toolCallId, rawParams, signal) {
      const params = rawParams as NodeScriptParams;

      try {
        await ensureClusterForTool(kubeconfigRef?.credentialBroker, params.cluster, "node_script");
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

      const clusterKey = params.cluster || "default";
      const image = params.image || resolveDebugImage({ broker: kubeconfigRef?.credentialBroker }, params.cluster) || loadConfig().debugImage;
      const timeout = Math.min(params.timeout_seconds ?? 180, 300) * 1000;
      const args = params.args?.trim() || "";
      // Security: shell-escape each argument to prevent injection via args parameter
      const escapedArgs = args ? parseArgs(args).map(shellEscape).join(" ") : "";

      // Resolve the target: effective node + optional pod netns. netns → advanced/reuse (needs
      // node); pod → one step (resolve {node, netns}); neither → plain node script.
      let nodeName = params.node?.trim() ?? "";
      let netns = "";
      if (params.netns?.trim()) {
        netns = params.netns.trim();
        const nsErr = validateNetnsName(netns);
        if (nsErr) return { content: [{ type: "text", text: `Error: ${nsErr}` }], details: { error: true } };
        if (!nodeName) return { content: [{ type: "text", text: "Error: netns requires node. Provide node, or use pod= for one-step resolution." }], details: { error: true } };
      } else if (params.pod?.trim()) {
        const podErr = validatePodName(params.pod.trim());
        if (podErr) return { content: [{ type: "text", text: `Error: ${podErr}` }], details: { error: true } };
        const r = await resolvePodNetnsViaKubectl({
          pod: params.pod.trim(), namespace: params.namespace?.trim() || "default", container: params.container,
          env, userId: userId ?? "unknown", clusterKey, image, signal,
        });
        if ("error" in r) return { content: [{ type: "text", text: `Error: ${r.error}` }], details: { error: true } };
        nodeName = r.node;
        netns = r.netns;
      } else if (!nodeName) {
        return { content: [{ type: "text", text: "Error: provide node, or pod (+namespace) to target a pod's network namespace." }], details: { error: true } };
      }

      // Validate node name + readiness (the pod path already verified the node via resolution).
      if (!params.pod?.trim()) {
        const nodeErr = validateNodeName(nodeName);
        if (nodeErr) return { content: [{ type: "text", text: `Error: ${nodeErr}` }], details: { error: true } };
        const nodeCheckErr = await checkNodeReady(nodeName, env.childEnv, env.kubeconfigPath ?? undefined);
        if (nodeCheckErr) return { content: [{ type: "text", text: `Error: ${nodeCheckErr}` }], details: { error: true } };
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

      // Build the command that runs inside nsenter — pipe script via stdin.
      // When netns is specified, wrap with "ip netns exec" for pod network namespace.
      const baseCmd = stdinExecCmd(resolved.interpreter, escapedArgs || undefined);
      const innerCmd = netns
        ? `ip netns exec ${netns} ${baseCmd}`
        : baseCmd;

      const NSENTER = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--"];
      const nsenterCmd = [...NSENTER, "sh", "-c", innerCmd];

      // ── Background mode ──────────────────────────────────────────────
      // Mirror node_exec's background path (ensure + pin a debug pod, record the remote PGID
      // so job_stop can kill the host-namespace group, `timeout` as the leak backstop) but
      // feed the SCRIPT via stdin: `sh -c launchScript` gets launchScript as its -c arg, so
      // stdin stays free for the inner `sh -s`/`python3 -` reading the piped script body.
      if (backgroundEnabled && params.run_in_background === true) {
        const cfg = loadConfig();
        const ttl = Math.min(params.timeout_seconds ?? cfg.debugPodTTL, cfg.debugPodTTL);
        const safeJob = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
        const pgidFile = `/tmp/siclaw-bg-${safeJob}-${randomBytes(4).toString("hex")}.pgid`;
        const launchScript = `echo $$ > ${pgidFile}; exec timeout ${ttl} ${innerCmd}`;
        const bgNsenterCmd = [...NSENTER, "setsid", "-w", "sh", "-c", launchScript];
        const spec = { userId: userId ?? "unknown", nodeName, command: bgNsenterCmd, image, clusterKey };
        let cachedPod;
        try {
          cachedPod = await ensureDebugPodReady(spec, env, { signal });
        } catch (err: any) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: true, message: `Debug pod failed to start: ${err?.message ?? String(err)}` }) }],
            details: { error: true, reason: "debug_pod_failed" },
          };
        }
        const pinnedPodName = acquireDebugPod(spec);
        if (!pinnedPodName) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: true, message: "Debug pod went away before the background job could pin it; try again." }) }],
            details: { error: true, reason: "debug_pod_gone" },
          };
        }
        const killScript = `pgid=""; for i in 1 2 3; do pgid=$(cat ${pgidFile} 2>/dev/null); [ -n "$pgid" ] && break; sleep 1; done; if [ -n "$pgid" ]; then kill -TERM -"$pgid" 2>/dev/null; sleep 1; kill -KILL -"$pgid" 2>/dev/null; fi; rm -f ${pgidFile}`;
        const onAbort = () => {
          try {
            const killer = spawn(
              "kubectl",
              [...env.kubeconfigArgs, "-n", cachedPod!.namespace, "exec", cachedPod!.podName, "--", ...NSENTER, "sh", "-c", killScript],
              { env: env.childEnv as Record<string, string>, detached: true },
            );
            killer.on("error", () => {});
            setTimeout(() => { try { killer.kill("SIGKILL"); } catch { /* gone */ } }, 15_000).unref();
            killer.unref();
          } catch { /* best-effort */ }
        };
        try {
          const { jobId, outputFile } = bg!.executor!({
            file: "kubectl",
            args: [...env.kubeconfigArgs, "-n", cachedPod.namespace, "exec", "-i", cachedPod.podName, "--", ...bgNsenterCmd],
            stdin: resolved.content,
            env: env.childEnv as Record<string, string>,
            action: null,
            hasSensitiveKubectl: false,
            description: `node ${nodeName}: ${[params.skill, params.script].filter(Boolean).join("/")}`,
            parentSessionId: bg!.sessionIdRef?.current ?? "",
            jobId: toolCallId,
            isProd: process.env.NODE_ENV === "production",
            jobType: "node",
            onComplete: () => releaseDebugPod(spec, pinnedPodName),
            onAbort,
          });
          return backgroundLaunchedResult(jobId, outputFile, "Running the script on the node in the background.");
        } catch (err) {
          releaseDebugPod(spec, pinnedPodName);
          console.warn(`[node-script] background launch declined, running foreground:`, err);
        }
      }

      const execResult = await runInDebugPod(
        { userId: userId ?? "unknown", nodeName, command: nsenterCmd, image, clusterKey, stdinData: resolved.content },
        env,
        { timeoutMs: timeout, signal },
      );

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted." }],
          details: { error: true },
        };
      }

      const filteredStderr = filterPodNoise(execResult.stderr);
      const isError = execResult.exitCode !== 0 &&
        !(execResult.exitCode === null && execResult.stdout.trim());
      const out = execResult.stdout.trim();
      const stdout = isError
        ? `${out || "(no output)"}\n[exit code: ${execResult.exitCode ?? "unknown"}]`
        : out;
      return {
        content: [{ type: "text", text: postExecSecurity(stdout, null, { stderr: filteredStderr || undefined }) }],
        details: { exitCode: execResult.exitCode ?? 0, ...(isError && { error: true }) },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "script-exec",
  create: (refs) =>
    createNodeScriptTool(refs.kubeconfigRef, refs.userId, {
      executor: refs.backgroundExecExecutor,
      sessionIdRef: refs.sessionIdRef,
    }),
};
