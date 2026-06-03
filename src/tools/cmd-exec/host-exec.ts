import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { KubeconfigRef } from "../../core/types.js";
import { renderTextResult } from "../infra/tool-render.js";
import { CONTAINER_SENSITIVE_PATHS } from "../infra/command-sets.js";
import { preExecSecurity, postExecSecurity } from "../infra/security-pipeline.js";
import { validateNodeName } from "../infra/exec-utils.js";
import { acquireSshTarget, sshExec } from "../infra/ssh-client.js";

interface HostExecParams {
  host: string;
  command: string;
  timeout_seconds?: number;
}

/**
 * host_exec — run a single shell command on a non-K8s host via SSH.
 *
 * Uses the same security pipeline as node_exec / pod_exec (preExecSecurity +
 * postExecSecurity) but with context: "host". Credentials are acquired from
 * the agent-bound CredentialBroker — LLMs cannot supply arbitrary IPs or keys.
 *
 * To prevent the LLM from assembling its own ssh command via restricted-bash,
 * the COMMANDS registry has no ssh / scp / sftp / sshpass entries — those are
 * blocked at the local context whitelist (DESIGN risk #1).
 */
export function createHostExecTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
  return {
    name: "host_exec",
    label: "Host Exec",
    description: `Execute a single diagnostic command on a host via SSH — bare-metal nodes, jump
hosts, storage nodes, AND Kubernetes nodes registered as SSH hosts (they appear
in host_list).

PREFER this over node_exec for node-level diagnostics whenever the target is
SSH-reachable: SSH runs the command directly with NO privileged debug pod on the
node — cleaner and lighter. The allowed-command whitelist is identical to
node_exec's (network, RDMA, GPU, hardware, kernel, process, file read-only, text
processing, logs/services, container, firewall read-only, general), so you lose
no capability. node_exec is the fallback for nodes not bound as SSH hosts, and
for pod-namespace (netns) work.

ON CONNECTION FAILURE — SSH can't connect / auth fails / timeout / jump host
unreachable / the host isn't bound (NOT a non-zero command exit) — if the target
is a Kubernetes node, retry the same command with node_exec (debug pod, no SSH).

Pipes (|), && and ; supported. Output redirection, input redirection, $() and
backticks are blocked.

The host parameter is the host's \`id\` from host_list — prefer the id, since host
names can be duplicated (a duplicate name fails at execution); a unique name also
works. IPs and arbitrary strings are rejected. SSH credentials are looked up via
the broker; you cannot supply a key path. Hosts behind a bastion (host_list shows
a "jump_host") are reached automatically through the configured ProxyJump chain —
just target the final host by its host_list id.

Examples (pass the id from host_list; names shown here for readability):
- host: "<jump-1 id>", command: "uptime"
- host: "<bare-metal-3 id>", command: "nvidia-smi"
- host: "<storage-1 id>", command: "df -h"
- host: "<node-a id>", command: "journalctl -u kubelet -n 100 | grep error"`,
    parameters: Type.Object({
      host: Type.String({
        description: "Host id from host_list (preferred — names can be duplicated, so the id is the unambiguous handle; a unique name also works). Must be bound to this agent.",
      }),
      command: Type.String({
        description: 'Diagnostic command to run on the host (e.g. "uptime", "ip addr show")',
      }),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 30, max: 120)",
        })
      ),
    }),
    renderCall(args: any, theme: any) {
      const host = args?.host || "...";
      const cmd = args?.command || "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("host_exec")) +
          " " + theme.fg("accent", host) +
          " " + theme.fg("toolTitle", theme.bold("$")) +
          " " + cmd,
        0, 0,
      );
    },
    renderResult: renderTextResult,
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as HostExecParams;

      // Validate host name format (reuse node naming rules — RFC 1123)
      const hostErr = validateNodeName(params.host);
      if (hostErr) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: hostErr }, null, 2) }],
          details: { blocked: true, reason: "invalid_host_name" },
        };
      }

      // Pre-exec security: validate command + pick output sanitizer
      const pre = preExecSecurity(params.command, {
        context: "host",
        sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS,
        analyzeTarget: "last-in-pipeline",
      });
      if (pre.error) {
        return {
          content: [{ type: "text", text: pre.error }],
          details: { blocked: true, reason: "command_blocked" },
        };
      }

      // Acquire SSH target from broker (ensureHost + getHostLocalInfo + assemble)
      let target;
      try {
        target = await acquireSshTarget(kubeconfigRef?.credentialBroker, params.host, "host_exec");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}\n\nCould not reach "${params.host}" over SSH (not bound / no credential — not a command error). If "${params.host}" is a Kubernetes node, retry this command with node_exec (debug pod, no SSH).` }],
          details: { error: true, reason: "host_acquire_failed" },
        };
      }

      const timeout = Math.min(params.timeout_seconds ?? 30, 120) * 1000;

      let result;
      try {
        result = await sshExec(target, params.command, { timeoutMs: timeout, signal });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}\n\nSSH connection to "${params.host}" failed (a connection failure, not a command error). If "${params.host}" is a Kubernetes node, retry this command with node_exec (debug pod, no SSH).` }],
          details: { error: true, reason: "ssh_exec_failed", host: params.host },
        };
      }

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted." }],
          details: { error: true },
        };
      }

      // Mirror node_exec's error judgment: signal-killed with stdout = OK; otherwise non-zero exit = error.
      const isError = result.exitCode !== 0 &&
        !(result.exitCode === null && result.stdout.trim());
      const stdoutHeader = isError
        ? `Exit code: ${result.exitCode ?? "unknown"}${result.signal ? ` (signal: ${result.signal})` : ""}\n`
        : "";
      const stdoutBody = result.stdout.trim();
      const truncatedSuffix = result.truncated ? "\n...[output truncated at 10 MB]" : "";
      const stdout = stdoutHeader + stdoutBody + truncatedSuffix;

      return {
        content: [{
          type: "text",
          text: postExecSecurity(stdout, pre.action, { stderr: result.stderr.trim() || undefined }),
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
  category: "cmd-exec",
  create: (refs) => createHostExecTool(refs.kubeconfigRef),
};
