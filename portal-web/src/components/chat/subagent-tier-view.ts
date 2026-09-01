/**
 * Recovering a sub-agent's tier outcome for display.
 *
 * The runtime records requested vs resolved tier, the selection source and a
 * fallback reason so a mis-picked tier is diagnosable: a tier is chosen by the
 * lead reading prose in a tool description, so without these "the child reported
 * badly" and "the lead picked the wrong tier" are indistinguishable. Those fields
 * were reaching the payload and being dropped when the card model was built, which
 * left the intended diagnostic entry point with no exit.
 *
 * The two sources are shaped differently and that is not incidental:
 *   - FOREGROUND — flattened snake_case fields on `item_results`, because the tool
 *     result is what the turn returns.
 *   - BACKGROUND — nested under `tier` on the persisted terminal event, because
 *     the tool call returned `launched` long before the outcome existed, so that
 *     event is the only record it ever has.
 *
 * Extracted from the card component so it can be tested: this is the layer where
 * a shape mismatch silently produces an empty badge.
 */

export interface TierOutcomeView {
  requestedTier?: string;
  resolvedTier?: string;
  selectionSource?: string;
  fallbackReason?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Merge the two shapes into one view, foreground winning where both exist.
 *
 * Returns undefined when NO tier was involved — the common case. A badge on every
 * item of every batch would be noise, and "no tier" is not a diagnostic.
 */
export function extractTierOutcome(
  foreground: unknown,
  persisted: unknown,
): TierOutcomeView | undefined {
  const inline = rec(foreground);
  const nested = rec(rec(persisted)?.tier) ?? rec(persisted);

  const requestedTier = str(inline?.requested_tier) ?? str(nested?.requestedTier);
  const resolvedTier = str(inline?.resolved_tier) ?? str(nested?.resolvedTier);
  if (!requestedTier && !resolvedTier) return undefined;

  return {
    requestedTier,
    resolvedTier,
    selectionSource: str(inline?.selection_source) ?? str(nested?.source),
    fallbackReason: str(inline?.fallback_reason) ?? str(nested?.fallbackReason),
  };
}

/** Human-readable fallback reasons. Unknown codes render verbatim rather than vanish. */
const TIER_FALLBACK_LABELS: Record<string, string> = {
  revision_mismatch: "tier config changed mid-flight",
  candidate_missing: "tier had no model configured",
  unknown_tier: "tier not offered",
  model_not_found: "tier model unavailable",
  context_overflow: "task too large for tier",
  model_setup_failed: "tier setup failed",
  parent_fallback_failed: "no usable model",
};

export interface TierBadge {
  text: string;
  title: string;
  /** True when the item did not run on the tier it asked for. */
  fellBack: boolean;
}

/**
 * The badge to render, or null for nothing to say.
 *
 * A fallback is shown as `requested → actual` rather than just the actual model:
 * the difference is the diagnostic. An operator-pinned tier (`env`) is marked
 * because it explains a choice the agent did not make.
 */
export function tierBadge(view: TierOutcomeView | undefined): TierBadge | null {
  if (!view) return null;
  const { requestedTier, resolvedTier, fallbackReason, selectionSource } = view;
  if (!requestedTier && !resolvedTier) return null;

  const fellBack = Boolean(requestedTier) && requestedTier !== resolvedTier;
  const actual = resolvedTier ?? "agent default";
  const reason = fallbackReason
    ? TIER_FALLBACK_LABELS[fallbackReason] ?? fallbackReason
    : undefined;
  const pinned = selectionSource === "env";

  return {
    fellBack,
    text: fellBack ? `${requestedTier} → ${actual}` : `${actual}${pinned ? " ·pinned" : ""}`,
    title: fellBack
      ? `requested "${requestedTier}", ran on ${actual}${reason ? ` — ${reason}` : ""}`
      : `model tier: ${actual}${pinned ? " (pinned by deployment)" : ""}`,
  };
}
