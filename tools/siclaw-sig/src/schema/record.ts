import { z } from "zod";

export const STYLES = ["printf", "structured"] as const;
export const CONFIDENCE_LEVELS = ["exact", "high", "medium"] as const;
export const LOG_LEVELS = ["error", "warning", "info", "debug", "trace", "fatal"] as const;

const ContextSchema = z.object({
  package: z.string(),
  function: z.string(),
  source_lines: z.array(z.string()),
  line_range: z.tuple([z.number(), z.number()]),
});

export const SigRecordSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  component: z.string(),
  version: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  function: z.string(),
  level: z.enum(LOG_LEVELS),
  template: z.string(),
  style: z.enum(STYLES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  regex: z.string().nullable(),
  keywords: z.array(z.string()),
  context: ContextSchema,
  error_conditions: z.array(z.string()).nullable(),
  related_logs: z.array(z.string()).nullable(),
}).strip();

export type SigRecord = z.infer<typeof SigRecordSchema>;
