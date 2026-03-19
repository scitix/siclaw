/**
 * Bash format string to regex converter.
 *
 * Two modes based on the `style` parameter:
 *
 * **echo mode** (variable interpolation):
 * - `$VAR` and `${VAR}` → `(.*)` with `precise: false` (confidence=medium)
 *
 * **printf mode** (format verbs):
 * - `%s`, `%d`, `%f` → precise regex patterns (same approach as Go)
 * - `%%` → literal `%`
 */

import type { FormatParseResult, ParsedVerb } from "./types.js";
import { validateRegex } from "./redos-guard.js";

// ── Verb-to-regex mapping (printf mode) ────────────────────────────

const BASH_PRINTF_PATTERNS: Record<string, { pattern: string; precise: boolean }> = {
  s: { pattern: "(.*)", precise: true },
  d: { pattern: "(-?\\d+)", precise: true },
  f: { pattern: "(-?\\d+\\.?\\d*)", precise: true },
  e: { pattern: "(.*)", precise: false },
};

/** Regex for printf-style format verbs. */
const PRINTF_VERB_RE = /%([-]*)(\d+)?(?:\.(\d+))?([sdfe%])/g;

/** Regex for bash variable references: $VAR or ${VAR} or ${VAR:-default}. */
const BASH_VAR_RE = /\$\{?\w+(?::-[^}]*)?\}?/g;

// ── Internal helpers ───────────────────────────────────────────────

function escapeRegexChars(text: string): string {
  return text.replace(/[\\.*+?^${}()|[\]]/g, "\\$&");
}

// ── Parsers ────────────────────────────────────────────────────────

function parsePrintfStyle(template: string): FormatParseResult {
  const verbs: ParsedVerb[] = [];
  const regexParts: string[] = [];
  let lastIndex = 0;

  for (const match of template.matchAll(PRINTF_VERB_RE)) {
    const fullMatch = match[0];
    const verbChar = match[4];
    const matchIndex = match.index!;

    if (matchIndex > lastIndex) {
      regexParts.push(escapeRegexChars(template.slice(lastIndex, matchIndex)));
    }

    if (verbChar === "%") {
      regexParts.push("%");
    } else {
      const mapping = BASH_PRINTF_PATTERNS[verbChar] ?? { pattern: "(.*)", precise: false };
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

function parseEchoStyle(template: string): FormatParseResult {
  const verbs: ParsedVerb[] = [];
  const regexParts: string[] = [];
  let lastIndex = 0;

  for (const match of template.matchAll(BASH_VAR_RE)) {
    const fullMatch = match[0];
    const matchIndex = match.index!;

    if (matchIndex > lastIndex) {
      regexParts.push(escapeRegexChars(template.slice(lastIndex, matchIndex)));
    }

    const parsedVerb: ParsedVerb = {
      raw: fullMatch,
      verb: "v",
      pattern: "(.*)",
      precise: false,
    };
    verbs.push(parsedVerb);
    regexParts.push("(.*)");

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
 * Convert a Bash format string into a regex pattern and metadata.
 *
 * @param template - A Bash format string
 * @param style - "echo" for variable interpolation, "printf" for format verbs
 * @returns FormatParseResult with regex, confidence, and parsed verb metadata
 */
export function parseBashFormat(template: string, style: "echo" | "printf"): FormatParseResult {
  if (style === "printf") {
    return parsePrintfStyle(template);
  }
  return parseEchoStyle(template);
}
