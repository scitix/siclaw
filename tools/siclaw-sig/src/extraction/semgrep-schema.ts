/**
 * Zod schemas for validating Semgrep JSON output (`semgrep --json`).
 *
 * Schemas use `.strip()` to tolerate extra fields from future Semgrep versions.
 */

import { z } from "zod";

/** Position within a source file. */
export const SemgrepPositionSchema = z.object({
  line: z.number(),
  col: z.number(),
  offset: z.number(),
});

/** A captured metavariable with its source range and content. */
export const SemgrepMetavarSchema = z.object({
  start: SemgrepPositionSchema,
  end: SemgrepPositionSchema,
  abstract_content: z.string(),
}).strip();

/** Extra data attached to each match. */
export const SemgrepExtraSchema = z.object({
  message: z.string(),
  metadata: z.record(z.unknown()).optional(),
  severity: z.string(),
  lines: z.string(),
  metavars: z.record(SemgrepMetavarSchema).optional(),
  is_ignored: z.boolean().optional(),
}).strip();

/** A single Semgrep match result. */
export const SemgrepMatchSchema = z.object({
  check_id: z.string(),
  path: z.string(),
  start: SemgrepPositionSchema,
  end: SemgrepPositionSchema,
  extra: SemgrepExtraSchema,
}).strip();

/** A Semgrep error entry. */
export const SemgrepErrorSchema = z.object({
  message: z.string(),
  level: z.string().optional(),
  type: z.string().optional(),
}).strip();

/** Top-level Semgrep JSON output envelope. */
export const SemgrepOutputSchema = z.object({
  version: z.string().optional(),
  results: z.array(SemgrepMatchSchema),
  errors: z.array(SemgrepErrorSchema).optional(),
  paths: z.object({
    scanned: z.array(z.string()),
  }).strip().optional(),
}).strip();

/** Inferred types from schemas. */
export type SemgrepPosition = z.infer<typeof SemgrepPositionSchema>;
export type SemgrepMetavar = z.infer<typeof SemgrepMetavarSchema>;
export type SemgrepExtra = z.infer<typeof SemgrepExtraSchema>;
export type SemgrepMatch = z.infer<typeof SemgrepMatchSchema>;
export type SemgrepError = z.infer<typeof SemgrepErrorSchema>;
export type SemgrepOutput = z.infer<typeof SemgrepOutputSchema>;
