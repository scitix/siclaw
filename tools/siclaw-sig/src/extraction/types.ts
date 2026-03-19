/**
 * Core types for the Semgrep extraction pipeline.
 *
 * Phase 3: ExtractionResult is the intermediate representation between
 * raw Semgrep output and the final SigRecord (Phase 4).
 */

import { z } from "zod";

/** Normalized log level across all frameworks. */
export type LogLevel = "error" | "warning" | "info" | "debug" | "fatal";

/** Log call style: printf-style format strings or structured key-value pairs. */
export type LogStyle = "printf" | "structured";

/** A single extraction result from a Semgrep match. */
export interface ExtractionResult {
  /** Semgrep rule ID, e.g. "siclaw.go.klog-printf" */
  ruleId: string;
  /** Logging framework, e.g. "klog", "logr", "zap" */
  framework: string;
  /** Log call style */
  style: LogStyle;
  /** Normalized log level */
  level: LogLevel;
  /** Source file path relative to scan root */
  file: string;
  /** Line number of the match */
  line: number;
  /** Format string or message, quote-stripped */
  template: string;
  /** Raw key-value text for structured style, null for printf */
  kvRaw: string | null;
  /** Full matched source line(s) */
  matchedCode: string;
  /** All captured metavariables (key = metavar name like "$FMT", value = abstract_content) */
  metavars: Record<string, string>;
}

/** Zod schema matching ExtractionResult. */
export const ExtractionResultSchema = z.object({
  ruleId: z.string(),
  framework: z.string(),
  style: z.enum(["printf", "structured"]),
  level: z.enum(["error", "warning", "info", "debug", "fatal"]),
  file: z.string(),
  line: z.number().int().positive(),
  template: z.string(),
  kvRaw: z.string().nullable(),
  matchedCode: z.string(),
  metavars: z.record(z.string()),
}).strip();

/** Aggregate output from an extraction run. */
export interface ExtractionOutput {
  /** All successfully mapped extraction results */
  results: ExtractionResult[];
  /** Error messages from Semgrep or mapping failures */
  errors: string[];
  /** List of files that were scanned */
  scannedFiles: string[];
}
