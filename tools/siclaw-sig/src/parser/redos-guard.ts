/**
 * ReDoS (Regular expression Denial of Service) guard.
 *
 * Validates regex patterns for compilation correctness and heuristic
 * catastrophic backtracking detection. Used as a post-processing step
 * on format parser output to ensure generated patterns are safe to
 * execute against untrusted log input.
 */

/** Result of regex validation — safe to use, or unsafe with reason. */
export interface RegexValidationResult {
  safe: boolean;
  reason?: string;
}

/**
 * Detect consecutive unbounded quantifier groups without sufficient static separators.
 *
 * Matches two `(.*)` or `(.+)` groups separated by 0-1 non-group characters.
 * A static separator of length >= 2 between groups is considered safe.
 */
const CONSECUTIVE_UNBOUNDED_RE = /\(\.[*+]\)(?:[^(]{0,1})\(\.[*+]\)/;

/**
 * Count unbounded quantifier groups: `(.*)` or `(.+)`.
 */
const UNBOUNDED_GROUP_RE = /\(\.[*+]\)/g;

/** Maximum number of unbounded capture groups before flagging as degenerate. */
const MAX_UNBOUNDED_GROUPS = 10;

/**
 * Validate a regex pattern for compilation correctness and ReDoS safety.
 *
 * Three-step validation:
 * 1. Compilation check — pattern must be valid JavaScript regex
 * 2. ReDoS heuristic — consecutive unbounded quantifiers without static separators
 * 3. Group count — too many unbounded groups indicates a degenerate pattern
 *
 * @param pattern - The regex pattern string to validate
 * @returns Validation result with `safe: true` or `safe: false` with reason
 */
export function validateRegex(pattern: string): RegexValidationResult {
  // Step 1 — Compilation check
  try {
    new RegExp(pattern);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { safe: false, reason: `invalid regex: ${message}` };
  }

  // Step 2 — ReDoS heuristic: consecutive unbounded quantifiers
  if (CONSECUTIVE_UNBOUNDED_RE.test(pattern)) {
    return {
      safe: false,
      reason:
        "potential catastrophic backtracking: consecutive unbounded quantifiers without static separators",
    };
  }

  // Step 3 — Group count check
  const unboundedMatches = pattern.match(UNBOUNDED_GROUP_RE);
  if (unboundedMatches && unboundedMatches.length > MAX_UNBOUNDED_GROUPS) {
    return {
      safe: false,
      reason: `too many capture groups (>${MAX_UNBOUNDED_GROUPS}): likely degenerate pattern`,
    };
  }

  return { safe: true };
}
