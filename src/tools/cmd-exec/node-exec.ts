import type { ToolEntry, BackgroundExecWiring } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { KubeconfigRef } from "../../core/types.js";
import { renderTextResult } from "../infra/tool-render.js";
import { checkNodeReady } from "../infra/k8s-checks.js";
import { loadConfig } from "../../core/config.js";
import { BACKGROUND_BASH_ENABLED } from "../../core/subagent-registry.js";
import { CONTAINER_SENSITIVE_PATHS } from "../infra/command-sets.js";
import { preExecSecurity, postExecSecurity } from "../infra/security-pipeline.js";
import { backgroundNotLineSafeError, backgroundLaunchedResult } from "./background-launch.js";
import {
  validateNodeName,
  validatePodName,
  prepareExecEnv,
  filterPodNoise,
} from "../infra/exec-utils.js";
import { resolvePodNetnsViaKubectl, validateNetnsName } from "../infra/pod-netns-resolve.js";
import { runInDebugPod, ensureDebugPodReady, acquireDebugPod, releaseDebugPod } from "../infra/debug-pod.js";
import { backgroundPgidFile, wrapBackgroundSession, killRemoteSessionViaKubectl } from "../infra/bg-session.js";
import { resolveRequiredKubeconfig, resolveDebugImage } from "../infra/kubeconfig-resolver.js";
import { ensureClusterForTool } from "../infra/ensure-kubeconfigs.js";

// Re-export for backward compatibility (tests + downstream imports)
export { validateNodeName, validatePodName } from "../infra/exec-utils.js";
export { validateCommand } from "../infra/command-validator.js";

interface NodeExecParams {
  node?: string;
  command: string;
  netns?: string;
  pod?: string;
  namespace?: string;
  container?: string;
  cluster?: string;
  image?: string;
  timeout_seconds?: number;
  run_in_background?: boolean;
}

