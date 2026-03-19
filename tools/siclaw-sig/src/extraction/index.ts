/**
 * Semgrep extraction engine — CLI wrapper, JSON parsing, result mapping.
 *
 * Phase 3: Go logging framework extraction.
 * Phase 4 consumes ExtractionResult to produce SigRecord.
 */

export type { ExtractionResult, ExtractionOutput, LogLevel, LogStyle } from "./types.js";
export { ExtractionResultSchema } from "./types.js";
export { runSemgrep, checkSemgrepVersion, compareVersions } from "./semgrep-runner.js";
export type { RunSemgrepOptions } from "./semgrep-runner.js";
export { mapSemgrepMatch, mapSemgrepOutput, stripGoQuotes, detectLevel } from "./result-mapper.js";
export { SemgrepOutputSchema, SemgrepMatchSchema } from "./semgrep-schema.js";
export type { SemgrepOutput, SemgrepMatch } from "./semgrep-schema.js";
export {
  discoverBuiltinRules,
  resolveUserRulePaths,
  buildRulePaths,
  extractLogs,
} from "./rule-registry.js";
export type { SupportedLanguage } from "./rule-registry.js";
