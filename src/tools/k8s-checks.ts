/**
 * Pre-flight K8s checks for tools that create debug pods or exec into pods.
 * Fast-fail when node/pod doesn't exist or isn't ready, avoiding long waits.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KUBECTL_TIMEOUT = 10_000; // 10s — pre-check should be fast

/**
 * Check that a Kubernetes node exists and is Ready.
 * Returns an error message string on failure, or null if the node is healthy.
 */
export async function checkNodeReady(
  node: string,
  env?: NodeJS.ProcessEnv,
  kubeconfigPath?: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "kubectl",
      [
        ...(kubeconfigPath ? [`--kubeconfig=${kubeconfigPath}`] : []),
        "get",
        "node",
        node,
        "-o",
        "jsonpath={.status.conditions[?(@.type==\"Ready\")].status}",
      ],
      { timeout: KUBECTL_TIMEOUT, env },
    );
    const status = stdout.trim();
    if (status !== "True") {
      return `Node "${node}" is not Ready (status: ${status || "unknown"}). The node may be down, cordoned, or experiencing issues.`;
    }
    return null;
  } catch (err: any) {
    const stderr = (err.stderr?.trim() || err.message) as string;
    if (stderr.includes("not found")) {
      return `Node "${node}" does not exist in the cluster. Check the node name and try again.`;
    }
    return `Failed to check node "${node}": ${stderr}`;
  }
}

/** Terminal pod phases — once a pod reaches one of these, it won't change. */
const TERMINAL_PHASES = new Set(["Succeeded", "Failed"]);

/** Adaptive polling constants — start fast (500ms) and back off to 5s cap. */
const POLL_INITIAL_MS = 500;
const POLL_MAX_MS = 5_000;
const POLL_BACKOFF_FACTOR = 1.5;

/**
 * Poll a pod until it reaches a target phase.
 * Returns the matched phase string, or throws on timeout / abort.
 *
 * When `targetPhase` is `"Running"`: returns as soon as the pod reaches
 * Running (or any terminal phase, to avoid hanging on immediate failure).
 * When `targetPhase` is `"terminal"` or omitted: waits for Succeeded/Failed
 * (original behavior).
 *
 * Uses adaptive backoff polling: starts at 500ms and increases by 1.5x
 * each iteration up to a 5s cap — reduces cold-start latency while
 * avoiding tight loops on long-running pods.
 */
export async function waitForPodDone(
  podName: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  kubeconfigPath?: string,
  namespace?: string,
  targetPhase?: "Running" | "terminal",
): Promise<string> {
  let pollInterval = POLL_INITIAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Aborted");

    try {
      const { stdout } = await execFileAsync(
        "kubectl",
        [
          ...(kubeconfigPath ? [`--kubeconfig=${kubeconfigPath}`] : []),
          "get", "pod", podName,
          ...(namespace ? ["-n", namespace] : []),
          "-o", "jsonpath={.status.phase}",
        ],
        { timeout: KUBECTL_TIMEOUT, env },
      );
      const phase = stdout.trim();
      if (targetPhase === "Running") {
        if (phase === "Running" || TERMINAL_PHASES.has(phase)) return phase;
      } else {
        if (TERMINAL_PHASES.has(phase)) return phase;
      }
    } catch {
      // kubectl transient error — keep polling
    }

    // Abortable sleep — wake up immediately on abort signal
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollInterval);
      if (signal) {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    pollInterval = Math.min(pollInterval * POLL_BACKOFF_FACTOR, POLL_MAX_MS);
  }

  throw new Error(`Timed out waiting for pod "${podName}" to complete`);
}

/**
 * Check that a Kubernetes pod exists and is in Running phase.
 * Returns an error message string on failure, or null if the pod is running.
 */
export async function checkPodRunning(
  pod: string,
  namespace: string,
  env?: NodeJS.ProcessEnv,
  kubeconfigPath?: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "kubectl",
      [
        ...(kubeconfigPath ? [`--kubeconfig=${kubeconfigPath}`] : []),
        "get",
        "pod",
        pod,
        "-n",
        namespace,
        "-o",
        "jsonpath={.status.phase}",
      ],
      { timeout: KUBECTL_TIMEOUT, env },
    );
    const phase = stdout.trim();
    if (phase !== "Running") {
      return `Pod "${pod}" in namespace "${namespace}" is not Running (phase: ${phase || "unknown"}). Cannot execute scripts in a non-running pod.`;
    }
    return null;
  } catch (err: any) {
    const stderr = (err.stderr?.trim() || err.message) as string;
    if (stderr.includes("not found")) {
      return `Pod "${pod}" not found in namespace "${namespace}". Check the pod name and namespace.`;
    }
    return `Failed to check pod "${pod}" in namespace "${namespace}": ${stderr}`;
  }
}
