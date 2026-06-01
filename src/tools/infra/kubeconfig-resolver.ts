/**
 * Synchronous kubeconfig resolver.
 *
 * Translates a cluster credential name (the tool's `cluster` parameter) into an
 * absolute kubeconfig file path on disk. The data source is the CredentialBroker's
 * in-memory registry, which must have been populated by an async ensure() call
 * (ensureClusterForTool) from the caller's execute() entry point before this runs.
 */

import type { CredentialBroker, ClusterLocalInfo } from "../../agentbox/credential-broker.js";

export interface ResolverDeps {
  broker?: CredentialBroker;
}

// ──────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────

/**
 * Resolve the kubeconfig path when the caller hasn't specified a cluster name.
 * Returns null when the broker is absent or empty. Throws if multiple clusters
 * are loaded (caller must specify a name).
 */
export function resolveKubeconfigPath(deps: ResolverDeps): string | null {
  if (!deps.broker) return null;
  const all = deps.broker.listClustersLocalInfo().filter((e) => e.path);
  if (all.length === 0) return null;
  if (all.length > 1) {
    const names = all.map((e) => e.meta.name).join(", ");
    throw new Error(
      `Multiple clusters are loaded (${names}). Set the \`cluster\` parameter to pick one.`,
    );
  }
  return all[0].path ?? null;
}

/**
 * Resolve kubeconfig with mandatory selection when multiple clusters exist.
 *
 * - broker absent / registry empty → { path: null }
 * - 1 loaded, no name → auto-select
 * - 1 loaded, name given → resolve by name (error if mismatch)
 * - >1 loaded, no name → error (ambiguous)
 * - >1 loaded, name given → resolve by name (error if not loaded)
 *
 * "Loaded" means the broker has a path for that cluster (i.e. ensure() ran).
 */
export function resolveRequiredKubeconfig(
  deps: ResolverDeps,
  name: string | undefined,
): { path: string | null } | { error: string; availableNames?: string[] } {
  if (!deps.broker) return { path: null };
  const loaded = deps.broker.listClustersLocalInfo().filter((e) => e.path);

  if (loaded.length === 0) {
    // A name was requested but ensure() produced no path — something upstream
    // failed silently. Fail fast instead of kubectl-ing /dev/null.
    if (name) {
      return {
        error: `Kubeconfig "${name}" is not available (broker ensure did not populate a path). Confirm the agent is bound to this cluster in the Portal.`,
        availableNames: [],
      };
    }
    return { path: null };
  }

  if (loaded.length === 1 && !name) {
    return { path: loaded[0].path ?? null };
  }

  if (!name) {
    const names = loaded.map((e) => e.meta.name);
    return {
      error:
        `Multiple clusters available (${names.join(", ")}). ` +
        `Set the \`cluster\` parameter to select one. Use cluster_list to discover available clusters.`,
      availableNames: names,
    };
  }

  const match = loaded.find((e) => e.meta.name === name);
  if (!match) {
    const names = loaded.map((e) => e.meta.name);
    return {
      error: `Kubeconfig "${name}" not loaded. Available: ${names.join(", ") || "(none)"}`,
      availableNames: names,
    };
  }
  return { path: match.path ?? null };
}

/**
 * Per-cluster debug image for pod-based debug tools. Reads from the
 * broker registry (source: clusters.debug_image column, propagated through
 * CredentialService.listClusters metadata).
 */
export function resolveDebugImage(deps: ResolverDeps, name: string | undefined): string | null {
  if (!deps.broker) return null;
  let match: ClusterLocalInfo | undefined;
  if (name) {
    match = deps.broker.getClusterLocalInfo(name);
  } else {
    const loaded = deps.broker.listClustersLocalInfo().filter((e) => e.path);
    if (loaded.length === 1) match = loaded[0];
  }
  return match?.meta.debug_image ?? null;
}
