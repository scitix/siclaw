/**
 * Async prefetch seam for cmd-exec / script-exec tools.
 *
 * The kubeconfig resolver is synchronous (called deep inside synchronous
 * validation pipelines), so a tool must materialize the cluster it needs BEFORE
 * that pipeline runs. `ensureClusterForTool` does that from the tool's `cluster`
 * parameter; `ensureHostForTool` does the equivalent for host credentials.
 */

import type { CredentialBroker, HostLocalInfo } from "../../agentbox/credential-broker.js";

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

/** Structured result of a failed `ensureClusterForTool`, rendered to the model. */
export interface ClusterFailure {
  error: true;
  reason: "cluster_not_bound" | "cluster_unavailable";
  message: string;
  retryable: boolean;
  available_clusters: string[];
}

/**
 * Classify a failed `ensureClusterForTool` as a missing binding or an upstream
 * fault.
 *
 * The transport reports both the same way — an HTTP 502 whose body says "cluster
 * not found" — so forwarding the raw error tells the model "transient gateway
 * problem, worth retrying" when the real answer is "this agent has no such
 * cluster bound, and no number of retries will change that". It then retries the
 * same call, or moves on to node/pod tools that share the binding and fail
 * identically. Re-reading the binding list is what separates the two cases.
 *
 * Fails toward `cluster_unavailable`: when the binding list itself is
 * unreachable we cannot prove the cluster is unbound, and reporting a config
 * error for what may be a transient fault is the more misleading of the two.
 */
export async function classifyClusterFailure(
  broker: CredentialBroker | undefined,
  clusterName: string | undefined,
  err: unknown,
): Promise<ClusterFailure> {
  const raw = err instanceof Error ? err.message : String(err);

  let bound: string[];
  try {
    if (!broker) throw new Error("no broker");
    bound = (await broker.refreshClusters()).map((c) => c.name);
  } catch {
    return {
      error: true,
      reason: "cluster_unavailable",
      message: raw,
      retryable: true,
      available_clusters: [],
    };
  }

  // An empty list settles it with or without a name: the tool may have omitted
  // `cluster` and let ensureClusterForTool auto-select, but there was nothing to
  // select. Requiring a name here left that path reporting a retryable fault.
  if (bound.length === 0) {
    return {
      error: true,
      reason: "cluster_not_bound",
      message:
        `No cluster is bound to this agent, so no kubeconfig can be materialized. ` +
        `Retrying will not help, and node/pod tools sharing this binding will fail ` +
        `the same way. Ask the operator to bind a cluster in the Portal.`,
      retryable: false,
      available_clusters: [],
    };
  }

  if (clusterName && !bound.includes(clusterName)) {
    return {
      error: true,
      reason: "cluster_not_bound",
      message:
        `Cluster "${clusterName}" is not bound to this agent, so its kubeconfig ` +
        `cannot be materialized. Retrying will not help. Call cluster_list to see ` +
        `what is bound.`,
      retryable: false,
      available_clusters: bound,
    };
  }

  return {
    error: true,
    reason: "cluster_unavailable",
    message: raw,
    retryable: true,
    available_clusters: bound,
  };
}

/**
 * Ensure a host's credential file is materialized on disk before host_exec /
 * host_script tries to read it, and RETURN the resolved registry entry. Throws
 * when the broker is missing, or when the broker can't fetch the host (not
 * bound, gateway error, etc).
 *
 * Returning the entry is load-bearing: `ensureHost` maps the handle (a host
 * NAME or an id) to its `credential.name`-keyed registry entry. Callers must
 * use THIS entry rather than re-looking-up by the original handle, which would
 * miss when the handle is a host id even though ensureHost succeeded.
 */
export async function ensureHostForTool(
  broker: CredentialBroker | undefined,
  hostName: string,
  purpose: string,
): Promise<HostLocalInfo> {
  if (!broker) {
    throw new Error("Credential broker required for host_exec / host_script");
  }
  return broker.ensureHost(hostName, purpose);
}
