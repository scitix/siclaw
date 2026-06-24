import type { ToolEntry, BackgroundExecWiring } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { KubeconfigRef } from "../../core/types.js";
import { renderTextResult } from "../infra/tool-render.js";
import { CONTAINER_SENSITIVE_PATHS } from "../infra/command-sets.js";
import { backgroundPgidFile, wrapBackgroundSession, killRemoteSessionViaSsh } from "../infra/bg-session.js";
import { preExecSecurity, postExecSecurity } from "../infra/security-pipeline.js";
import { BACKGROUND_BASH_ENABLED } from "../../core/subagent-registry.js";
import { backgroundNotLineSafeError, backgroundLaunchedResult } from "./background-launch.js";
import { validateNodeName, validatePodName } from "../infra/exec-utils.js";
import { resolvePodNetnsViaSsh } from "../infra/pod-netns-resolve.js";
import { acquireSshTarget, sshExec, sshExecStream } from "../infra/ssh-client.js";

interface HostExecParams {
  host: string;
  command: string;
  pod?: string;
  namespace?: string;
  container?: string;
  timeout_seconds?: number;
  run_in_background?: boolean;
}

// Background ssh: default leak-guard ttl and cap (s). A dropped channel can't orphan the
// remote process — `timeout <ttl>` bounds it. Generous vs node/pod (no debug-pod lifetime).
const HOST_BG_DEFAULT_TTL = 600;
const HOST_BG_MAX_TTL = 3600;

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
export function createHostExecTool(
  kubeconfigRef?: KubeconfigRef,
  bg?: BackgroundExecWiring,
): ToolDefinition {
  // run_in_background is exposed only when the switch is on AND a runtime executor was
  // injected — otherwise the param stays out of the schema.
  const backgroundEnabled = BACKGROUND_BASH_ENABLED && Boolean(bg?.executor);
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
- host: "<node-a id>", command: "journalctl -u kubelet -n 100 | grep error"
- host: "<node-a id>", command: "tcpdump -i eth0 -nn", run_in_background: true   (open-ended capture; returns immediately — stop it later with job_stop, then task_output(task_id))`,
    parameters: Type.Object({
      host: Type.String({
        description: "Host id from host_list (preferred — names can be duplicated, so the id is the unambiguous handle; a unique name also works). Must be bound to this agent.",
      }),
      command: Type.String({
        description: 'Diagnostic command to run on the host (e.g. "uptime", "ip addr show")',
      }),
      pod: Type.Optional(
        Type.String({
          description: "Target pod name. When set, the command runs inside THIS POD's network namespace (on this host/node) using host tools — for RDMA/RoCE checks on a pod that lacks the tools (show_gids, ib_write_bw…). The host must be the K8s node running the pod, and its SSH credential must be root (crictl + `ip netns exec` need CAP_SYS_ADMIN).",
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
          description: "Timeout in seconds (default: 30, max: 120; in background: default 600, max 3600)",
        })
      ),
      ...(backgroundEnabled
        ? {
            run_in_background: Type.Optional(
              Type.Boolean({
                description:
                  "Run the command on the host in the background instead of waiting. Returns immediately " +
                  "with a task_id and output_file. After launching, END YOUR TURN by default (do NOT poll, " +
                  "sleep, or read its output until the completion notification — then call task_output(task_id), " +
                  "not the raw output_file). EXCEPTION: when this is the " +
                  "server/listener side of a paired test, do NOT wait — IMMEDIATELY run the client on the peer " +
                  "host, then call task_output(task_id) when the test finishes (waiting for the server's completion " +
                  "first deadlocks: it blocks until the client connects, then times out). Use for long-running " +
                  "host commands over SSH. The command is wrapped in `timeout` and capped (~3600s). Output needing " +
                  "structural (JSON) redaction cannot run in background.",
              })
            ),
          }
        : {}),
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
    async execute(toolCallId, rawParams, signal) {
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
      // The model often passes an opaque host id; surface the resolved friendly name so the tool
      // card can render `<name> $ <command>` like node_exec instead of a bare UUID. Persisted via
      // the result details → tool row metadata (foreground details + background extraDetails).
      const hostLabel = target.name || params.host;

      // One-step pod netns: resolve the pod's netns over SSH (crictl on this node; needs root),
      // then run the command inside it via `ip netns exec`. The prefix is tool-built — only the
      // inner command (params.command) went through preExecSecurity above. Whole command runs in
      // the netns (`ip netns exec <netns> sh -c '<cmd>'`) so a pipeline can't straddle namespaces.
      let netnsExec = "";
      if (params.pod?.trim()) {
        const podErr = validatePodName(params.pod.trim());
        if (podErr) {
          return { content: [{ type: "text", text: `Error: ${podErr}` }], details: { blocked: true, reason: "invalid_pod_name" } };
        }
        const r = await resolvePodNetnsViaSsh({
          target, pod: params.pod.trim(), namespace: params.namespace?.trim() || "default", container: params.container, signal,
        });
        if ("error" in r) {
          return { content: [{ type: "text", text: `Error: ${r.error}` }], details: { error: true, reason: "netns_resolve_failed" } };
        }
        netnsExec = `ip netns exec ${r.netns} `;
      }
      const esc = params.command.replace(/'/g, "'\\''");

      // ── Background mode ──────────────────────────────────────────────
      // No child process: hand the executor an ssh2 stream factory. The remote command runs
      // under `setsid` (own process-group leader) wrapped in `timeout <ttl>`, and records its
      // PGID to a pidfile so job_stop can kill the WHOLE remote tree over a fresh ssh channel —
      // closing the streaming channel does NOT reliably SIGHUP a non-PTY remote process, so a
      // "stopped" perftest would otherwise keep running to ttl. Mirrors node_exec/node_script.
      // Validation already ran above; only line-safe sanitizers stream per-line.
      if (backgroundEnabled && params.run_in_background === true) {
        if (pre.action && !pre.action.lineSafe) {
          return backgroundNotLineSafeError();
        }
        const ttl = Math.min(params.timeout_seconds ?? HOST_BG_DEFAULT_TTL, HOST_BG_MAX_TTL);
        const userCmd = `timeout ${ttl} ${netnsExec}sh -c '${esc}'`;
        // Run as a killable session (setsid + recorded session id) so job_stop reaps the whole
        // remote tree incl. timeout's own process group. See bg-session.ts for the rationale.
        const pgidFile = backgroundPgidFile(toolCallId);
        const wrapped = wrapBackgroundSession(userCmd, pgidFile);
        // job_stop: kill the remote process group over a FRESH ssh connection (the streaming
        // channel is being torn down). Best-effort, time-boxed; the runner closes the channel after.
        const onAbort = () => killRemoteSessionViaSsh({ target, pgidFile });
        try {
          const { jobId, outputFile } = bg!.executor!({
            // The job outlives this turn, so it is NOT tied to the turn's AbortSignal —
            // job_stop drives the abort via the JobRegistry → onAbort + handle.abort.
            streamFactory: () => sshExecStream(target, wrapped, {}),
            env: {},
            action: pre.action,
            hasSensitiveKubectl: pre.hasSensitiveKubectl,
            description: `host ${params.host}: ${params.command.length > 60 ? params.command.slice(0, 57) + "…" : params.command}`,
            parentSessionId: bg!.sessionIdRef?.current ?? "",
            jobId: toolCallId,
            isProd: false,
            jobType: "host",
            onAbort,
          });
          return backgroundLaunchedResult(jobId, outputFile, "Running on the host in the background.", { host_label: hostLabel });
        } catch (err) {
          // Concurrency cap (or executor failure): fall through to a foreground run.
          console.warn(`[host-exec] background launch declined, running foreground:`, err);
        }
      }

      // ── Foreground mode ──────────────────────────────────────────────
      // Run as a killable session (setsid + recorded session id) wrapped in `timeout <cap>`, just
      // like the background path. On abort the local ssh channel is torn down, but closing it does
      // NOT reliably SIGHUP a non-PTY remote process — so we ALSO reap the remote process group
      // over a FRESH ssh connection, and the remote `timeout` is the backstop. Previously a
      // foreground command had no remote bound and could keep running on the host past the local wait.
      // This requires `setsid` + `timeout` on the host — the SAME dependency the background path
      // already takes for every host command (util-linux + coreutils, present on any normal SSH
      // target incl. BusyBox); a host missing them errors visibly rather than orphaning silently.
      // setsid is invoked WITHOUT `-w` (see wrapBackgroundSession) so it works on older util-linux
      // (e.g. CentOS 7's 2.23.2) and BusyBox, which don't support the `-w`/`--wait` flag.
      const cap = Math.min(params.timeout_seconds ?? 30, 120);
      const timeout = cap * 1000;
      const fgPgidFile = backgroundPgidFile(toolCallId);
      const fgWrapped = wrapBackgroundSession(`timeout ${cap} ${netnsExec}sh -c '${esc}'`, fgPgidFile);
      const onAbort = () => killRemoteSessionViaSsh({ target, pgidFile: fgPgidFile });
      signal?.addEventListener("abort", onAbort, { once: true });

      let result;
      try {
        result = await sshExec(target, fgWrapped, { timeoutMs: timeout, signal });
      } catch (err) {
        // The SSH path REJECTS with Error("Aborted") when the signal fires — surface a clean stop
        // here (the post-try abort check below is unreachable on the reject path), not a spurious
        // "ssh_exec_failed" connection error.
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Aborted." }], details: { error: true } };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}\n\nSSH connection to "${params.host}" failed (a connection failure, not a command error). If "${params.host}" is a Kubernetes node, retry this command with node_exec (debug pod, no SSH).` }],
          details: { error: true, reason: "ssh_exec_failed", host: params.host },
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
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
          host_label: hostLabel,
          ...(isError && { error: true }),
          ...(result.signal ? { signal: result.signal } : {}),
        },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "cmd-exec",
  create: (refs) =>
    createHostExecTool(refs.kubeconfigRef, {
      executor: refs.backgroundExecExecutor,
      sessionIdRef: refs.sessionIdRef,
    }),
};
