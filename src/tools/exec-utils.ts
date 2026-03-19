/**
 * Execution infrastructure shared by all remote execution tools.
 *
 * Consolidates: process spawning, environment setup, name validation,
 * debug pod lifecycle, container netns resolution, and output formatting.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { resolveKubeconfigPath } from "./kubeconfig-resolver.js";
import { sanitizeEnv } from "./sanitize-env.js";
import { processToolOutput } from "./tool-render.js";
import { checkNodeReady, waitForPodDone } from "./k8s-checks.js";
import { loadConfig } from "../core/config.js";
import {
  buildDebugPodLabels,
  ensureDebugNamespace,
  DEBUG_POD_RESOURCE_REQUESTS,
  DEBUG_POD_RESOURCE_LIMITS,
  deleteDebugPod,
  debugPodCache,
  kubectlExec,
} from "./debug-pod.js";

// ── Name validators ──────────────────────────────────────────────────

/** Valid node name: RFC 1123 — alphanumeric, hyphens, dots. */
export const NODE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9.\-]*$/;

/** Valid pod name: RFC 1123 subdomain — lowercase alphanumeric, hyphens, dots. */
export const POD_NAME_RE = /^[a-z0-9][a-z0-9.\-]*$/;

export function validateNodeName(node: string): string | null {
  if (!node || !node.trim()) {
    return "Node name must not be empty.";
  }
  if (!NODE_NAME_RE.test(node)) {
    return `Invalid node name "${node}". Node names may only contain letters, digits, hyphens, and dots.`;
  }
  return null;
}

export function validatePodName(pod: string): string | null {
  if (!pod || !pod.trim()) {
    return "Pod name must not be empty.";
  }
  if (!POD_NAME_RE.test(pod)) {
    return `Invalid pod name "${pod}". Pod names may only contain lowercase letters, digits, hyphens, and dots.`;
  }
  return null;
}

// ── Environment preparation ──────────────────────────────────────────

export interface ExecEnv {
  childEnv: NodeJS.ProcessEnv;
  kubeconfigPath: string | null;
  kubeconfigArgs: string[];
}

/**
 * Build a sanitised child-process environment with kubeconfig resolution.
 * Sets KUBECONFIG=/dev/null to block default ~/.kube/config; passes
 * explicit --kubeconfig= via kubeconfigArgs when credentials are available.
 *
 * @param kubeconfigRef — credential directory reference
 * @param resolvedKubeconfigPath — pre-resolved kubeconfig path (from resolveRequiredKubeconfig).
 *   `undefined` = auto-resolve via resolveKubeconfigPath (legacy single-cluster fallback).
 *   `null` = explicitly no kubeconfig (KUBECONFIG will be /dev/null).
 *   `string` = use this exact path.
 */
export function prepareExecEnv(kubeconfigRef?: KubeconfigRef, resolvedKubeconfigPath?: string | null): ExecEnv {
  const kubeconfigPath = resolvedKubeconfigPath !== undefined
    ? resolvedKubeconfigPath
    : resolveKubeconfigPath(kubeconfigRef?.credentialsDir);
  return {
    childEnv: {
      ...sanitizeEnv(process.env as Record<string, string>),
      ...(kubeconfigRef?.credentialsDir
        ? { SICLAW_CREDENTIALS_DIR: kubeconfigRef.credentialsDir }
        : {}),
      KUBECONFIG: "/dev/null",
    },
    kubeconfigPath,
    kubeconfigArgs: kubeconfigPath ? [`--kubeconfig=${kubeconfigPath}`] : [],
  };
}

// ── Process utilities ────────────────────────────────────────────────

/**
 * Spawn a child process and collect stdout/stderr.
 * Supports timeout and AbortSignal for cancellation.
 */
export function spawnAsync(
  cmd: string,
  args: string[],
  timeout: number,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          Object.assign(new Error(`exit ${code}`), { code, stdout, stderr }),
        );
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

/**
 * Filter out kubectl run informational lines from stderr
 * (e.g. 'pod "node-debug-xxx" deleted').
 */
export function filterPodNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !line.match(/^pod "node-debug-.*" deleted$/))
    .join("\n")
    .trim();
}

// ── Output formatting ────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
}

/**
 * Format an ExecResult into a standard tool result shape.
 * Applies filterPodNoise and processToolOutput.
 */
export function formatExecOutput(result: ExecResult): {
  content: Array<{ type: "text"; text: string }>;
  details: { exitCode: number | null; error?: boolean };
} {
  const filteredStderr = filterPodNoise(result.stderr);
  const output =
    result.stdout.trim() +
    (filteredStderr ? `\n\nSTDERR:\n${filteredStderr}` : "");

  if (result.exitCode === 0 || (result.exitCode === null && result.stdout.trim())) {
    return {
      content: [{ type: "text", text: processToolOutput(output) }],
      details: { exitCode: result.exitCode ?? 0 },
    };
  } else {
    const errOutput = `Exit code: ${result.exitCode ?? "unknown"}\n${output}`;
    return {
      content: [{ type: "text", text: processToolOutput(errOutput) }],
      details: { exitCode: result.exitCode, error: true },
    };
  }
}

