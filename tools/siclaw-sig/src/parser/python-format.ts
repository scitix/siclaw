/**
 * Python format string to regex converter.
 *
 * Parses two Python placeholder styles:
 * 1. %-style: %s, %d, %f, %r, %x (printf-style, common in logging stdlib)
 * 2. {}-style: {}, {0}, {name}, {:.2f}, {!r} (str.format / f-strings)
 *
 * Detection: if template contains `%s`/`%d`/etc, use %-style parser.
 * If template contains `{` and no %-verbs, use {}-style parser.
 * If both present, prefer %-style (more common in logging stdlib).
 */

import type { FormatParseResult, ParsedVerb } from "./types.js";
import { validateRegex } from "./redos-guard.js";

// ── Verb-to-regex mappings ─────────────────────────────────────────

const PYTHON_PERCENT_PATTERNS: Record<string, { pattern: string; precise: boolean }> = {
  s: { pattern: "(.*)", precise: true },
  d: { pattern: "(-?\\d+)", precise: true },
  f: { pattern: "(-?\\d+\\.?\\d*)", precise: true },
  r: { pattern: "(.*)", precise: false },
  x: { pattern: "([0-9a-fA-F]+)", precise: true },
};

/** Maps {}-style format specs to precise patterns when recognizable. */
const BRACE_SPEC_PATTERNS: Record<string, { pattern: string; precise: boolean }> = {
  d: { pattern: "(-?\\d+)", precise: true },
  f: { pattern: "(-?\\d+\\.?\\d*)", precise: true },
};

/**
 * Regex for %-style format verbs.
 * Matches: %[flags][width][.precision]verb including %% literal.
 */
const PERCENT_VERB_RE = /%([-+# 0]*)(\*|\d+)?(?:\.(\*|\d+))?([a-zA-Z%])/g;

/**
 * Regex for {}-style format placeholders.
 * Matches: {}, {0}, {name}, {:.2f}, {!r}, {name:>10.2f}, etc.
 */
const BRACE_PLACEHOLDER_RE = /\{(?:(\w+)?(?:![rsa])?)(?::([^}]*))?\}/g;

/** Detect whether template contains %-style format verbs. */
const HAS_PERCENT_VERBS_RE = /%([-+# 0]*)(\*|\d+)?(?:\.(\*|\d+))?[a-zA-Z]/;

// ── Internal helpers ───────────────────────────────────────────────

function escapeRegexChars(text: string): string {
  return text.replace(/[\\.*+?^${}()|[\]]/g, "\\$&");
}

/**
 * Extract the base format type letter from a {}-style format spec.
 * E.g., ".2f" → "f", "d" → "d", ">10.2f" → "f", "#x" → "x"
 */
function extractSpecType(spec: string): string | null {
  const match = spec.match(/([a-zA-Z])$/);
  return match ? match[1] : null;
}

// ── Parsers ────────────────────────────────────────────────────────

function parsePercentStyle(template: string): FormatParseResult {
  const verbs: ParsedVerb[] = [];
  const regexParts: string[] = [];
  let lastIndex = 0;

  for (const match of template.matchAll(PERCENT_VERB_RE)) {
    const fullMatch = match[0];
    const verbChar = match[4];
    const matchIndex = match.index!;

    if (matchIndex > lastIndex) {
      regexParts.push(escapeRegexChars(template.slice(lastIndex, matchIndex)));
    }

    if (verbChar === "%") {
      regexParts.push("%");
    } else {
      const mapping = PYTHON_PERCENT_PATTERNS[verbChar] ?? { pattern: "(.*)", precise: false };
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

  if (lastIndex < template.length) {
    regexParts.push(escapeRegexChars(template.slice(lastIndex)));
  }

  return computeResult(verbs, regexParts);
}

function parseBraceStyle(template: string): FormatParseResult {
  const verbs: ParsedVerb[] = [];
  const regexParts: string[] = [];
  let lastIndex = 0;

  for (const match of template.matchAll(BRACE_PLACEHOLDER_RE)) {
    const fullMatch = match[0];
    const spec = match[2] ?? "";
    const matchIndex = match.index!;

    if (matchIndex > lastIndex) {
      regexParts.push(escapeRegexChars(template.slice(lastIndex, matchIndex)));
    }

    // Try to extract a precise type from the format spec
    let mapping: { pattern: string; precise: boolean } = { pattern: "(.*)", precise: false };
    if (spec) {
      const specType = extractSpecType(spec);
      if (specType && BRACE_SPEC_PATTERNS[specType]) {
        mapping = BRACE_SPEC_PATTERNS[specType];
      }
    }

    const parsedVerb: ParsedVerb = {
      raw: fullMatch,
      verb: spec ? (extractSpecType(spec) ?? "v") : "v",
      pattern: mapping.pattern,
      precise: mapping.precise,
    };
    verbs.push(parsedVerb);
    regexParts.push(mapping.pattern);

    lastIndex = matchIndex + fullMatch.length;
  }

  if (lastIndex < template.length) {
    regexParts.push(escapeRegexChars(template.slice(lastIndex)));
  }

  return computeResult(verbs, regexParts);
}

// ── Shared confidence logic ────────────────────────────────────────

function computeResult(verbs: ParsedVerb[], regexParts: string[]): FormatParseResult {
  let confidence: FormatParseResult["confidence"];
  let regex: string | null;

  if (verbs.length === 0) {
    confidence = "exact";
    regex = "^" + regexParts.join("") + "$";
  } else if (verbs.every((v) => v.precise)) {
    confidence = "exact";
    regex = "^" + regexParts.join("") + "$";
  } else if (verbs.some((v) => v.precise)) {
    confidence = "high";
    regex = "^" + regexParts.join("") + "$";
  } else {
    confidence = "medium";
    regex = null;
  }

  if (regex !== null) {
    const validation = validateRegex(regex);
    if (!validation.safe) {
      return { regex: null, confidence: "medium", verbs };
    }
  }

  return { regex, confidence, verbs };
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Convert a Python format string into a regex pattern and metadata.
 *
 * Detects %-style vs {}-style and dispatches to the appropriate parser.
 * If both styles are present, %-style takes precedence (more common in logging).
 *
 * @param template - A Python format string (e.g., "Failed to connect to %s:%d" or "User {} logged in")
 * @returns FormatParseResult with regex, confidence, and parsed verb metadata
 */
export function parsePythonFormat(template: string): FormatParseResult {
  const hasPercent = HAS_PERCENT_VERBS_RE.test(template);

  if (hasPercent) {
    return parsePercentStyle(template);
  }

  // Check for {}-style placeholders
  if (template.includes("{")) {
    return parseBraceStyle(template);
  }

  // Pure static string
  return computeResult([], [escapeRegexChars(template)]);
}
