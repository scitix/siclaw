/**
 * Rust format string to regex converter.
 *
 * Parses Rust format macro placeholders:
 * - `{}` — Display trait (type unknown)
 * - `{:?}` and `{:#?}` — Debug trait
 * - `{name}` — named parameter
 * - `{:.*}`, `{:.2}`, `{:x}` — format specifiers (still imprecise)
 *
 * All Rust format placeholders are imprecise (type unknown at extraction time),
 * so templates with any placeholder degrade to keyword-only (medium confidence).
 */

import type { FormatParseResult, ParsedVerb } from "./types.js";
import { validateRegex } from "./redos-guard.js";

// ── Placeholder regex ──────────────────────────────────────────────

/**
 * Matches Rust format macro placeholders.
 * Handles: {}, {:?}, {:#?}, {name}, {name:?}, {:.2}, {:x}, {:>10}, etc.
 * Does NOT match escaped braces `{{` or `}}`.
 */
const RUST_PLACEHOLDER_RE = /\{(?:\w+)?(?::(?:#?\??|[^}]*))?\}/g;

/** Matches escaped brace pairs `{{` or `}}` that should be treated as literals. */
const ESCAPED_BRACE_RE = /\{\{|\}\}/g;

// ── Internal helpers ───────────────────────────────────────────────

function escapeRegexChars(text: string): string {
  return text.replace(/[\\.*+?^${}()|[\]]/g, "\\$&");
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Convert a Rust format string into a regex pattern and metadata.
 *
 * All Rust format placeholders are treated as imprecise since Rust's
 * Display/Debug traits don't narrow the output type enough for precise regex.
 *
 * @param template - A Rust format string (e.g., "connection failed: {:?}")
 * @returns FormatParseResult with regex, confidence, and parsed verb metadata
 */
export function parseRustFormat(template: string): FormatParseResult {
  // First, replace escaped braces with sentinel tokens to avoid matching them
  const sentinel = "\x00BRACE\x00";
  const preprocessed = template.replace(ESCAPED_BRACE_RE, sentinel);

  const verbs: ParsedVerb[] = [];
  const regexParts: string[] = [];
  let lastIndex = 0;

  for (const match of preprocessed.matchAll(RUST_PLACEHOLDER_RE)) {
    const fullMatch = match[0];
    const matchIndex = match.index!;

    if (matchIndex > lastIndex) {
      const segment = preprocessed.slice(lastIndex, matchIndex).replace(new RegExp(sentinel.replace(/\x00/g, "\\x00"), "g"), "{");
      regexParts.push(escapeRegexChars(segment));
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

  if (lastIndex < preprocessed.length) {
    const segment = preprocessed.slice(lastIndex).replace(new RegExp(sentinel.replace(/\x00/g, "\\x00"), "g"), "{");
    regexParts.push(escapeRegexChars(segment));
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
