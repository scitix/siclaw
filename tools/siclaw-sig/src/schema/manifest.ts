import { z } from "zod";

const StatsSchema = z.object({
  total_templates: z.number().int().nonnegative(),
  by_level: z.object({
    error: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }),
  by_style: z.object({
    printf: z.number().int().nonnegative(),
    structured: z.number().int().nonnegative(),
  }),
  extraction_duration_ms: z.number().nonnegative(),
});

export const ManifestSchema = z.object({
  schema_version: z.string(),
  component: z.string(),
  source_version: z.string(),
  language: z.string(),
  extraction_timestamp: z.string(),
  rules: z.array(z.string()),
  stats: StatsSchema,
}).strip();

export type Manifest = z.infer<typeof ManifestSchema>;
