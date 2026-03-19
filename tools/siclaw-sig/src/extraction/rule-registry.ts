/**
 * Rule registry — discovers built-in Semgrep rules by language directory
 * and merges user-supplied custom rules. Top-level extraction API.
 */

import { readdir } from "node:fs/promises";
import { accessSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSemgrep } from "./semgrep-runner.js";
import type { ExtractionOutput } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const RULES_BASE_DIR = path.resolve(path.dirname(__filename), "../../rules");

const SUPPORTED_LANGUAGES = ["go", "python", "java", "rust", "bash"] as const;

/** Languages with built-in Semgrep rule sets. */
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Discovers all built-in Semgrep rule files for a given language.
 *
 * Reads the `rules/<language>/` directory and returns absolute paths
 * to all `.yaml` / `.yml` files, sorted alphabetically.
 *
 * @param language - Target language (must be in SUPPORTED_LANGUAGES)
 * @returns Sorted array of absolute paths to rule YAML files
 * @throws If language is unsupported or the rules directory does not exist
 */
export async function discoverBuiltinRules(language: string): Promise<string[]> {
  if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(language)) {
    throw new Error(
      `Unsupported language "${language}". Supported: ${SUPPORTED_LANGUAGES.join(", ")}`,
    );
  }

  const dirPath = path.join(RULES_BASE_DIR, language);

  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    throw new Error(
      `No rules directory found for language "${language}" at ${dirPath}`,
    );
  }

  return entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .map((f) => path.join(dirPath, f));
}

/**
 * Resolves and validates user-provided rule file paths.
 *
 * Each pattern is resolved to an absolute path and checked for existence.
 *
 * @param patterns - Array of user rule file paths (absolute or relative)
 * @returns Array of resolved absolute paths
 * @throws If any file does not exist
 */
export function resolveUserRulePaths(patterns: string[]): string[] {
  return patterns.map((p) => {
    const resolvedPath = path.resolve(p);
    try {
      accessSync(resolvedPath);
    } catch {
      throw new Error(`User rule file not found: ${resolvedPath}`);
    }
    return resolvedPath;
  });
}

/**
 * Builds the complete list of rule file paths for an extraction run.
 *
 * Combines built-in rules (discovered by language) with optional user-supplied
 * rule files. Built-in rules come first, user rules are appended.
 *
 * @param language - Target language
 * @param userRulePatterns - Optional array of user rule file paths
 * @returns Combined array of absolute rule file paths
 */
export async function buildRulePaths(
  language: string,
  userRulePatterns?: string[],
): Promise<string[]> {
  const builtinPaths = await discoverBuiltinRules(language);

  if (userRulePatterns && userRulePatterns.length > 0) {
    const userPaths = resolveUserRulePaths(userRulePatterns);
    return [...builtinPaths, ...userPaths];
  }

  return builtinPaths;
}

/**
 * Top-level extraction API — runs the full Semgrep pipeline.
 *
 * Discovers rules for the given language, optionally merges user rules,
 * invokes Semgrep, and returns the mapped extraction output.
 *
 * This is the primary entry point for Phase 4 (CLI) and downstream consumers:
 * ```typescript
 * import { extractLogs } from "siclaw-sig/extraction";
 * const output = await extractLogs({ language: "go", srcPath: "./src" });
 * ```
 *
 * @param options.language - Target language (e.g. "go")
 * @param options.srcPath - Path to source directory to scan
 * @param options.userRulePatterns - Optional additional rule file paths
 * @param options.timeoutMs - Optional Semgrep timeout in milliseconds
 * @returns ExtractionOutput with results, errors, and scanned files
 */
export async function extractLogs(options: {
  language: string;
  srcPath: string;
  userRulePatterns?: string[];
  timeoutMs?: number;
}): Promise<ExtractionOutput> {
  const rulePaths = await buildRulePaths(
    options.language,
    options.userRulePatterns,
  );

  return runSemgrep({
    rulePaths,
    srcPath: options.srcPath,
    timeoutMs: options.timeoutMs,
    language: options.language,
  });
}
