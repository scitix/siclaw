import type { ToolEntry, BackgroundExecWiring } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../../core/types.js";
import { resolveScript } from "../infra/script-resolver.js";
import { renderTextResult } from "../infra/tool-render.js";
import { postExecSecurity } from "../infra/security-pipeline.js";
import { BACKGROUND_BASH_ENABLED } from "../../core/subagent-registry.js";
import { backgroundLaunchedResult } from "../cmd-exec/background-launch.js";
import { parseArgs, shellEscape } from "../infra/command-sets.js";
import { validateNodeName, validatePodName, stdinExecCmd } from "../infra/exec-utils.js";
import { resolvePodNetnsViaSsh } from "../infra/pod-netns-resolve.js";
import { acquireSshTarget, sshExec, sshExecStream } from "../infra/ssh-client.js";
import { backgroundPgidFile, wrapBackgroundSession, backgroundSessionKillScript } from "../infra/bg-session.js";

interface HostScriptParams {
  host: string;
  skill?: string;
  script: string;
  args?: string;
  pod?: string;
  namespace?: string;
  container?: string;
  timeout_seconds?: number;
  run_in_background?: boolean;
}

// Background ssh leak-guard ttl (s): the script is `timeout`-wrapped so a dropped channel
// can't orphan it. Generous vs the foreground cap; matches host_exec.
const HOST_BG_DEFAULT_TTL = 600;
const HOST_BG_MAX_TTL = 3600;

/**
 * host_script — run a skill or user script on a non-K8s host via SSH.
 *
 * The script is piped via stdin into the remote sh (or python3 for .py
 * scripts), so the target host only needs sh and optionally python3 — no
 * file transfer needed.
 *
 * Mirrors node_script's contract but talks SSH instead of kubectl exec into
 * a debug pod. The script body itself is NOT subject to preExecSecurity (same
 * as node_script — scripts are trusted assets); but `args` are shell-escaped
 * to prevent injection.
 */
