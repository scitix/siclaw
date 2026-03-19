/**
 * Manifest generator — produces manifest.yaml content from extraction
 * metadata and CLI flags.
 *
 * Phase 4, Plan 02: Aggregates stats from SigRecords and combines with
 * component metadata to produce a validated Manifest object.
 */

import { ManifestSchema, type Manifest } from "../schema/manifest.js";
import type { SigRecord } from "../schema/record.js";
import yaml from "js-yaml";

export interface ManifestOptions {
  component: string;
  sourceVersion: string;
  language: string;
  ruleIds: string[];
  extractionDurationMs: number;
}

/**
 * Build a Manifest from emitted SigRecords and CLI options.
 *
 * Computes per-level and per-style counts, attaches extraction metadata,
 * and validates the result against ManifestSchema before returning.
 */
export function buildManifest(records: SigRecord[], options: ManifestOptions): Manifest {
  const byLevel = { error: 0, warning: 0, info: 0 };
  const byStyle = { printf: 0, structured: 0 };

  for (const r of records) {
    if (r.level in byLevel) byLevel[r.level as keyof typeof byLevel]++;
    if (r.style in byStyle) byStyle[r.style as keyof typeof byStyle]++;
  }

  const manifest: Manifest = {
    schema_version: "1.0",
    component: options.component,
    source_version: options.sourceVersion,
    language: options.language,
    extraction_timestamp: new Date().toISOString(),
    rules: options.ruleIds,
    stats: {
      total_templates: records.length,
      by_level: byLevel,
      by_style: byStyle,
      extraction_duration_ms: options.extractionDurationMs,
    },
  };

  ManifestSchema.parse(manifest);
  return manifest;
}

/**
 * Serialize a Manifest object to YAML string.
 */
export function manifestToYaml(manifest: Manifest): string {
  return yaml.dump(manifest, { lineWidth: -1, sortKeys: false, noRefs: true });
}
