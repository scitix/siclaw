/**
 * JSONL emitter — transforms ExtractionResult arrays into validated SigRecord
 * JSONL output for .sig packages.
 *
 * Phase 4, Plan 02: Wires together context builder, format parser, keyword
 * extractor, and ID generator to produce the final SigRecord output.
 */

import { ContextBuilder } from "./context-builder.js";
import { parseGoFormat } from "../parser/go-format.js";
import { extractKeywords } from "../parser/keywords.js";
import { computeSigId } from "../schema/id.js";
import { SigRecordSchema, type SigRecord } from "../schema/record.js";
import type { ExtractionResult } from "../extraction/types.js";

export interface EmitterOptions {
  component: string;
  version: string;
  srcPath: string;
}

export interface EmitResult {
  records: SigRecord[];
  errors: string[];
}

/**
 * Transform extraction results into validated SigRecords.
 *
 * Each result is enriched with source context, regex pattern, keywords,
 * and a deterministic content-hash ID. Records that fail context building
 * or schema validation are skipped with an error message collected in
 * the returned errors array.
 */
export async function emitRecords(
  results: ExtractionResult[],
  options: EmitterOptions,
): Promise<EmitResult> {
  const contextBuilder = new ContextBuilder(options.srcPath);
  const records: SigRecord[] = [];
  const errors: string[] = [];

  for (const result of results) {
    // Build source context (package, function, surrounding lines)
    let context;
    try {
      context = await contextBuilder.build(result.file, result.line);
    } catch (err) {
      errors.push(`${result.file}:${result.line}: ${(err as Error).message}`);
      continue;
    }

    // Parse format string for regex and confidence
    const { regex, confidence } = parseGoFormat(result.template);

    // Extract searchable keywords
    const keywords = extractKeywords(result.template);

    // Compute deterministic ID
    const id = computeSigId(result.file, result.line, result.template);

    // Construct the SigRecord
    const record: SigRecord = {
      id,
      component: options.component,
      version: options.version,
      file: result.file,
      line: result.line,
      function: context.function,
      level: result.level,
      template: result.template,
      style: result.style,
      confidence,
      regex,
      keywords,
      context: {
        package: context.package,
        function: context.function,
        source_lines: context.source_lines,
        line_range: context.line_range,
      },
      error_conditions: null,
      related_logs: null,
    };

    // Validate against schema — skip on failure
    try {
      SigRecordSchema.parse(record);
    } catch (err) {
      errors.push(`${result.file}:${result.line}: Schema validation failed: ${(err as Error).message}`);
      continue;
    }

    records.push(record);
  }

  return { records, errors };
}

/**
 * Serialize SigRecords to JSONL format (one JSON object per line).
 *
 * @returns JSONL string with trailing newline, or empty string for empty array
 */
export function recordsToJsonl(records: SigRecord[]): string {
  if (records.length === 0) return "";
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