export function createNodeExecTool(
  kubeconfigRef?: KubeconfigRef,
  userId?: string,
  bg?: BackgroundExecWiring,
): ToolDefinition {
  // run_in_background is exposed only when the switch is on AND a runtime executor was
  // injected — otherwise the param stays out of the schema.
  const backgroundEnabled = BACKGROUND_BASH_ENABLED && Boolean(bg?.executor);
  return {
    name: "node_exec",
    label: "Node Exec",
    description: `Execute a single diagnostic command directly on a Kubernetes node. For multi-step scripts (pipes, loops, functions), use node_script instead.

PREFER host_exec when the node is reachable via SSH: check host_list (match by the node's IP or name) — if the node is a bound SSH host, use host_exec, which runs over SSH with NO debug pod (lighter, leaves the node untouched). Use node_exec when the node is NOT in host_list (it works on any cluster node without SSH credentials — its role as the fallback), or when you need pod-namespace access (e.g. a pod's netns) that only the debug pod provides.

Creates a privileged debug pod with nsenter to run the command in the host's full namespaces (mount, UTS, IPC, network, PID).
The pod is automatically cleaned up after execution (--rm).

Commands run on the HOST — they have access to the host's tools, filesystem, devices, /proc, /sys, and /dev.

Use this tool for host-level diagnostics that cannot be done from within a pod, such as:
- Inspecting host network interfaces, routes, and RDMA devices
- Running RDMA perftest tools (ib_write_bw, ib_read_bw, etc.) on the node
- Checking GPU status with nvidia-smi on the node
- Reading host kernel parameters (sysctl, dmesg, lsmod)
- Listing host hardware (lspci, lsblk, dmidecode)
- Checking network connectivity with curl

Allowed commands (ONLY these are permitted — do NOT use \`which\` to check, just run the command directly):
  network: ip, ifconfig, ping, traceroute, tracepath, ss, netstat, route, arp, ethtool, mtr, bridge, tc, conntrack, nslookup, dig, host, curl, tcpdump, nstat
  RDMA/RoCE: ibstat, ibstatus, ibv_devinfo, ibv_devices, rdma, ibaddr, iblinkinfo, ibportstate, show_gids, ibdev2netdev, saquery, ibping, perfquery (read-only; counter reset rejected), ibqueryerrors (read-only; counter clear rejected), mst (status/version), mlxlink (read-only link/FEC/eye diagnostics)
  perftest: ib_write_bw, ib_write_lat, ib_read_bw, ib_read_lat, ib_send_bw, ib_send_lat, ib_atomic_bw, ib_atomic_lat, raw_ethernet_bw, raw_ethernet_lat, raw_ethernet_burst_lat
  GPU: nvidia-smi, gpustat, nvtopo, dcgmi (discovery/topo/modules/nvlink/health/stats)
  hardware: lspci, lsusb, lsblk, lscpu, lsmem, lshw, dmidecode, smartctl (read-only; no self-test/set), nvme (read-only subcommands: list/smart-log/id-ctrl/error-log/…), sensors
  kernel: uname, hostname, uptime, dmesg, sysctl, lsmod, modinfo, getconf
  process: ps, pgrep, top, free, vmstat, iostat, mpstat, df, du, mount, findmnt, nproc, pidstat, pstree, numastat, ipcs
  file (read-only): cat, head, tail, ls, stat, file, wc, find, grep, diff, md5sum, sha256sum, tree, hexdump, od
  text processing: sort, uniq, cut, tr, jq, yq, column, tac, nl
  logs/services: journalctl, systemctl, timedatectl, hostnamectl
  container: crictl, ctr
  firewall (read-only): iptables, ip6tables
  general: date, whoami, id, env, printenv, which, readlink, echo

Pipes (|), && and ; are supported — each command in the pipeline must be in the whitelist.
Output redirection (> file), input redirection (< file), $() and backticks are blocked.
The following will be rejected: find with -exec/-delete, sysctl with -w, mount with actual mounting,
curl with -o/-O/-T (file output/upload) and all non-read HTTP methods (POST, PUT, DELETE, PATCH) and data flags (-d/--data), env with command arguments (only listing allowed),
systemctl with non-read-only subcommands, iptables with non-list operations.

perftest tuning flags are ALLOWED — you do not need a skill to parametrize a run. Common ones: -s/--size (msg size), -n/--iters, -a/--all (sweep all sizes), -D/--duration (run N seconds), -b/--bidirectional, -d/--ib-dev (e.g. mlx5_1), -x/--gid-index (e.g. 3 for RoCEv2), -m/--mtu, -c/--connection, -q/--qp, -F (skip CPU-freq warning), --report_gbits. Just pass them directly.

tcpdump is read-only LIVE capture to stdout (file-writing -w / post-rotate -z / file-read -r are rejected). For a bounded capture use -c <count>; for an open-ended capture start it with run_in_background and end it with job_stop.

Examples:
- node: "node-1", command: "ip addr show"
- node: "node-1", command: "ip addr show | grep 10.0.0"
- node: "node-1", command: "nvidia-smi"
- node: "node-1", command: "ibstat"
- node: "node-1", command: "ib_write_bw --help"
- node: "node-1", command: "tcpdump -i eth0 -nn -c 50 port 53"   (bounded capture: 50 DNS packets)
- node: "node-1", command: "tcpdump -i eth0 -nn", run_in_background: true   (open-ended capture; returns immediately — stop it later with job_stop, then task_output(task_id))
- paired capture/traffic — start the capture in the background, then IMMEDIATELY generate the traffic it should observe (do NOT wait for the capture first: it blocks until packets arrive, so waiting deadlocks):
    1. node: "node-1", command: "tcpdump -i eth0 -nn -c 5 port 80", run_in_background: true   (capture; returns immediately — go straight to step 2, same turn)
    2. node: "node-1", command: "curl -s http://10.0.0.1/healthz"                             (client; one request easily produces the few packets the capture is waiting for)
    3. once the capture hits its packet count it exits and you're notified — then call task_output(task_id).
- node: "node-1", command: "dmesg --level=err"
- node: "node-1", command: "sysctl net.ipv4.ip_forward"
- node: "node-1", command: "cat /etc/os-release"
- node: "node-1", command: "curl -s http://10.0.0.1:8080/healthz"
- node: "node-1", command: "ps aux | head -20"
- node: "node-1", command: "journalctl -u kubelet -n 100 | grep error"

To run in a POD's network namespace (host tools + the pod's network view — e.g. RDMA on a pod that lacks the tools), pass pod= directly (one step; the node is resolved for you):
- pod: "rdma-a", namespace: "rdma-test", command: "show_gids"
- pod: "rdma-a", namespace: "rdma-test", command: "ib_write_bw -d mlx5_1 -x 3 -D 20 -F", run_in_background: true
(Advanced: to reuse one resolution across many commands, pass node= + a pre-resolved netns=.)`,
    parameters: Type.Object({
      node: Type.Optional(Type.String({
        description: "Kubernetes node name to debug. Optional when `pod` is given (the node is resolved from the pod).",
      })),
      command: Type.String({
        description:
          'Diagnostic command to run on the node (e.g. "ip addr show", "nvidia-smi")',
      }),
      pod: Type.Optional(
        Type.String({
          description: "Target pod name. When set, the command runs inside THIS POD's network namespace using host tools (one step — the node + netns are resolved automatically). Use for RDMA/RoCE checks on a pod that lacks the tools (show_gids, ib_write_bw…).",
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
          description: 'Advanced: a pre-resolved network namespace name + `node`. Prefer `pod` for one step; use `netns` to reuse one resolution across many commands.',
        }),
      ),
      cluster: Type.Optional(
        Type.String({
          description: "Cluster name (from cluster_list). If omitted, uses the default cluster when only one is available.",
        })
      ),
      image: Type.Optional(
        Type.String({
          description: "Debug container image (default: SICLAW_DEBUG_IMAGE)",
        })
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 30, max: 120; ignored when run_in_background — see that param)",
        })
      ),
      ...(backgroundEnabled
        ? {
            run_in_background: Type.Optional(
              Type.Boolean({
                description:
                  "Run the command on the node in the background instead of waiting. Returns immediately " +
                  "with a task_id and output_file. After launching, END YOUR TURN by default (do NOT poll, " +
                  "sleep, or read its output until the completion notification — then call task_output(task_id), " +
                  "not the raw output_file). EXCEPTION: when this is the " +
                  "server/listener side of a paired test, do NOT wait — IMMEDIATELY run the client on the peer " +
                  "node, then call task_output(task_id) when the test finishes (waiting for the server's completion " +
                  "first deadlocks: it blocks until the client connects, then times out). Use for long-running " +
                  "node commands. The command is wrapped in `timeout` and capped at the debug-pod lifetime (~600s) — " +
                  "for longer runs lower the command's own duration. Output needing structural (JSON) redaction cannot run in background.",
              })
            ),
          }
        : {}),
    }),
    renderCall(args: any, theme: any) {
      const node = args?.node || "...";
      const cmd = args?.command || "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("node_exec")) +
          " " + theme.fg("accent", node) +
          " " + theme.fg("toolTitle", theme.bold("$")) +
          " " + cmd,
        0, 0,
      );
    },
    renderResult: renderTextResult,
    async execute(toolCallId, rawParams, signal) {
      const params = rawParams as NodeExecParams;

      try {
        await ensureClusterForTool(kubeconfigRef?.credentialBroker, params.cluster, "node_exec");
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

      // Pre-exec security: validate command + determine output sanitizer
      const pre = preExecSecurity(params.command, {
        context: "node",
        sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS,
        analyzeTarget: "last-in-pipeline",
      });
      if (pre.error) {
        return {
          content: [{ type: "text", text: pre.error }],
          details: { blocked: true, reason: "command_blocked" },
        };
      }

      const clusterKey = params.cluster || "default";
      const image = params.image || resolveDebugImage({ broker: kubeconfigRef?.credentialBroker }, params.cluster) || loadConfig().debugImage;

      // Resolve the target: the EFFECTIVE node to debug + an optional pod netns to enter.
      //  - netns given → advanced/reuse path: use node + that netns (node required).
      //  - pod given   → one step: resolve {node, netns} from the pod (verifies node Ready).
      //  - neither     → plain node command (node required).
      let nodeName = params.node?.trim() ?? "";
      let netns = "";
      if (params.netns?.trim()) {
        netns = params.netns.trim();
        const nsErr = validateNetnsName(netns);
        if (nsErr) return { content: [{ type: "text", text: `Error: ${nsErr}` }], details: { blocked: true, reason: "invalid_netns_name" } };
        if (!nodeName) return { content: [{ type: "text", text: "Error: netns requires node. Provide node, or use pod= for one-step resolution." }], details: { error: true } };
      } else if (params.pod?.trim()) {
        const podErr = validatePodName(params.pod.trim());
        if (podErr) return { content: [{ type: "text", text: `Error: ${podErr}` }], details: { blocked: true, reason: "invalid_pod_name" } };
        const resolved = await resolvePodNetnsViaKubectl({
          pod: params.pod.trim(), namespace: params.namespace?.trim() || "default", container: params.container,
          env, userId: userId ?? "unknown", clusterKey, image, signal,
        });
        if ("error" in resolved) return { content: [{ type: "text", text: `Error: ${resolved.error}` }], details: { error: true } };
        nodeName = resolved.node;
        netns = resolved.netns;
      } else if (!nodeName) {
        return { content: [{ type: "text", text: "Error: provide node, or pod (+namespace) to target a pod's network namespace." }], details: { error: true } };
      }

      // Validate node name + readiness (the pod path already verified the node via resolution).
      if (!params.pod?.trim()) {
        const nodeErr = validateNodeName(nodeName);
        if (nodeErr) {
          return { content: [{ type: "text", text: JSON.stringify({ error: nodeErr }, null, 2) }], details: { blocked: true, reason: "invalid_node_name" } };
        }
        const nodeCheckErr = await checkNodeReady(nodeName, env.childEnv, env.kubeconfigPath ?? undefined);
        if (nodeCheckErr) {
          return { content: [{ type: "text", text: JSON.stringify({ error: nodeCheckErr }, null, 2) }], details: { error: true } };
        }
      }
      const timeout = Math.min(params.timeout_seconds ?? 30, 120) * 1000;
      // Build the nsenter prefix for host-namespace execution. When netns is specified, wrap
      // with "ip netns exec <name>" to run in the pod's network namespace using host tools.
      // Both the foreground and background forms run the user command via `sh -c` so they can be
      // wrapped in setsid + `timeout` (a killable, time-bounded session — see bg-session.ts).
      const netnsPrefix = netns ? `ip netns exec ${netns} ` : "";
      const NSENTER = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--"];

      // ── Background mode ──────────────────────────────────────────────
      // Ensure+pin the debug pod, then hand a detached `kubectl exec … -- nsenter …` to
      // the runtime executor. The remote command runs as its own session leader via `setsid`
      // and records its session id to a node-side file, so job_stop can promptly reap the whole
      // session (kubectl exec does NOT propagate kill to a host-namespace process). `timeout <ttl>`
      // is the backstop if the job is never stopped. This uses the SAME killable-session helpers
      // (bg-session.ts) as the foreground path so there is one reap mechanism per transport.
      if (backgroundEnabled && params.run_in_background === true) {
        if (pre.action && !pre.action.lineSafe) {
          return backgroundNotLineSafeError();
        }
        const cfg = loadConfig();
        const ttl = Math.min(params.timeout_seconds ?? cfg.debugPodTTL, cfg.debugPodTTL);
        // The user command is interpolated single-quote-escaped (NOT via env — kubectl exec
        // does not forward the local process env to the remote command). preExecSecurity
        // already whitelisted it; the '\'' escaping makes it injection-safe regardless.
        const userShellEsc = (netnsPrefix + params.command).replace(/'/g, "'\\''");
        const pgidFile = backgroundPgidFile(toolCallId);
        const bgNsenterCmd = [...NSENTER, "sh", "-c", wrapBackgroundSession(`timeout ${ttl} sh -c '${userShellEsc}'`, pgidFile)];
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
        // Pin and capture the EXACT pod name we pinned — release by that name so pin/release
        // always target the same instance even if the cache entry is later replaced (and so
        // a stale release can't decrement a replacement pod). Robust regardless of any future
        // await between ensure and acquire.
        const pinnedPodName = acquireDebugPod(spec);
        if (!pinnedPodName) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: true, message: "Debug pod went away before the background job could pin it; try again." }) }],
            details: { error: true, reason: "debug_pod_gone" },
          };
        }
        // job_stop → reap the remote session (pkill -s, catching timeout's own child group) over
        // a FRESH kubectl exec; the kill script retries reading the .pgid to cover the launch race.
        const onAbort = () => killRemoteSessionViaKubectl({
          kubeconfigArgs: env.kubeconfigArgs,
          childEnv: env.childEnv as Record<string, string>,
          namespace: cachedPod!.namespace,
          podName: cachedPod!.podName,
          nsenterPrefix: NSENTER,
          pgidFile,
        });
        try {
          const { jobId, outputFile } = bg!.executor!({
            file: "kubectl",
            args: [...env.kubeconfigArgs, "-n", cachedPod.namespace, "exec", cachedPod.podName, "--", ...bgNsenterCmd],
            env: env.childEnv as Record<string, string>,
            action: pre.action,
            hasSensitiveKubectl: pre.hasSensitiveKubectl,
            description: `node ${nodeName}: ${params.command.length > 60 ? params.command.slice(0, 57) + "…" : params.command}`,
            parentSessionId: bg!.sessionIdRef?.current ?? "",
            jobId: toolCallId,
            isProd: process.env.NODE_ENV === "production",
            jobType: "node",
            onComplete: () => releaseDebugPod(spec, pinnedPodName),
            onAbort,
          });
          return backgroundLaunchedResult(jobId, outputFile, "Running on the node in the background.");
        } catch (err) {
          // Concurrency cap (or executor failure): release the pin, fall through to foreground.
          releaseDebugPod(spec, pinnedPodName);
          console.warn(`[node-exec] background launch declined, running foreground:`, err);
        }
      }

      // ── Foreground mode ──────────────────────────────────────────────
      // Run the host-namespace command as a killable session (setsid + recorded session id)
      // wrapped in `timeout <cap>`, exactly like the background path. On abort the LOCAL kubectl
      // is killed by runInDebugPod's signal, but that does NOT propagate to the host-namespace
      // process — so we ALSO reap the remote process group over a FRESH kubectl exec. The remote
      // `timeout` is the backstop if the reap is somehow missed (previously a foreground command
      // had no remote bound and orphaned on the node past the local wait).
      const cap = Math.min(params.timeout_seconds ?? 30, 120);
      const fgUserShellEsc = (netnsPrefix + params.command).replace(/'/g, "'\\''");
      const fgPgidFile = backgroundPgidFile(toolCallId);
      const fgNsenterCmd = [...NSENTER, "sh", "-c", wrapBackgroundSession(`timeout ${cap} sh -c '${fgUserShellEsc}'`, fgPgidFile)];
      const fgSpec = { userId: userId ?? "unknown", nodeName, command: fgNsenterCmd, image, clusterKey };

      // Ensure the (idempotent, cache-hit) pod up front, then PIN it for the duration of the exec.
      // runInDebugPod only resets the idle timer AFTER a successful exec, so without a pin a long
      // foreground command (cap up to 120s; idle timeout can be shorter) could be idle-evicted
      // mid-exec — killing the command AND leaving the abort reap to target a deleted pod. The pin
      // also guarantees fgPod stays the live pod the reap kubectl-execs into.
      let fgPod;
      try {
        fgPod = await ensureDebugPodReady(fgSpec, env, { signal });
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: true, message: `Debug pod failed to start: ${err?.message ?? String(err)}` }) }],
          details: { error: true, reason: "debug_pod_failed" },
        };
      }
      const fgPinnedPodName = acquireDebugPod(fgSpec); // null if the pod vanished; proceed best-effort
      const onAbort = () => killRemoteSessionViaKubectl({
        kubeconfigArgs: env.kubeconfigArgs,
        childEnv: env.childEnv as Record<string, string>,
        namespace: fgPod!.namespace,
        podName: fgPod!.podName,
        nsenterPrefix: NSENTER,
        pgidFile: fgPgidFile,
      });
      signal?.addEventListener("abort", onAbort, { once: true });

      let execResult;
      try {
        execResult = await runInDebugPod(fgSpec, env, { timeoutMs: timeout, signal });
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (fgPinnedPodName) releaseDebugPod(fgSpec, fgPinnedPodName);
      }

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted." }],
          details: { error: true },
        };
      }

      // Assemble output, then sanitize + truncate via unified facade
      const filteredStderr = filterPodNoise(execResult.stderr);
      const isError = execResult.exitCode !== 0 &&
        !(execResult.exitCode === null && execResult.stdout.trim());
      const out = execResult.stdout.trim();
      // Show the output as a shell would, with the exit code as a trailing annotation
      // (not a prefix that replaces the body), so a non-zero exit with no output —
      // e.g. `grep` with no match — reads as an empty result, not a failure.
      const stdout = isError
        ? `${out || "(no output)"}\n[exit code: ${execResult.exitCode ?? "unknown"}]`
        : out;
      return {
        content: [{ type: "text", text: postExecSecurity(stdout, pre.action, { stderr: filteredStderr || undefined }) }],
        details: { exitCode: execResult.exitCode ?? 0, ...(isError && { error: true }) },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "cmd-exec",
  create: (refs) =>
    createNodeExecTool(refs.kubeconfigRef, refs.userId, {
      executor: refs.backgroundExecExecutor,
      sessionIdRef: refs.sessionIdRef,
    }),
};
