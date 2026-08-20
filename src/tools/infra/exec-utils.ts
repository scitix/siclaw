/**
 * Execution infrastructure shared by all remote execution tools.
 *
 * Consolidates: process spawning, environment setup, name validation,
 * debug pod lifecycle, container netns resolution, and output formatting.
 */
import { spawn } from "node:child_process";
import type { KubeconfigRef } from "../../core/types.js";
import { resolveKubeconfigPath } from "./kubeconfig-resolver.js";
import { sanitizeEnv } from "./sanitize-env.js";
import { checkNodeReady } from "./k8s-checks.js";

// ── Name validators ──────────────────────────────────────────────────

/** Valid node name: RFC 1123 — alphanumeric, hyphens, dots. */
export const NODE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9.\-]*$/;

/** Valid pod name: RFC 1123 subdomain — lowercase alphanumeric, hyphens, dots. */
export const POD_NAME_RE = /^[a-z0-9][a-z0-9.\-]*$/;

/** Valid namespace / container name: RFC 1123 label — lowercase alphanumeric + hyphens, ≤63, no dots. */
export const K8S_LABEL_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Validate a Kubernetes namespace name (security-critical: it is interpolated into a shell
 * command in pod-netns-resolve — see buildCrictlNetnsScript). Returns an error message or null. */
export function validateNamespace(namespace: string): string | null {
  if (!namespace || !namespace.trim()) return "Namespace must not be empty.";
  if (namespace.length > 63 || !K8S_LABEL_RE.test(namespace)) {
    return `Invalid namespace "${namespace}". Namespaces must be an RFC-1123 label (lowercase letters, digits, hyphens; max 63).`;
  }
  return null;
}

/** Validate a container name (RFC-1123 label). Returns an error message or null. */
export function validateContainerName(container: string): string | null {
  if (!container || !container.trim()) return "Container name must not be empty.";
  if (container.length > 63 || !K8S_LABEL_RE.test(container)) {
    return `Invalid container name "${container}". Container names must be an RFC-1123 label (lowercase letters, digits, hyphens; max 63).`;
  }
  return null;
}

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
    : resolveKubeconfigPath({ broker: kubeconfigRef?.credentialBroker });
  return {
    childEnv: {
      ...sanitizeEnv(process.env as Record<string, string>),
      // SICLAW_CREDENTIALS_DIR is not passed to children: see the note on SICLAW_SAFE in
      // sanitize-env.ts. Nothing in a child reads it, and it hands an expansion payload the layout.
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
/**
 * Ceiling on captured output, matching the one restricted_bash passes to execFile.
 *
 * This function accumulated without any limit. That is not merely a memory risk: a review reported a
 * ~200k-line read whose captured prefix then read as a complete answer, and a search over it that found
 * nothing was taken as proof of absence. A cap the caller can SEE is better than either an unbounded
 * string or a silent cut.
 */
const SPAWN_OUTPUT_CAP_UNITS = 1024 * 1024 * 10;

export function spawnAsync(
  cmd: string,
  args: string[],
  timeout: number,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  /** Optional data to write to the child's stdin (pipe mode). */
  stdinData?: string,
): Promise<{ stdout: string; stderr: string; truncated?: boolean }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
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
    // Decode on the stream, not per chunk: command output is not ASCII (Chinese log
    // lines, box-drawing, emoji), and a character split across two data events would
    // otherwise arrive as two U+FFFD — see background-bash-runner.ts.
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    // Both halves are load-bearing and they interact. Decoding on the stream means chunks arrive as
    // STRINGS, so the cap counts UTF-16 code units rather than bytes — close enough for a memory
    // ceiling, and it must not slice through a surrogate pair, or truncation would reintroduce exactly
    // the mojibake `setEncoding` is here to prevent, just at the cut instead of at a chunk boundary.
    const appendCapped = (buf: string, chunk: string): { text: string; hitCap: boolean } => {
      if (buf.length >= SPAWN_OUTPUT_CAP_UNITS) return { text: buf, hitCap: true };
      const next = buf + chunk;
      if (next.length <= SPAWN_OUTPUT_CAP_UNITS) return { text: next, hitCap: false };
      let cut = next.slice(0, SPAWN_OUTPUT_CAP_UNITS);
      // A lone high surrogate at the cut is half a character; drop it.
      if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
      return { text: cut, hitCap: true };
    };
    child.stdout!.on("data", (chunk: string) => {
      const r = appendCapped(stdout, chunk);
      stdout = r.text;
      if (r.hitCap) truncated = true;
    });
    child.stderr!.on("data", (chunk: string) => {
      const r = appendCapped(stderr, chunk);
      stderr = r.text;
      if (r.hitCap) truncated = true;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // `truncated` travels on BOTH paths. A capped read that then exits non-zero is the case where a
      // partial prefix is most likely to be mistaken for a complete answer.
      if (code === 0) resolve({ stdout, stderr, truncated });
      else
        reject(
          Object.assign(new Error(`exit ${code}`), { code, stdout, stderr, truncated }),
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
 * Filter wrapper noise from kubectl/debug-pod stderr while preserving the actual
 * command or Kubernetes error. The klog `log.go:244` lines are client-side
 * SPDY/WebSocket stream diagnostics, not evidence from the target container.
 */
export function filterPodNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => {
      if (line.match(/^pod "node-debug-.*" deleted$/)) return false;
      return !line.match(
        /^[IWEF]\d{4}\s+\d{2}:\d{2}:\d+\.\d+\s+\d+\s+log\.go:\d+\].*(?:Create stream|Stream added, broadcasting:|Reply frame received for|Data frame received for|Data frame handling|Data frame sent|Stream removed, broadcasting:|Go away received).*$/,
      );
    })
    .join("\n")
    .trim();
}

// ── Output types ────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  /** Output hit the capture ceiling: what is here is a PREFIX, and a search over it proves nothing. */
  truncated?: boolean;
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
