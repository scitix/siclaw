/**
 * InjectedPromptKind — enumerates how a prompt body was generated.
 *
 * SINGLE SOURCE OF TRUTH: the `INJECTED_PROMPT_REGISTRY` array below.
 * To add a new injection class, append ONE entry to that array. Everything
 * else (the union type, the lookup map, the Set used by isInjectedPromptKind,
 * the classification function) is *derived* from the registry.
 *
 * No other file needs to change when you add a kind:
 *   - DB schema is plain TEXT / VARCHAR(64) — accepts any new string.
 *   - The recorder writes whatever classifyInjectedPrompt() returns.
 *   - The API filter parses caller-supplied keys against the derived Set.
 *
 * Naming contract (do NOT break):
 *   - `key` is the on-the-wire / DB string. Once a kind ships, NEVER rename
 *     its key — old rows in production carry the old string. Add a new entry
 *     and deprecate the old one if you need to evolve semantics.
 *   - `key` should be lowercase snake_case so it reads cleanly in URLs / SQL.
 *
 * Special entries:
 *   - "none"           — emitted by classifyInjectedPrompt() when nothing
 *                        matches; its `match` is the fallthrough sentinel.
 *   - "unknown_legacy" — never emitted by classifyInjectedPrompt(); reserved
 *                        for data migrators that cannot recover the original
 *                        kind from a legacy row.
 *   Both have `match: () => false` so they never claim a live prompt.
 */

interface InjectedPromptKindDef {
  /** Stable lowercase string. Goes to DB and JSON. NEVER rename once shipped. */
  readonly key: string;
  /** Short human-readable description for code-search context. */
  readonly description: string;
  /**
   * Returns true if this entry claims the given prompt body. The FIRST entry
   * (in registry order) whose `match` returns true wins. `trimmed` is the
   * input with leading/trailing whitespace stripped; `afterDpWrapper` is the
   * same with the optional `[Deep Investigation]\n` mode prefix removed
   * (it's a mode flag, not canned content, so chip-style matchers should
   * pattern against `afterDpWrapper`).
   */
  readonly match: (trimmed: string, afterDpWrapper: string) => boolean;
}

/**
 * Frontend chip clicks are encoded on the wire as `[<label>]\n<fullPrompt>`.
 * Source of truth for labels: portal-web/src/components/chat/PilotArea.tsx.
 *
 * Each chip is registered as its OWN kind (chip_dig_deeper, chip_proceed, …)
 * so analytics can answer "which button was clicked" directly from the DB.
 * Helper used by the per-chip matchers below.
 */
function chipMatcher(label: string) {
  const re = new RegExp(`^\\[${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\]\\n`);
  return (_t: string, afterDpWrapper: string) => re.test(afterDpWrapper);
}

