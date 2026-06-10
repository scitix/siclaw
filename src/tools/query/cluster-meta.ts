import type { ClusterMetaEntry } from "../../shared/credential-types.js";

/**
 * Reserved system metadata keys that must never reach the model — mirrors
 * sicore's `metadata.IsReservedSystemKey`. `registry` is debug-image plumbing
 * (already surfaced via `debug_image`), not an infrastructure fact. sicore
 * filters these upstream; we enforce it here too because this helper is the
 * final model-visible boundary (defense in depth, no drift-free guarantee).
 */
const RESERVED_SYSTEM_KEYS = new Set(["registry"]);

/**
 * Flatten filled cluster metadata into a compact `key → value` record for LLM
 * consumption. Keyed by the stable `key` (sicore guarantees `(org_id, key)`
 * uniqueness) — NOT `display_name`, which is editable display text that can
 * collide and would silently clobber entries under `Object.fromEntries`.
 *
 * Returns `{}` when there are no usable entries, so callers can spread the
 * result directly into a tool's output object — the `meta` key simply doesn't
 * appear. This is the single output sink for both the credential.get path
 * (already filtered in inferClusterMetaFromResponse) and the credential.list
 * path (carried through unvalidated), so it also drops malformed entries and
 * reserved system keys here — nothing model-visible escapes this boundary.
 */
export function flattenClusterMeta(
  entries: ClusterMetaEntry[] | undefined,
): { meta?: Record<string, string> } {
  if (!entries || entries.length === 0) return {};
  const pairs = entries
    .filter(
      (e): e is ClusterMetaEntry =>
        !!e && typeof e === "object" &&
        typeof e.key === "string" && typeof e.value === "string" &&
        !RESERVED_SYSTEM_KEYS.has(e.key),
    )
    .map((e) => [e.key, e.value] as const);
  if (pairs.length === 0) return {};
  return { meta: Object.fromEntries(pairs) };
}