export function createHostScriptTool(
  kubeconfigRef?: KubeconfigRef,
  bg?: BackgroundExecWiring,
): ToolDefinition {
  const backgroundEnabled = BACKGROUND_BASH_ENABLED && Boolean(bg?.executor);
  return {
    name: "host_script",
    label: "Host Script",
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("host_script")) +
          " " + theme.fg("accent", args?.host || "") +
          " " + theme.fg("muted", (args?.skill || "") + "/" + (args?.script || "")) +
          (args?.args ? " " + args.args : ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Execute a skill or user script on a host via SSH — incl. Kubernetes nodes registered as SSH hosts (they appear in host_list).

PREFER this over node_script for node-level diagnostics whenever the target is SSH-reachable: SSH runs the script with NO privileged debug pod (cleaner, lighter). node_script is the fallback for nodes not bound as SSH hosts, and for pod-namespace (netns) work. On connection failure (can't connect / auth / timeout / host not bound — not a non-zero script exit) and the target is a Kubernetes node, retry with node_script.

The script is piped via stdin into the remote shell — no file transfer needed.
Scripts must come from a skill's scripts/ directory or from user-uploaded scripts. Read the skill's SKILL.md first for the exact script name, arguments, and usage — don't guess the filename.

For complex host diagnostics that need scripts (pipes, loops, functions), not just single commands. For single commands, use host_exec.

Parameters:
- host: Host id from host_list (preferred — names can be duplicated, so the id is the unambiguous handle; a unique name also works). Must be bound to this agent.
- skill: Skill name. If omitted, looks in user scripts.
- script: Script filename (e.g. "collect-system-logs.sh").
- args: Optional arguments to pass to the script.
- timeout_seconds: Timeout (default: 180, max: 300)

Examples (pass the id from host_list; names shown here for readability):
- host: "<bare-metal-3 id>", skill: "node-logs", script: "collect-system-logs.sh", args: "--lines 200"
- host: "<jump-1 id>", script: "my-check.sh"`,
    parameters: Type.Object({
      host: Type.String({
        description: "Host id from host_list (preferred — names can be duplicated, so the id is the unambiguous handle; a unique name also works). Must be bound to this agent.",
      }),
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
          description: "Target pod name. When set, the script runs inside THIS POD's network namespace (on this host/node) using host tools — RDMA/RoCE on a pod that lacks the tools. The host must be the K8s node running the pod, and its SSH credential must be root (crictl + `ip netns exec` need CAP_SYS_ADMIN).",
        }),
      ),
      namespace: Type.Optional(
        Type.String({ description: 'Pod namespace (default: "default"). Only used with `pod`.' }),
      ),
      container: Type.Optional(
        Type.String({ description: "Container name (multi-container pods). Only used with `pod`." }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 180, max: 300; in background: default 600, max 3600)",
        }),
      ),
      ...(backgroundEnabled
        ? {
            run_in_background: Type.Optional(
              Type.Boolean({
                description:
                  "Run the script on the host in the background instead of waiting. Returns immediately " +
                  "with a task_id and output_file. IMPORTANT: after launching, END YOUR TURN — do NOT read " +
                  "the file or call any tool, and do NOT sleep/wait. You are notified automatically when it " +
                  "completes; ONLY THEN read the output_file. Use for long-running skill scripts over SSH " +
                  "(orchestration, soak, perftest). The script is wrapped in `timeout` and capped (~3600s).",
              }),
            ),
          }
        : {}),
    }),
    async execute(toolCallId, rawParams, signal) {
      const params = rawParams as HostScriptParams;

      const hostErr = validateNodeName(params.host);
      if (hostErr) {
        return {
          content: [{ type: "text", text: `Error: ${hostErr}` }],
          details: { error: true, reason: "invalid_host_name" },
        };
      }

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

      let target;
      try {
        target = await acquireSshTarget(kubeconfigRef?.credentialBroker, params.host, "host_script");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}\n\nCould not reach "${params.host}" over SSH (not bound / no credential — not a script error). If "${params.host}" is a Kubernetes node, retry this script with node_script (debug pod, no SSH).` }],
          details: { error: true, reason: "host_acquire_failed" },
        };
      }

      const args = params.args?.trim() || "";
      const escapedArgs = args ? parseArgs(args).map(shellEscape).join(" ") : "";
      let remoteCmd = stdinExecCmd(resolved.interpreter, escapedArgs || undefined);

      // One-step pod netns: resolve the pod's netns over SSH (crictl on this node; needs root),
      // then run the interpreter inside it (`ip netns exec <netns> bash -s …`); the script body
      // still flows in via stdin. Prefix is tool-built; netns name comes from crictl (validated).
      if (params.pod?.trim()) {
        const podErr = validatePodName(params.pod.trim());
        if (podErr) {
          return { content: [{ type: "text", text: `Error: ${podErr}` }], details: { error: true, reason: "invalid_pod_name" } };
        }
        const r = await resolvePodNetnsViaSsh({
          target, pod: params.pod.trim(), namespace: params.namespace?.trim() || "default", container: params.container, signal,
        });
        if ("error" in r) {
          return { content: [{ type: "text", text: `Error: ${r.error}` }], details: { error: true, reason: "netns_resolve_failed" } };
        }
        remoteCmd = `ip netns exec ${r.netns} ${remoteCmd}`;
      }

      // ── Background mode ──────────────────────────────────────────────
      // Pipe the script via stdin to a `setsid`-wrapped, `timeout <ttl>`-bounded remote shell,
      // stream output to disk. setsid makes the remote command its own process-group leader and
      // records its PGID so job_stop can kill the WHOLE remote tree over a fresh ssh channel
      // (closing the streaming channel does NOT reliably SIGHUP a non-PTY remote process).
      // Mirrors node_script. Script bodies aren't sanitized (trusted assets) → action null.
      if (backgroundEnabled && params.run_in_background === true) {
        const ttl = Math.min(params.timeout_seconds ?? HOST_BG_DEFAULT_TTL, HOST_BG_MAX_TTL);
        // Run as a killable session so job_stop reaps the whole remote tree (incl. timeout's own
        // process group); the script body on stdin flows through to `timeout … bash -s`/`python3 -`.
        const pgidFile = backgroundPgidFile(toolCallId);
        const wrapped = wrapBackgroundSession(`timeout ${ttl} ${remoteCmd}`, pgidFile);
        const killScript = backgroundSessionKillScript(pgidFile);
        const onAbort = () => { void sshExec(target, killScript, { timeoutMs: 20_000 }).catch(() => {}); };
        try {
          const { jobId, outputFile } = bg!.executor!({
            streamFactory: () => sshExecStream(target, wrapped, { stdin: resolved.content }),
            env: {},
            action: null,
            hasSensitiveKubectl: false,
            description: `host ${params.host}: ${[params.skill, params.script].filter(Boolean).join("/")}`,
            parentSessionId: bg!.sessionIdRef?.current ?? "",
            jobId: toolCallId,
            isProd: false,
            jobType: "host",
            onAbort,
          });
          return backgroundLaunchedResult(jobId, outputFile, "Running on the host in the background.");
        } catch (err) {
          console.warn(`[host-script] background launch declined, running foreground:`, err);
        }
      }

      const timeout = Math.min(params.timeout_seconds ?? 180, 300) * 1000;

      let result;
      try {
        result = await sshExec(target, remoteCmd, {
          timeoutMs: timeout,
          signal,
          stdin: resolved.content,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}\n\nSSH connection to "${params.host}" failed (a connection failure, not a script error). If "${params.host}" is a Kubernetes node, retry this script with node_script (debug pod, no SSH).` }],
          details: { error: true, reason: "ssh_exec_failed", host: params.host },
        };
      }

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted." }],
          details: { error: true },
        };
      }

      const isError = result.exitCode !== 0 &&
        !(result.exitCode === null && result.stdout.trim());
      const stdoutHeader = isError
        ? `Exit code: ${result.exitCode ?? "unknown"}${result.signal ? ` (signal: ${result.signal})` : ""}\n`
        : "";
      const truncatedSuffix = result.truncated ? "\n...[output truncated at 10 MB]" : "";
      const stdout = stdoutHeader + result.stdout.trim() + truncatedSuffix;

      return {
        content: [{
          type: "text",
          text: postExecSecurity(stdout, null, { stderr: result.stderr.trim() || undefined }),
        }],
        details: {
          exitCode: result.exitCode,
          host: params.host,
          ...(isError && { error: true }),
          ...(result.signal ? { signal: result.signal } : {}),
        },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "script-exec",
  create: (refs) =>
    createHostScriptTool(refs.kubeconfigRef, {
      executor: refs.backgroundExecExecutor,
      sessionIdRef: refs.sessionIdRef,
    }),
};