// ── Debug Pod lifecycle ──────────────────────────────────────────────

export interface DebugPodSpec {
  userId: string;
  nodeName: string;
  /** Full command array for the container (including nsenter if needed). */
  command: string[];
  image?: string;
}

/**
 * Run a command inside a privileged debug pod on a specific node.
 *
 * Uses an always-reuse model:
 *   - First call for a (userId, nodeName) pair creates a long-lived pod
 *     with `sleep infinity` and caches it.
 *   - Subsequent calls reuse the cached pod via `kubectl exec`.
 *   - Idle pods are auto-deleted by DebugPodCache after the configured timeout.
 *   - activeDeadlineSeconds (config.debugPodTTL) is the hard safety net.
 */
export async function runInDebugPod(
  spec: DebugPodSpec,
  env: ExecEnv,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<ExecResult> {
  const config = loadConfig();
  const image = spec.image || config.debugImage;
  const debugNamespace = config.debugNamespace;
  const idleTimeoutMs = config.debugPodIdleTimeout * 1000;

  // ── Phase 0: Lookup or create a reusable pod ──────────────────────
  const cached = debugPodCache.get(spec.userId, spec.nodeName);
  let podName: string;
  let isNewPod = false;

  if (cached) {
    podName = cached.podName;
  } else {
    // Acquire concurrency slot — throws if already held (e.g., concurrent creation race)
    debugPodCache.acquire(spec.userId, spec.nodeName);
    isNewPod = true;

    const podId = randomBytes(4).toString("hex");
    podName = `node-debug-${podId}`;

    const labels = buildDebugPodLabels(spec.userId, spec.nodeName);
    const activeDeadlineSeconds = config.debugPodTTL;

    const overrides = JSON.stringify({
      metadata: { labels },
      spec: {
        activeDeadlineSeconds,
        nodeName: spec.nodeName,
        hostPID: true,
        hostNetwork: true,
        containers: [{
          name: podName,
          image,
          securityContext: { privileged: true },
          command: ["sleep", "infinity"],
          resources: {
            requests: DEBUG_POD_RESOURCE_REQUESTS,
            limits: DEBUG_POD_RESOURCE_LIMITS,
          },
        }],
        restartPolicy: "Never",
      },
    });

    try {
      // Ensure namespace
      await ensureDebugNamespace(debugNamespace, env);

      // Create the pod
      await spawnAsync(
        "kubectl",
        [
          ...env.kubeconfigArgs,
          "-n", debugNamespace,
          "run", podName,
          "--restart=Never",
          `--image=${image}`,
          `--overrides=${overrides}`,
        ],
        30_000,
        env.childEnv,
        opts.signal,
      );

      // Wait for Running phase (adaptive polling from Plan 02-01)
      const phase = await waitForPodDone(
        podName, opts.timeoutMs, env.childEnv, opts.signal,
        env.kubeconfigPath ?? undefined, debugNamespace, "Running",
      );

      if (phase !== "Running") {
        // Pod went to terminal phase without reaching Running — creation failed
        await deleteDebugPod(podName, env, {
          namespace: debugNamespace,
          nodeName: spec.nodeName,
          force: true,
        });
        debugPodCache.remove(spec.userId, spec.nodeName);
        return {
          stdout: "",
          stderr: `Debug pod failed to start (phase: ${phase}). Check node "${spec.nodeName}" status.`,
          exitCode: null,
        };
      }

      // Store in cache — idle timer starts now
      debugPodCache.set(spec.userId, spec.nodeName, podName, debugNamespace, env, idleTimeoutMs);
    } catch (err: any) {
      // Pod creation failed — clean up and release slot
      await deleteDebugPod(podName, env, {
        namespace: debugNamespace,
        nodeName: spec.nodeName,
        force: true,
      });
      debugPodCache.remove(spec.userId, spec.nodeName);
      return {
        stdout: err.stdout?.trim() ?? "",
        stderr: err.stderr?.trim() ?? err.message,
        exitCode: typeof err.code === "number" ? err.code : null,
      };
    }
  }

  // ── Phase 1: Execute command via kubectl exec ─────────────────────
  if (opts.signal?.aborted) {
    if (isNewPod) {
      await deleteDebugPod(podName, env, {
        namespace: debugNamespace,
        nodeName: spec.nodeName,
        force: true,
      });
      debugPodCache.remove(spec.userId, spec.nodeName);
    }
    return { stdout: "", stderr: "Aborted.", exitCode: null };
  }

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  let timedOut = false;

  try {
    const result = await kubectlExec(
      ["exec", podName, "--", ...spec.command],
      env,
      opts.timeoutMs,
      opts.signal,
      debugNamespace,
    );
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = 0;
  } catch (err: any) {
    stdout = err.stdout?.trim() ?? "";
    stderr = err.stderr?.trim() ?? err.message;

    if (typeof err.code === "number") {
      exitCode = err.code;
    } else {
      // Non-numeric exit code: kubectl was killed (timeout/abort) or failed to connect.
      // Distinguish timeout (SIGKILL from spawnAsync timer) from other failures by
      // checking if the signal was SIGKILL and no meaningful stderr was produced —
      // a killed-by-timeout process typically has empty or truncated stderr.
      exitCode = null;
      if (err.code === null && !stderr && !opts.signal?.aborted) {
        timedOut = true;
      }
    }

    // Check if pod is still alive — if gone or in terminal phase, evict stale cache entry
    if (exitCode === null) {
      let podPhase = "";
      try {
        const phaseResult = await kubectlExec(
          ["get", "pod", podName, "-o", "jsonpath={.status.phase}"],
          env,
          5_000,
          undefined,
          debugNamespace,
        );
        podPhase = phaseResult.stdout.trim();
      } catch {
        // Pod is gone
        podPhase = "";
      }
      if (!podPhase || podPhase === "Succeeded" || podPhase === "Failed") {
        debugPodCache.remove(spec.userId, spec.nodeName);
        return { stdout, stderr, exitCode };
      }
    }
  }

  // ── Phase 2: Reset idle timer ─────────────────────────────────────
  debugPodCache.touch(spec.userId, spec.nodeName, idleTimeoutMs);

  return { stdout, stderr, exitCode, ...(timedOut ? { timedOut: true } : {}) };
}

// ── Container netns resolution ───────────────────────────────────────

/**
 * Resolve the network namespace of a container inside a pod.
 * Returns the node name and container ID needed to construct nsenter commands.
 *
 * Steps:
 *   1. Verify pod is Running, get its node name
 *   2. Verify node is Ready
 *   3. Get container ID, strip runtime prefix
 */
export async function resolveContainerNetns(
  pod: string,
  namespace: string,
  container: string | undefined,
  env: ExecEnv,
): Promise<{ nodeName: string; containerID: string } | { error: string }> {
  // Step 1: Get pod phase + node
  let nodeName: string;
  try {
    const result = await spawnAsync(
      "kubectl",
      [
        ...env.kubeconfigArgs,
        "get", "pod", pod, "-n", namespace,
        "-o", "jsonpath={.status.phase},{.spec.nodeName}",
      ],
      10_000,
      env.childEnv,
    );
    const parts = result.stdout.trim().split(",");
    const phase = parts[0];
    nodeName = parts[1] || "";
    if (phase !== "Running") {
      return {
        error: `Pod "${pod}" in namespace "${namespace}" is not Running (phase: ${phase || "unknown"}). Cannot enter its network namespace.`,
      };
    }
    if (!nodeName) {
      return {
        error: `Could not determine node for pod "${pod}" in namespace "${namespace}".`,
      };
    }
  } catch (err: any) {
    const stderr = (err.stderr?.trim() || err.message) as string;
    if (stderr.includes("not found")) {
      return {
        error: `Pod "${pod}" not found in namespace "${namespace}". Check the pod name and namespace.`,
      };
    }
    return { error: `Failed to get pod info: ${stderr}` };
  }

  // Step 2: Check node is Ready
  const nodeCheckErr = await checkNodeReady(
    nodeName, env.childEnv, env.kubeconfigPath ?? undefined,
  );
  if (nodeCheckErr) {
    return { error: nodeCheckErr };
  }

  // Step 3: Get container ID
  try {
    const jsonpathExpr = container?.trim()
      ? `{.status.containerStatuses[?(@.name=="${container.trim()}")].containerID}`
      : "{.status.containerStatuses[0].containerID}";
    const result = await spawnAsync(
      "kubectl",
      [
        ...env.kubeconfigArgs,
        "get", "pod", pod, "-n", namespace,
        "-o", `jsonpath=${jsonpathExpr}`,
      ],
      10_000,
      env.childEnv,
    );
    let containerID = result.stdout.trim();
    if (!containerID) {
      return {
        error: `Could not determine container ID for pod "${pod}". Is the pod running?`,
      };
    }
    // Strip the runtime prefix (e.g. "containerd://")
    const prefixIdx = containerID.indexOf("://");
    if (prefixIdx !== -1) {
      containerID = containerID.slice(prefixIdx + 3);
    }
    return { nodeName, containerID };
  } catch (err: any) {
    return {
      error: `Failed to get container ID: ${err.stderr?.trim() || err.message}`,
    };
  }
}
