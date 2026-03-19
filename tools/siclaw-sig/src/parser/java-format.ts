/**
 * Java format string to regex converter.
 *
 * Parses SLF4J/Log4j2 `{}` placeholders — the only placeholder style in Java logging.
 * Every `{}` maps to `(.*)` with `precise: false` (type unknown at extraction time),
 * which means any template with placeholders degrades to keyword-only (medium confidence).
 */

import type { FormatParseResult, ParsedVerb } from "./types.js";
import { validateRegex } from "./redos-guard.js";

// ── Placeholder regex ──────────────────────────────────────────────

/** Matches SLF4J/Log4j2 `{}` placeholders (no format specifiers). */
const JAVA_PLACEHOLDER_RE = /\{\}/g;

// ── Internal helpers ───────────────────────────────────────────────

function escapeRegexChars(text: string): string {
  return text.replace(/[\\.*+?^${}()|[\]]/g, "\\$&");
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Convert a Java SLF4J/Log4j2 format string into a regex pattern and metadata.
 *
 * Every `{}` placeholder is imprecise (type unknown), so templates with
 * placeholders always return medium confidence with null regex.
 *
 * @param template - A Java format string (e.g., "Connection failed for host {}")
 * @returns FormatParseResult with regex, confidence, and parsed verb metadata
 */
export function parseJavaFormat(template: string): FormatParseResult {
  const verbs: ParsedVerb[] = [];
  const regexParts: string[] = [];
  let lastIndex = 0;

  for (const match of template.matchAll(JAVA_PLACEHOLDER_RE)) {
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

  // Confidence logic
  let confidence: FormatParseResult["confidence"];
  let regex: string | null;

  if (verbs.length === 0) {
    confidence = "exact";
    regex = "^" + regexParts.join("") + "$";
  } else {
    // All placeholders are imprecise → medium, null regex
    confidence = "medium";
    regex = null;
  }

  // Validate regex safety
  if (regex !== null) {
    const validation = validateRegex(regex);
    if (!validation.safe) {
      return { regex: null, confidence: "medium", verbs };
    }
  }

  return { regex, confidence, verbs };
}
