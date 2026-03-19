/**
 * Keyword extractor for format string templates.
 *
 * Splits a format string's static parts into searchable keywords for L2 fallback matching.
 * Keywords enable the lookup_log_source tool to find candidate templates via intersection-ratio scoring.
 */

/** Minimum character length for a keyword to be included. Filters noise words like "to", "in", "at". */
export const MIN_KEYWORD_LENGTH = 3;

/**
 * Regex to strip format placeholders from a template string.
 *
 * Handles:
 * - Go: %s, %d, %v, %f, %x, %q, %w, %%, %+v, %#v, %10.2f, %-20s, %04d
 * - Python/Java: {}, {0}, {name}, {:.2f}
 * - Rust: {:?}, {:#?}
 */
const FORMAT_PLACEHOLDER_RE = /%([-+# 0]*)(\*|\d+)?(?:\.(\*|\d+))?[a-zA-Z%]|\{[^}]*\}/g;

/**
 * Regex for splitting on delimiters — whitespace and punctuation.
 *
 * Note: `.` and `/` are NOT in the delimiter set — they appear in namespace tokens
 * like `k8s.io/client-go` which should be preserved as whole words.
 */
const DELIMITER_RE = /[\s:=,;()\[\]{}<>|!?'"]+/;

/**
 * Extract searchable keywords from a format string template.
 *
 * Strips format placeholders, splits on delimiters, filters short tokens,
 * lowercases, deduplicates, and returns a sorted array.
 *
 * @param template - The format string template (e.g., "failed to connect to %s:%d")
 * @returns Sorted, deduplicated, lowercased keywords with length >= MIN_KEYWORD_LENGTH
 */
export function extractKeywords(template: string): string[] {
  const stripped = template.replace(FORMAT_PLACEHOLDER_RE, " ");
  const tokens = stripped.split(DELIMITER_RE);

  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.length < MIN_KEYWORD_LENGTH) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    keywords.push(lower);
  }

  return keywords.sort();
}
