/**
 * .sig format schema — shared contract for siclaw-sig CLI and lookup_log_source tool.
 *
 * Exports Zod schemas + inferred TypeScript types for:
 * - SigRecord (templates.jsonl record)
 * - Manifest (manifest.yaml)
 * - computeSigId() utility
 */

export {
  SigRecordSchema,
  type SigRecord,
  STYLES,
  CONFIDENCE_LEVELS,
  LOG_LEVELS,
} from "./record.js";

export {
  ManifestSchema,
  type Manifest,
} from "./manifest.js";

export { computeSigId } from "./id.js";
