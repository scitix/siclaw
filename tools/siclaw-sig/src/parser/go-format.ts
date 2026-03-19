/**
 * Go format string to regex converter.
 *
 * Parses printf-style Go format strings (e.g., "failed to connect to %s:%d")
 * and converts them into regex patterns for log line matching.
 * Handles all standard Go fmt verbs, width/precision modifiers, and unknown
 * placeholders (degrades to greedy match instead of throwing).
 */

import type { FormatParseResult, ParsedVerb } from "./types.js";
import { validateRegex } from "./redos-guard.js";

// ── Verb-to-regex mapping ──────────────────────────────────────────

const GO_VERB_PATTERNS: Record<string, { pattern: string; precise: boolean }> = {
  s: { pattern: "(.*)", precise: true },
  d: { pattern: "(-?\\d+)", precise: true },
  f: { pattern: "(-?\\d+\\.?\\d*)", precise: true },
  x: { pattern: "([0-9a-fA-F]+)", precise: true },
  q: { pattern: '(".*?")', precise: true },
  v: { pattern: "(.*)", precise: false },
  w: { pattern: "(.*)", precise: false },
};

/**
 * Regex for parsing Go format verbs.
 * Matches: %[flags][width][.precision]verb including %% literal.
 * Flags: -, +, #, space, 0
 * Width/precision: number or * (dynamic)
 */
const GO_FORMAT_VERB_RE = /%([-+# 0]*)(\*|\d+)?(?:\.(\*|\d+))?([a-zA-Z%])/g;

// ── Internal helpers ───────────────────────────────────────────────

/** Escape regex special characters in static text segments. */
function escapeRegexChars(text: string): string {
  return text.replace(/[\\.*+?^${}()|[\]]/g, "\\$&");
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Convert a Go format string into a regex pattern and metadata.
 *
 * @param template - A Go printf-style format string (e.g., "failed to connect to %s:%d")
 * @returns FormatParseResult with regex, confidence, and parsed verb metadata
 */
export function parseGoFormat(template: string): FormatParseResult {
  const verbs: ParsedVerb[] = [];
  const regexParts: string[] = [];
  let lastIndex = 0;

  for (const match of template.matchAll(GO_FORMAT_VERB_RE)) {
    const fullMatch = match[0];
    const verbChar = match[4];
    const matchIndex = match.index!;

    // Append escaped static text before this verb
    if (matchIndex > lastIndex) {
      regexParts.push(escapeRegexChars(template.slice(lastIndex, matchIndex)));
    }

    if (verbChar === "%") {
      // %% → literal percent sign, not a verb
      regexParts.push("%");
    } else {
      const mapping = GO_VERB_PATTERNS[verbChar] ?? { pattern: "(.*)", precise: false };
      const parsedVerb: ParsedVerb = {
        raw: fullMatch,
        verb: verbChar,
        pattern: mapping.pattern,
        precise: mapping.precise,
      };
      verbs.push(parsedVerb);
      regexParts.push(mapping.pattern);
    }

    lastIndex = matchIndex + fullMatch.length;
  }

  // Append any trailing static text
  if (lastIndex < template.length) {
    regexParts.push(escapeRegexChars(template.slice(lastIndex)));
  }

  // Compute confidence
  let confidence: FormatParseResult["confidence"];
  let regex: string | null;

  if (verbs.length === 0) {
    // Pure static string — no placeholders
    confidence = "exact";
    regex = "^" + regexParts.join("") + "$";
  } else if (verbs.every((v) => v.precise)) {
    // All verbs produce precise regex patterns
    confidence = "exact";
    regex = "^" + regexParts.join("") + "$";
  } else if (verbs.some((v) => v.precise)) {
    // Mixed: some precise, some imprecise
    confidence = "high";
    regex = "^" + regexParts.join("") + "$";
  } else {
    // All verbs are imprecise (%v, %w, unknown) — keyword-only path
    confidence = "medium";
    regex = null;
  }

  // Validate regex safety — downgrade to keyword-only if dangerous
  if (regex !== null) {
    const validation = validateRegex(regex);
    if (!validation.safe) {
      return { regex: null, confidence: "medium", verbs };
    }
  }

  return { regex, confidence, verbs };
}
