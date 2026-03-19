/**
 * Maps Semgrep match results to ExtractionResult.
 *
 * Handles quote stripping, log level detection, and metavar flattening.
 */

import type { SemgrepMatch, SemgrepOutput } from "./semgrep-schema.js";
import type { ExtractionResult, ExtractionOutput, LogLevel } from "./types.js";

/**
 * Strips surrounding Go string literal quotes from a Semgrep-captured content string.
 *
 * Semgrep captures Go string literals with their quotes intact, e.g. `"hello %s"`.
 * This function removes the outer quotes and unescapes inner escaped quotes.
 */
export function stripGoQuotes(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\"/g, '"');
  }
  return raw;
}

/**
 * Strips surrounding Python string literal quotes.
 * Handles f-string/r-string/b-string/u-string prefixes, triple quotes, and single/double quotes.
 */
export function stripPythonQuotes(raw: string): string {
  let s = raw;
  if (/^[fFrRbBuU]{0,2}["']/.test(s)) {
    s = s.replace(/^[fFrRbBuU]+/, "");
  }
  // Triple quotes
  if ((s.startsWith('"""') && s.endsWith('"""')) || (s.startsWith("'''") && s.endsWith("'''"))) {
    return s.slice(3, -3);
  }
  // Single/double quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\(['"])/g, "$1");
  }
  return s;
}

/**
 * Strips surrounding Java string literal quotes (double quotes only).
 */
export function stripJavaQuotes(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\"/g, '"');
  }
  return raw;
}

/**
 * Strips surrounding Rust string literal quotes.
 * Handles raw strings r#"..."#, r##"..."##, etc. and normal double quotes.
 */
