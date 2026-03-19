/**
 * Semgrep CLI wrapper — version check, invocation, JSON parsing.
 *
 * Uses `node:child_process` `execFile` (no shell) to avoid injection risks.
 */

import { execFile } from "node:child_process";
import { SemgrepOutputSchema } from "./semgrep-schema.js";
import { mapSemgrepOutput } from "./result-mapper.js";
import type { ExtractionOutput } from "./types.js";

const MIN_SEMGREP_VERSION = "1.50.0";

/** Options for running Semgrep. */
export interface RunSemgrepOptions {
  /** Paths to Semgrep rule files or directories. */
  rulePaths: string[];
  /** Path to the source directory to scan. */
  srcPath: string;
  /** Timeout in milliseconds. Default: 300_000 (5 minutes). */
  timeoutMs?: number;
  /** Target language for language-aware result mapping. */
  language?: string;
}

/** Wraps execFile in a promise returning {stdout, stderr}. */
function exec(
  cmd: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        // Attach stdout/stderr to the error for downstream inspection
        Object.assign(err, { stdout, stderr });
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Compares two semver-style version strings.
 *
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const segA = partsA[i] ?? 0;
    const segB = partsB[i] ?? 0;
    if (segA !== segB) return segA - segB;
  }
  return 0;
}

/**
 * Checks that Semgrep is installed and meets the minimum version requirement.
 *
 * @returns The detected Semgrep version string.
 * @throws If Semgrep is not found or version is below minimum.
 */
export async function checkSemgrepVersion(): Promise<string> {
  let stdout: string;
  try {
    const result = await exec("semgrep", ["--version"]);
    stdout = result.stdout;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(
        "semgrep not found. Install with: pip install semgrep (requires Python 3.8+)",
      );
    }
    throw err;
  }

  const version = stdout.trim();
  if (compareVersions(version, MIN_SEMGREP_VERSION) < 0) {
    throw new Error(
      `Semgrep version ${version} is below minimum ${MIN_SEMGREP_VERSION}. Upgrade with: pip install --upgrade semgrep`,
    );
  }

  return version;
}

/**
 * Runs Semgrep with the given rules against a source path.
 *
 * Validates the version, invokes the CLI with `--json`, parses output through
 * the Zod schema, and maps results to ExtractionOutput.
 */
export async function runSemgrep(
  options: RunSemgrepOptions,
): Promise<ExtractionOutput> {
  const { rulePaths, srcPath, timeoutMs = 300_000, language } = options;

  await checkSemgrepVersion();

  const args = [
    ...rulePaths.flatMap((p) => ["--config", p]),
    "--json",
    "--no-git-ignore",
    srcPath,
  ];

  let stdout: string;
  try {
    const result = await exec("semgrep", args, { timeout: timeoutMs });
    stdout = result.stdout;
  } catch (err: unknown) {
    if (err instanceof Error && "killed" in err && (err as { killed: boolean }).killed) {
      throw new Error(`Semgrep timed out after ${timeoutMs}ms`);
    }
    if (err instanceof Error && "stderr" in err) {
      const stderr = (err as { stderr: string }).stderr;
      if (stderr) {
        throw new Error(`Semgrep failed: ${stderr}`);
      }
    }
    throw err;
  }

  const json: unknown = JSON.parse(stdout);
  const parsed = SemgrepOutputSchema.parse(json);
  return mapSemgrepOutput(parsed, language);
}
