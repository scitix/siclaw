/**
 * Types for the format string parser.
 *
 * Shared between the Go format parser (Phase 2) and future language parsers (Phase 5).
 */

import type { SigRecord } from "../schema/record.js";

/** Confidence level — re-exported from schema for parser consumers. */
export type Confidence = SigRecord["confidence"];

/** A single parsed format verb from a format string. */
export interface ParsedVerb {
  /** The full verb string as found in the format string, e.g. "%10.2f", "%v", "%s" */
  raw: string;
  /** The base verb character: "s", "d", "f", "x", "q", "v", "w", or "%" for literal %% */
  verb: string;
  /** The regex pattern this verb maps to, e.g. "(.*)", "(-?\\d+)" */
  pattern: string;
  /** Whether this verb produces a precise regex (true) or a greedy fallback (false) */
  precise: boolean;
}

/** Result of parsing a format string into a regex + metadata. */
export interface FormatParseResult {
  /** The compiled regex pattern, or null if the template should use keyword-only matching. */
  regex: string | null;
  /** Confidence level of the match: "exact", "high", or "medium". */
  confidence: Confidence;
  /** All verbs found in the format string, in order. */
  verbs: ParsedVerb[];
}
