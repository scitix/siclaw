import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../../core/types.js";
import { resolveScript } from "../infra/script-resolver.js";
import { renderTextResult } from "../infra/tool-render.js";
import { postExecSecurity } from "../infra/security-pipeline.js";
import { parseArgs, shellEscape } from "../infra/command-sets.js";
import { validateNodeName, stdinExecCmd } from "../infra/exec-utils.js";
import { acquireSshTarget, sshExec } from "../infra/ssh-client.js";

interface HostScriptParams {
  host: string;
  skill?: string;
  script: string;
  args?: string;
  timeout_seconds?: number;
}

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
export function createHostScriptTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
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
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 180, max: 300)",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams, signal) {
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
      const remoteCmd = stdinExecCmd(resolved.interpreter, escapedArgs || undefined);
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
  create: (refs) => createHostScriptTool(refs.kubeconfigRef),
};