// ── REGISTRY ─ append new kinds at the bottom, above NONE/UNKNOWN_LEGACY. ──
//
// To add a new injection class:
//   1. Add one entry below with a unique `key` and a `match` predicate.
//   2. That's it. No other file in the codebase needs to change.
//
export const INJECTED_PROMPT_REGISTRY = [
  {
    key: "dp_confirm_legacy",
    description: "Pre-refactor [DP_CONFIRM] button (HypothesesCard, deleted Apr 2026).",
    match: (t) => t === "[DP_CONFIRM]\nThe user has confirmed hypotheses.",
  },
  {
    key: "dp_skip_legacy",
    description: "Pre-refactor [DP_SKIP] button.",
    match: (t) => t === "[DP_SKIP]\nSkip validation and present conclusion.",
  },
  {
    key: "dp_reinvestigate_legacy",
    description: "Pre-refactor [DP_REINVESTIGATE] default-text button (no user hint).",
    match: (t) => t === "[DP_REINVESTIGATE]\nRe-investigate from a different angle.",
  },
  {
    key: "feedback",
    description: "Plain [Feedback] button click.",
    match: (t) => t === "[Feedback]",
  },
  {
    key: "dig_deeper",
    description: "Long canned paragraph injected by the dig-deeper button.",
    match: (t) =>
      t.startsWith("Your conclusion may not be the root cause. Please dig deeper"),
  },
  {
    key: "delegation_batch_complete",
    description: "Synthetic capsule fed back to a parent session after delegate_to_agents finishes.",
    match: (t) => t.startsWith("[Delegation Batch Complete]\n"),
  },
  {
    key: "investigation_feedback_verdict",
    description: "Verdict-only investigation-feedback chip (no user comment).",
    match: (t) =>
      /^\[investigation feedback: (?:confirmed|corrected|rejected)\] investigationId=\S+$/.test(t),
  },
  // Per-chip click kinds. Frontend wraps the click as `[<label>]\n<fullPrompt>`,
  // optionally prefixed by `[Deep Investigation]\n` (the DP mode wrapper, which
  // chipMatcher() ignores). Add a new chip = add a new entry here.
  {
    key: "chip_dig_deeper",
    description: "Frontend chip [Dig deeper] click — purple chip in PilotArea.",
    match: chipMatcher("Dig deeper"),
  },
  {
    key: "chip_proceed",
    description: "Frontend chip [Proceed] click — DP checkpoint advance.",
    match: chipMatcher("Proceed"),
  },
  {
    key: "chip_refine",
    description: "Frontend chip [Refine] click — DP checkpoint refine.",
    match: chipMatcher("Refine"),
  },
  {
    key: "chip_summarize",
    description: "Frontend chip [Summarize] click — DP checkpoint summarize.",
    match: chipMatcher("Summarize"),
  },
  {
    key: "chip_adjust",
    description: "Frontend chip [Adjust] click — DP checkpoint adjust hypotheses.",
    match: chipMatcher("Adjust"),
  },
  {
    key: "chip_skip",
    description: "Frontend chip [Skip] click — DP checkpoint skip validation.",
    match: chipMatcher("Skip"),
  },

  // Deprecated catch-all kind from the era when all chips folded into one
  // string. NEVER returned by classifyInjectedPrompt() anymore (match is the
  // never-fire sentinel), but kept in the registry so historical DB rows that
  // still carry "chip_click" continue to validate via isInjectedPromptKind().
  // Do NOT delete — that would invalidate old data.
  {
    key: "chip_click",
    description: "Deprecated. Pre-split catch-all for any chip click; kept for backwards compat with historical rows. New rows use chip_<label> instead.",
    match: () => false,
  },

  // ── Sentinels ─ keep at the end, do not delete. ──
  {
    key: "none",
    description: "Plain user prompt (no canned content). Default classification fallthrough.",
    match: () => false,
  },
  {
    key: "unknown_legacy",
    description: "Reserved for data migrators backfilling old rows where original kind is unrecoverable. Never emitted by classifyInjectedPrompt().",
    match: () => false,
  },
] as const satisfies readonly InjectedPromptKindDef[];

// ── Everything below is DERIVED from the registry. Do not edit by hand. ──

/** Union type of every registered key. Auto-updates when the registry grows. */
export type InjectedPromptKind = (typeof INJECTED_PROMPT_REGISTRY)[number]["key"];

/**
 * Named lookup table. Lets callers write `INJECTED_PROMPT_KINDS.NONE` instead
 * of the string literal `"none"` — purely ergonomic, no behavior difference.
 * Built from the registry; the keys are the uppercase form of each `key`.
 */
export const INJECTED_PROMPT_KINDS = Object.fromEntries(
  INJECTED_PROMPT_REGISTRY.map((e) => [e.key.toUpperCase(), e.key]),
) as {
  readonly [E in (typeof INJECTED_PROMPT_REGISTRY)[number] as Uppercase<E["key"]>]: E["key"];
};

const ALL_KIND_VALUES: ReadonlySet<string> = new Set(
  INJECTED_PROMPT_REGISTRY.map((e) => e.key),
);

/** Type guard — accepts an arbitrary value from the wire/DB and narrows it. */
export function isInjectedPromptKind(v: unknown): v is InjectedPromptKind {
  return typeof v === "string" && ALL_KIND_VALUES.has(v);
}

/** Coerce an arbitrary value (e.g. legacy DB cell) into a valid kind. */
export function coerceInjectedPromptKind(v: unknown): InjectedPromptKind {
  return isInjectedPromptKind(v) ? v : "none";
}

const DP_MODE_WRAPPER = "[Deep Investigation]\n";

/**
 * Classify a user-message body into an InjectedPromptKind.
 *
 * Walks the registry in order; the first entry whose `match` returns true
 * wins. Falls back to "none" when nothing matches (the registry's NONE
 * sentinel never returns true on its own).
 */
export function classifyInjectedPrompt(text: string): InjectedPromptKind {
  if (!text) return "none";
  const trimmed = text.trim();
  const afterDpWrapper = trimmed.startsWith(DP_MODE_WRAPPER)
    ? trimmed.slice(DP_MODE_WRAPPER.length)
    : trimmed;
  for (const entry of INJECTED_PROMPT_REGISTRY) {
    if (entry.match(trimmed, afterDpWrapper)) return entry.key;
  }
  return "none";
}

/** Convenience boolean for code that only cares whether ANY injection happened. */
export function isInjectedPromptKindAny(kind: InjectedPromptKind): boolean {
  return kind !== "none";
}
