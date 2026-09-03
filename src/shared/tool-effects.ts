/**
 * Declared tool effects — the vocabulary the effect ceiling is enforced against.
 *
 * The envelope's `effectCeiling` says how far a governed turn may go. To enforce
 * it the runtime needs to know how far each TOOL goes, and that cannot be
 * inferred from a name: `k8s_inspect` reads, `pod_exec` does not. So every tool
 * that can mutate DECLARES its effect (see `ToolEntry.effect` /
 * `TOOL_EFFECTS` in core/tool-registry.ts) and the guard compares the two.
 *
 * Why this replaces the old test. The guard used to gate only when
 * `allowedCapabilities` was non-empty, which made the ceiling unenforceable on
 * its own: an envelope saying `effectCeiling: "observe"` with no allow-list
 * permitted every tool, including `bash`. A ceiling that a caller can neutralise
 * by omitting a second, unrelated field is not a control. The declared-effect
 * model makes the ceiling load-bearing by itself, and leaves the allow-list as
 * an ADDITIONAL narrowing rather than the switch that turns enforcement on.
 */

export type ToolEffect =
  | "observe"
  | "local_write"
  | "external_write"
  | "destructive"
  | "credential_read";

/**
 * Ordered severity of the comparable effects. `credential_read` is deliberately
 * absent: it is not a point on this scale but an out-of-band capability (reading
 * a secret is not "more writing"), so it can never be permitted by raising a
 * ceiling — see `effectExceedsCeiling`.
 */
export const EFFECT_RANK: Record<Exclude<ToolEffect, "credential_read">, number> = {
  observe: 0,
  local_write: 1,
  external_write: 2,
  destructive: 3,
};

/**
 * True when `effect` is beyond what `ceiling` permits.
 *
 * Two fail-closed rules:
 *   - `credential_read` ALWAYS exceeds, at every ceiling. The guard blocks it
 *     outright rather than gating it, because no human approval issued through
 *     the proposal flow is an authorization to read a credential.
 *   - an UNKNOWN ceiling string is treated as `observe`, the most restrictive
 *     one. A control plane that ships a ceiling this runtime does not understand
 *     yet must not thereby widen what the runtime allows.
 */
export function effectExceedsCeiling(effect: ToolEffect, ceiling: string): boolean {
  if (effect === "credential_read") return true;
  const effectRank = EFFECT_RANK[effect];
  const ceilingRank = ceiling in EFFECT_RANK
    ? EFFECT_RANK[ceiling as Exclude<ToolEffect, "credential_read">]
    : EFFECT_RANK.observe;
  return effectRank > ceilingRank;
}
