/**
 * Execution infrastructure shared by all remote execution tools.
 *
 * Consolidates: process spawning, environment setup, name validation,
 * debug pod lifecycle, container netns resolution, and output formatting.
 */
import { spawn } from "node:child_process";
import type { KubeconfigRef } from "../../core/agent-factory.js";
import { resolveKubeconfigPath } from "./kubeconfig-resolver.js";
import { sanitizeEnv } from "./sanitize-env.js";
import { checkNodeReady } from "./k8s-checks.js";

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
  /** Optional data to write to the child's stdin (pipe mode). */
  stdinData?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, {
      stdio: [stdinData !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      env,
    });
    // Write stdin data and close — the child reads the script from stdin
    if (stdinData !== undefined && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
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
 * Build a shell command that reads a script from stdin and executes it.
 *
 * - bash: `bash -s -- args`  (`-s` = read commands from stdin)
 * - python3: `python3 - args` (`-` = read script from stdin; `-s` is a different flag in python)
 */
export function stdinExecCmd(interpreter: "bash" | "python3", escapedArgs?: string): string {
  if (interpreter === "python3") {
    return escapedArgs ? `python3 - ${escapedArgs}` : "python3 -";
  }
  return escapedArgs ? `bash -s -- ${escapedArgs}` : "bash -s";
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

// ── Output types ────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
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