export function stripRustQuotes(raw: string): string {
  // Raw strings: r#"..."#, r##"..."##, etc.
  const rawMatch = raw.match(/^r(#+)"(.*)"\1$/s);
  if (rawMatch) return rawMatch[2];
  // Normal double quotes
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\"/g, '"');
  }
  return raw;
}

/**
 * Strips surrounding Bash string literal quotes.
 * Double quotes: removes outer quotes (interpolation preserved).
 * Single quotes: removes outer quotes (no escaping in bash single quotes).
 */
export function stripBashQuotes(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  // Single quotes: no escaping in bash
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Language-aware quote stripping dispatch.
 */
export function stripQuotes(raw: string, language: string): string {
  switch (language) {
    case "go": return stripGoQuotes(raw);
    case "python": return stripPythonQuotes(raw);
    case "java": return stripJavaQuotes(raw);
    case "rust": return stripRustQuotes(raw);
    case "bash": return stripBashQuotes(raw);
    default: return raw;
  }
}

/** Maps log function names to normalized log levels (all languages). */
const FUNCTION_LEVEL_MAP: Record<string, LogLevel> = {
  // Go — klog printf
  Infof: "info",
  Warningf: "warning",
  Errorf: "error",
  Fatalf: "fatal",
  // Go — klog structured
  InfoS: "info",
  ErrorS: "error",
  // Go — logr
  Info: "info",
  Warn: "warning",
  Error: "error",
  Debug: "debug",
  Fatal: "fatal",
  // Go — zap sugar printf
  Warnf: "warning",
  // Go — zap sugar structured
  Infow: "info",
  Warnw: "warning",
  Errorw: "error",
  // Python logging
  error: "error",
  warning: "warning",
  info: "info",
  debug: "debug",
  critical: "fatal",
  // Java SLF4J/Log4j2 (error, info, debug already covered above)
  warn: "warning",
};

/**
 * Detects the log level from matched code and metadata.
 *
 * Priority: metadata.level (if present) > function name from matchedCode > default "info".
 */
export function detectLevel(
  matchedCode: string,
  metadata: Record<string, unknown>,
): LogLevel {
  // Metadata takes precedence
  if (typeof metadata["level"] === "string") {
    return metadata["level"] as LogLevel;
  }

  // Scan matched code for function name — Go, Python, Java
  const funcPattern =
    /\.(Infof|Warningf|Errorf|Fatalf|InfoS|ErrorS|Info|Warn|Error|Debug|Fatal|Warnf|Infow|Warnw|Errorw|error|warning|info|debug|critical|warn)\(/;
  const match = funcPattern.exec(matchedCode);
  if (match) {
    const funcName = match[1]!;
    const level = FUNCTION_LEVEL_MAP[funcName];
    if (level) return level;
  }

  // Rust macros: error!(...), warn!(...), info!(...), debug!(...), trace!(...)
  const rustMacroPattern = /\b(error|warn|info|debug|trace)!\(/;
  const rustMatch = rustMacroPattern.exec(matchedCode);
  if (rustMatch) {
    const macroName = rustMatch[1]!;
    const rustLevels: Record<string, LogLevel> = {
      error: "error", warn: "warning", info: "info", debug: "debug", trace: "debug",
    };
    const level = rustLevels[macroName];
    if (level) return level;
  }

  // Bash logger: logger -p user.err "..."
  const bashLoggerPattern = /logger.*-p\s+\w+\.(err|warning|info|debug)/;
  const bashMatch = bashLoggerPattern.exec(matchedCode);
  if (bashMatch) {
    const bashPriority = bashMatch[1]!;
    const bashLevels: Record<string, LogLevel> = {
      err: "error", warning: "warning", info: "info", debug: "debug",
    };
    const level = bashLevels[bashPriority];
    if (level) return level;
  }

  return "info";
}

/**
 * Maps a single Semgrep match to an ExtractionResult.
 *
 * Fails fast if required metadata (framework, style) is missing.
 */
export function mapSemgrepMatch(match: SemgrepMatch, language?: string): ExtractionResult {
  const metadata = match.extra.metadata ?? {};

  const framework = metadata["framework"];
  if (typeof framework !== "string") {
    throw new Error(
      `Missing metadata.framework in rule ${match.check_id} at ${match.path}:${match.start.line}`,
    );
  }

  const style = metadata["style"];
  if (style !== "printf" && style !== "structured") {
    throw new Error(
      `Missing or invalid metadata.style in rule ${match.check_id} at ${match.path}:${match.start.line}`,
    );
  }

  const metavars = match.extra.metavars ?? {};

  // Flatten metavars to key -> abstract_content
  const flatMetavars: Record<string, string> = {};
  for (const [key, val] of Object.entries(metavars)) {
    flatMetavars[key] = val.abstract_content;
  }

  // Extract template from $FMT or $MSG metavar
  let template: string;
  if (metavars["$FMT"]) {
    template = stripQuotes(metavars["$FMT"].abstract_content, language ?? "go");
  } else if (metavars["$MSG"]) {
    template = stripQuotes(metavars["$MSG"].abstract_content, language ?? "go");
  } else {
    throw new Error(
      `No $FMT or $MSG metavar in rule ${match.check_id} at ${match.path}:${match.start.line}`,
    );
  }

  // Extract kvRaw from $...KVPAIRS if present
  const kvRaw = metavars["$...KVPAIRS"]?.abstract_content ?? null;

  return {
    ruleId: match.check_id,
    framework,
    style,
    level: detectLevel(match.extra.lines, metadata),
    file: match.path,
    line: match.start.line,
    template,
    kvRaw,
    matchedCode: match.extra.lines,
    metavars: flatMetavars,
  };
}

/**
 * Maps the full Semgrep output to an ExtractionOutput.
 *
 * Individual match mapping errors are collected in `errors` rather than
 * aborting the entire run.
 */
export function mapSemgrepOutput(output: SemgrepOutput, language?: string): ExtractionOutput {
  const results: ExtractionResult[] = [];
  const errors: string[] = [];

  // Collect Semgrep-reported errors
  if (output.errors) {
    for (const err of output.errors) {
      errors.push(err.message);
    }
  }

  // Map each match
  for (const match of output.results) {
    try {
      results.push(mapSemgrepMatch(match, language));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  const scannedFiles = output.paths?.scanned ?? [];

  return { results, errors, scannedFiles };
}
