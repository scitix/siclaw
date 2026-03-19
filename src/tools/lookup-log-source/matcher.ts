import type { ScanRecord } from "./file-resolver.js";

export interface MatchResult {
  /** Source record ID */
  id: string;
  component: string;
  version: string;
  file: string;
  line: number;
  function: string;
  level: string;
  template: string;
  confidence: "exact" | "high";
  context: {
    source_lines: string[];
    line_range: [number, number];
  };
  /** L2 only: keyword intersection ratio (0-1) */
  score?: number;
}

/**
 * Regex for splitting on delimiters — whitespace and punctuation.
 * Same delimiter set as tools/siclaw-sig/src/parser/keywords.ts.
 * Note: `.` and `/` are NOT in the delimiter set — they appear in namespace tokens.
 */
const DELIMITER_RE = /[\s:=,;()\[\]{}<>|!?'"]+/;

/** Minimum character length for a keyword to be included. */
const MIN_KEYWORD_LENGTH = 3;

function toMatchResult(record: ScanRecord, confidence: "exact" | "high", score?: number): MatchResult {
  return {
    id: record.id,
    component: record.component,
    version: record.version,
    file: record.file,
    line: record.line,
    function: record.function,
    level: record.level,
    template: record.template,
    confidence,
    context: record.context,
    ...(score !== undefined ? { score } : {}),
  };
}

/**
 * L1 regex matcher — test normalized log line against each record's regex.
 * Returns ALL matches (no short-circuit) since multiple templates may match.
 * Records with null regex are skipped (handled by L2).
 * Regex is compiled with try/catch — invalid regex is skipped with no error.
 */
export function matchL1(normalizedLine: string, records: ScanRecord[]): MatchResult[] {
  const results: MatchResult[] = [];

  for (const record of records) {
    if (record.regex === null) continue;

    let re: RegExp;
    try {
      re = new RegExp(record.regex);
    } catch {
      continue;
    }

    if (re.test(normalizedLine)) {
      results.push(toMatchResult(record, "exact"));
    }
  }

  return results;
}

/**
 * Extract keywords from a runtime log line for L2 matching.
 * Reuses the same delimiter/filter logic as the extraction-time keyword extractor.
 * Splits on whitespace + punctuation (except . and /), filters tokens < 3 chars, lowercases.
 */
export function extractLineKeywords(line: string): string[] {
  const tokens = line.split(DELIMITER_RE);

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

/**
 * Compute keyword intersection ratio between a log line's keywords and a template's keywords.
 * Ratio = |intersection| / |template.keywords|
 * Returns 0 if template has no keywords.
 */
export function keywordIntersectionRatio(lineKeywords: Set<string>, templateKeywords: string[]): number {
  if (templateKeywords.length === 0) return 0;

  let count = 0;
  for (const kw of templateKeywords) {
    if (lineKeywords.has(kw)) count++;
  }

  return count / templateKeywords.length;
}

/**
 * L2 keyword fallback matcher.
 * Computes intersection ratio for ALL records, returns top-3 by ratio descending.
 * Only includes candidates with ratio > 0 (at least one keyword overlap).
 * Confidence is "high" for all L2 results.
 * Excludes records already matched by L1 (pass L1 result IDs as excludeIds).
 */
export function matchL2(
  normalizedLine: string,
  records: ScanRecord[],
  excludeIds?: Set<string>,
): MatchResult[] {
  const lineKeywords = new Set(extractLineKeywords(normalizedLine));

  const candidates: { record: ScanRecord; ratio: number }[] = [];

  for (const record of records) {
    if (excludeIds?.has(record.id)) continue;

    const ratio = keywordIntersectionRatio(lineKeywords, record.keywords);
    if (ratio > 0) {
      candidates.push({ record, ratio });
    }
  }

  candidates.sort((a, b) => b.ratio - a.ratio);

  return candidates.slice(0, 3).map(({ record, ratio }) =>
    toMatchResult(record, "high", ratio),
  );
}
