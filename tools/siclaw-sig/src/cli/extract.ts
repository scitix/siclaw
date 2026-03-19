/**
 * Extract command handler — validates inputs, runs the extraction pipeline,
 * and writes .sig package output files (templates.jsonl + manifest.yaml).
 */

import { stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractLogs } from "../extraction/rule-registry.js";
import { emitRecords, recordsToJsonl } from "../pipeline/emitter.js";
import { buildManifest, manifestToYaml } from "../pipeline/manifest.js";

export interface ExtractOptions {
  src: string;
  lang: string;
  output: string;
  version: string;
  component: string;
  logPatterns: string[];
}

export async function runExtract(options: ExtractOptions): Promise<void> {
  // Validate inputs at boundary (fail-fast)
  const srcStat = await stat(options.src).catch(() => null);
  if (!srcStat?.isDirectory()) {
    throw new Error(`--src path is not a directory: ${options.src}`);
  }

  // Create output directory if it does not exist
  await mkdir(options.output, { recursive: true });

  // Record start time
  const startMs = Date.now();

  // Run extraction
  const extraction = await extractLogs({
    language: options.lang,
    srcPath: options.src,
    userRulePatterns: options.logPatterns.length > 0 ? options.logPatterns : undefined,
  });

  // Check for results
  if (extraction.results.length === 0) {
    console.warn("No log templates found. Check --src path and --lang setting.");
    if (extraction.errors.length > 0) {
      console.warn("Extraction errors:", extraction.errors.join("\n"));
    }
  }

  // Emit records
  const emitResult = await emitRecords(extraction.results, {
    component: options.component,
    version: options.version,
    srcPath: options.src,
    language: options.lang,
  });

  // Collect rule IDs from extraction results
  const ruleIds = [...new Set(extraction.results.map((r) => r.ruleId))];

  // Build manifest
  const manifest = buildManifest(emitResult.records, {
    component: options.component,
    sourceVersion: options.version,
    language: options.lang,
    ruleIds,
    extractionDurationMs: Date.now() - startMs,
  });

  // Write output files
  const jsonlPath = path.join(options.output, "templates.jsonl");
  const manifestPath = path.join(options.output, "manifest.yaml");

  await writeFile(jsonlPath, recordsToJsonl(emitResult.records), "utf-8");
  await writeFile(manifestPath, manifestToYaml(manifest), "utf-8");

  // Print summary to stdout
  console.log(`Extracted ${emitResult.records.length} log templates from ${extraction.scannedFiles.length} files`);
  console.log(`Output: ${options.output}/`);
  if (emitResult.errors.length > 0) {
    console.warn(`${emitResult.errors.length} record(s) skipped due to errors`);
  }
}
