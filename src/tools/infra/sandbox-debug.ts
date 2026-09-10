import type { ExecEnv } from "./exec-utils.js";
import { kubectlExec } from "./debug-pod.js";

export const SANDBOX_NODE_CONCURRENCY = 10;
export const SANDBOX_DEBUG_NAMESPACE = "siclaw-script-diagnostics";
const LABEL = "siclaw.io/component";
const COMPONENT = "script-diagnostics";
const QUOTA = "script-diagnostics";

/** Provision only our diagnostic namespace. Never edit an existing namespace
 * or broaden an existing quota. Kubernetes admission enforces the count across
 * Runtime replicas, restarts, failed cleanup, and terminating/finished Pods.
 * This uses the trusted cluster credential, never the runner's ServiceAccount.
 */
export async function ensureSandboxDebugQuota(env: ExecEnv, signal?: AbortSignal): Promise<void> {
  const get = async (kind: string, name: string, namespace?: string) => {
    const r = await kubectlExec(["get", kind, name, "--ignore-not-found", "-o", "json"], env, 10_000, signal, namespace);
    return r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
  };
  const create = async (manifest: unknown, namespace?: string) => {
    try { await kubectlExec(["create", "-f", "-"], env, 10_000, signal, namespace, JSON.stringify(manifest)); }
    catch (error) {
      // Another Runtime may have won the create. Re-read and validate below;
      // permission errors, missing objects and conflicting policy fail closed.
      signal?.throwIfAborted();
    }
  };
  let ns = await get("namespace", SANDBOX_DEBUG_NAMESPACE);
  if (!ns) {
    await create({ apiVersion: "v1", kind: "Namespace", metadata: { name: SANDBOX_DEBUG_NAMESPACE, labels: { [LABEL]: COMPONENT } } });
    ns = await get("namespace", SANDBOX_DEBUG_NAMESPACE);
  }
  if (ns?.metadata?.labels?.[LABEL] !== COMPONENT || ns.metadata.deletionTimestamp) throw new Error("Sandbox diagnostic namespace unavailable");
  let quota = await get("resourcequota", QUOTA, SANDBOX_DEBUG_NAMESPACE);
  if (!quota) {
    await create({ apiVersion: "v1", kind: "ResourceQuota", metadata: { name: QUOTA, labels: { [LABEL]: COMPONENT } },
      spec: { hard: { "count/pods": String(SANDBOX_NODE_CONCURRENCY), "count/jobs.batch": String(SANDBOX_NODE_CONCURRENCY * 2) } } }, SANDBOX_DEBUG_NAMESPACE);
    quota = await get("resourcequota", QUOTA, SANDBOX_DEBUG_NAMESPACE);
  }
  const hard = quota?.spec?.hard;
  const bounded = (value: unknown, max: number) => typeof value === "string" && /^\d+$/.test(value) && Number(value) <= max;
  if (quota?.metadata?.labels?.[LABEL] !== COMPONENT || quota.metadata.deletionTimestamp
      || quota.spec.scopes?.length || quota.spec.scopeSelector
      || !bounded(hard?.["count/pods"], SANDBOX_NODE_CONCURRENCY) || !bounded(hard?.["count/jobs.batch"], SANDBOX_NODE_CONCURRENCY * 2)) {
    throw new Error("Sandbox diagnostic quota required");
  }
}
