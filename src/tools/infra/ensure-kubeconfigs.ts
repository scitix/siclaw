/**
 * Async prefetch seam for cmd-exec / script-exec tools.
 *
 * The kubeconfig resolver is synchronous (called deep inside synchronous
 * validation pipelines), so a tool must materialize the cluster it needs BEFORE
 * that pipeline runs. `ensureClusterForTool` does that from the tool's `cluster`
 * parameter; `ensureHostForTool` does the equivalent for host credentials.
 */

import type { CredentialBroker } from "../../agentbox/credential-broker.js";

/**
 * Prefetch for tools that take a single `cluster` parameter (pod-exec,
 * node-exec, pod-script, restricted-bash, etc.) — value is the cluster's
 * credential name. Populates the broker registry so the synchronous resolver
 * has a path to return.
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
