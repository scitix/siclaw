/**
 * Synchronous kubeconfig resolver.
 *
 * Translates `--kubeconfig=<name>` (a cluster name, not a path) into an
 * absolute file path on disk. The data source is the CredentialBroker's
 * in-memory registry, which must have been populated by an async ensure()
 * call from the caller's execute() entry point before this runs.
 *
 * Fail-fast contract: every resolver function throws a descriptive error
 * when the broker has no record of a cluster name. Callers must NOT handle
 * "not found" as null — if a kubectl command mentions a cluster, that
 * cluster must already have been ensured. See ensure-kubeconfigs.ts.
 */

import type { CredentialBroker, ClusterLocalInfo } from "../../agentbox/credential-broker.js";

export interface ResolverDeps {
  broker?: CredentialBroker;
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function throwNotLoaded(name: string): never {
  throw new Error(
    `Kubeconfig "${name}" not loaded into broker registry. ` +
    `Caller must await broker.ensureCluster("${name}") before invoking the resolver ` +
    `(normally via ensureKubeconfigsForCommand in the tool's execute entry).`,
  );
}

function getLoaded(broker: CredentialBroker, name: string): ClusterLocalInfo {
  const info = broker.getClusterLocalInfo(name);
  if (!info) throwNotLoaded(name);
  if (!info.path) throwNotLoaded(name);
  return info;
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
      `Multiple kubeconfigs are loaded (${names}). Specify --kubeconfig=<name> to pick one.`,
    );
  }
  return all[0].path ?? null;
}

/** Resolve a kubeconfig file path by cluster name. Throws if not loaded. */
export function resolveKubeconfigByName(deps: ResolverDeps, name: string): string {
  if (!deps.broker) throwNotLoaded(name);
  return getLoaded(deps.broker, name).path!;
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
        `Multiple kubeconfigs available (${names.join(", ")}). ` +
        `Specify the kubeconfig parameter to select a cluster. Use cluster_list to discover available clusters.`,
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
