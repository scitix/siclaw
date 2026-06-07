/**
 * Shared resolution of a Kubernetes pod → its network-namespace name, used by both transports:
 *   - kubectl: a privileged debug pod on the node runs `nsenter -t 1 … crictl …`.
 *   - ssh: the command runs directly on the node (SSH already lands in the host namespaces),
 *     so NO `nsenter` is needed — just the crictl script.
 *
 * The netns is a pod-level concept (shared by all containers in the pod), resolved at the pod
 * sandbox level via crictl. The runtime already creates /var/run/netns/<name>, so the returned
 * basename works directly with `ip netns exec <name>`.
 *
 * This powers the one-step `pod=` parameter on node_exec/node_script (kubectl) and
 * host_exec/host_script (ssh): the tool resolves the netns internally, then runs the user's
 * command inside it with host tools — `node_exec(pod, …)` / `host_exec(host, pod, …)`.
 */

import { resolveContainerNetns, validatePodName, validateNamespace, validateContainerName, type ExecEnv } from "./exec-utils.js";
import { runInDebugPod } from "./debug-pod.js";
import { sshExec, type SshTarget } from "./ssh-client.js";

/** netns names must be a single safe token — they get embedded in `ip netns exec <netns>`. */
const NETNS_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Returns an error message if the netns name is unsafe, else null. */
export function validateNetnsName(netns: string): string | null {
  if (!NETNS_RE.test(netns)) {
    return `invalid netns name "${netns}". Must be alphanumeric, dashes, underscores (max 64 chars).`;
  }
  return null;
}

/**
 * Validate the pod/namespace/container target. SECURITY-CRITICAL: `pod` and `namespace` are
 * interpolated into a shell command in buildCrictlNetnsScript (run as root on the node, in the
 * host namespaces), so they MUST be validated to RFC-1123 (no shell metacharacters) here — the
 * single choke point every resolver passes through, so no caller can skip it. Returns an error
 * message, or null when safe.
 */
function validatePodTarget(pod: string, namespace: string, container?: string): string | null {
  return validatePodName(pod)
    ?? validateNamespace(namespace)
    ?? (container ? validateContainerName(container) : null);
}

/**
 * Shell snippet that prints the pod sandbox's network-namespace basename to stdout (or an error
 * to stderr + non-zero exit). `pod`/`namespace` MUST already be RFC-1123 validated (via
 * validatePodTarget) — they are interpolated inside double quotes here.
 */
export function buildCrictlNetnsScript(pod: string, namespace: string): string {
  return [
    `SANDBOX_ID=$(crictl pods --name "^${pod}$" --namespace "${namespace}" -q 2>/dev/null | head -1)`,
    `if [ -z "$SANDBOX_ID" ]; then echo "Error: cannot find sandbox for pod ${pod} in namespace ${namespace} on this node" >&2; exit 1; fi`,
    `NETNS_PATH=$(crictl inspectp "$SANDBOX_ID" 2>/dev/null | jq -r '.info.runtimeSpec.linux.namespaces[] | select(.type=="network") | .path')`,
    `if [ -z "$NETNS_PATH" ]; then echo "Error: cannot find network namespace for sandbox $SANDBOX_ID" >&2; exit 1; fi`,
    `basename "$NETNS_PATH"`,
  ].join("\n");
}

function checkResolvedNetns(netns: string): { netns: string } | { error: string } {
  if (!netns) return { error: "Failed to resolve network namespace (empty result)." };
  const nameErr = validateNetnsName(netns);
  // The name comes from crictl on the node (trusted), but re-validate defensively before it is
  // ever embedded in `ip netns exec` downstream.
  if (nameErr) return { error: `Resolved an unexpected netns name: ${nameErr}` };
  return { netns };
}

/**
 * kubectl path: resolve the pod's node (kubectl API) and its netns name (crictl via a privileged
 * debug pod with `nsenter -t 1`). Returns both so the caller can target node_exec/node_script.
 */
export async function resolvePodNetnsViaKubectl(opts: {
  pod: string;
  namespace: string;
  container?: string;
  env: ExecEnv;
  userId: string;
  clusterKey: string;
  image: string;
  signal?: AbortSignal;
}): Promise<{ node: string; netns: string } | { error: string }> {
  const invalid = validatePodTarget(opts.pod, opts.namespace, opts.container);
  if (invalid) return { error: invalid };
  const resolved = await resolveContainerNetns(opts.pod, opts.namespace, opts.container, opts.env);
  if ("error" in resolved) return resolved;

  const script = buildCrictlNetnsScript(opts.pod, opts.namespace);
  const nsenterCmd = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh", "-c", script];
  const execResult = await runInDebugPod(
    { userId: opts.userId, nodeName: resolved.nodeName, command: nsenterCmd, image: opts.image, clusterKey: opts.clusterKey },
    opts.env,
    { timeoutMs: 30_000, signal: opts.signal },
  );
  if (opts.signal?.aborted) return { error: "Aborted." };
  if (execResult.exitCode !== 0) {
    return { error: execResult.stderr.trim() || "Failed to resolve network namespace" };
  }
  const checked = checkResolvedNetns(execResult.stdout.trim());
  if ("error" in checked) return checked;
  return { node: resolved.nodeName, netns: checked.netns };
}

/**
 * ssh path: the SSH session already lands in the node's host namespaces, so the crictl script
 * runs directly (no nsenter). Requires a root/CAP_SYS_ADMIN credential on the node (crictl).
 */
export async function resolvePodNetnsViaSsh(opts: {
  target: SshTarget;
  pod: string;
  namespace: string;
  container?: string;
  signal?: AbortSignal;
}): Promise<{ netns: string } | { error: string }> {
  const invalid = validatePodTarget(opts.pod, opts.namespace, opts.container);
  if (invalid) return { error: invalid };
  const script = buildCrictlNetnsScript(opts.pod, opts.namespace);
  let result;
  try {
    result = await sshExec(opts.target, script, { timeoutMs: 30_000, signal: opts.signal });
  } catch (err) {
    return { error: `SSH netns resolution failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (opts.signal?.aborted) return { error: "Aborted." };
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const hint = /permission|denied|not permitted|cannot open/i.test(stderr)
      ? " (crictl needs root on the node — the SSH credential must be a privileged account)"
      : "";
    return { error: (stderr || "Failed to resolve network namespace") + hint };
  }
  return checkResolvedNetns(result.stdout.trim());
}
