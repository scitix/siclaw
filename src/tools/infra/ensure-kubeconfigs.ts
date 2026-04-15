/**
 * ensureKubeconfigsForCommand — central async prefetch for cmd-exec tools.
 *
 * Every cmd-exec / script-exec tool must call this at the top of its
 * execute() method (BEFORE the synchronous security pipeline runs). It
 * scans the command for --kubeconfig=<name> / --kubeconfig <name> / -k <name>
 * arguments and calls broker.ensureCluster() for each, so the synchronous
 * kubeconfig-resolver can later look up the path without any async work.
 *
 * Rationale (see DESIGN.md §模块 6): the resolver is synchronous because
 * it's called deep inside synchronous validation pipelines. This helper is
 * the single async seam in front of that pipeline.
 */

import type { CredentialBroker } from "../../agentbox/credential-broker.js";

/**
 * Shared across ensure-kubeconfigs and restricted-bash's path replacement:
 * a kubeconfig *name* must be a plain identifier — no slashes, no quotes,
 * no whitespace. Broker keys use the same charset, so restricting here
 * keeps ensure / resolver / replace in lockstep.
 */
export const KUBECONFIG_NAME_CHARS = String.raw`[^\s/"'=]+`;

const KUBECONFIG_PATTERNS = [
  new RegExp(String.raw`(?:^|\s)--kubeconfig=(` + KUBECONFIG_NAME_CHARS + `)`, "g"),
  new RegExp(String.raw`(?:^|\s)--kubeconfig\s+(` + KUBECONFIG_NAME_CHARS + `)`, "g"),
];

/** Extract cluster names from `--kubeconfig=<name>` occurrences. */
export function extractKubeconfigNames(command: string): string[] {
  const names = new Set<string>();
  for (const pattern of KUBECONFIG_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(command)) !== null) {
      names.add(match[1]);
    }
  }
  return Array.from(names);
}

/**
 * For every --kubeconfig=<name> in the command, ensure the broker has
 * acquired that cluster. Fail-fast: throws if any acquire fails.
 */
export async function ensureKubeconfigsForCommand(
  broker: CredentialBroker | undefined,
  command: string,
  purpose: string,
): Promise<void> {
  if (!broker) return;
  const names = extractKubeconfigNames(command);
  if (names.length === 0) return;
  await Promise.all(names.map((n) => broker.ensureCluster(n, purpose)));
}

/**
 * Prefetch for tools that take a single `kubeconfig` parameter (pod-exec,
 * node-exec, pod-script, etc.). Populates the broker registry so the
 * synchronous resolver has a path to return.
 *
 * - If a specific name is given → acquire just that cluster.
 * - If no name is given → list clusters; if exactly one is bound, acquire it
 *   so resolveRequiredKubeconfig can auto-select; otherwise let the resolver
 *   produce its normal "multiple/none" error.
 */
export async function ensureClusterForTool(
  broker: CredentialBroker | undefined,
  kubeconfigParam: string | undefined,
  purpose: string,
): Promise<void> {
  if (!broker) return;
  if (kubeconfigParam) {
    await broker.ensureCluster(kubeconfigParam, purpose);
    return;
  }
  const clusters = await broker.refreshClusters();
  if (clusters.length === 1) {
    await broker.ensureCluster(clusters[0].name, purpose);
  }
}

/**
 * Ensure a host's credential file is materialized on disk before host_exec /
 * host_script tries to read it. Throws when the broker is missing, or when
 * the broker can't fetch the host (not bound, gateway error, etc).
 */
export async function ensureHostForTool(
  broker: CredentialBroker | undefined,
  hostName: string,
  purpose: string,
): Promise<void> {
  if (!broker) {
    throw new Error("Credential broker required for host_exec / host_script");
  }
  await broker.ensureHost(hostName, purpose);
}
