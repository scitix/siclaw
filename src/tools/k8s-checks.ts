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
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "kubectl",
      [
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

/**
 * Poll a pod until it reaches a terminal phase (Succeeded or Failed).
 * Returns the final phase string, or throws on timeout / kubectl errors.
 *
 * This replaces `kubectl wait --for=jsonpath={.status.phase}=Succeeded`
 * which hangs indefinitely when the pod fails (phase=Failed never matches).
 */
export async function waitForPodDone(
  podName: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  const pollInterval = 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Aborted");

    try {
      const { stdout } = await execFileAsync(
        "kubectl",
        ["get", "pod", podName, "-o", "jsonpath={.status.phase}"],
        { timeout: KUBECTL_TIMEOUT, env },
      );
      const phase = stdout.trim();
      if (TERMINAL_PHASES.has(phase)) return phase;
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
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "kubectl",
      [
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
