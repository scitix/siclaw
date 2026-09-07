import type { Db } from "../gateway/db.js";
import { jsonScalarOrNull } from "../gateway/dialect-helpers.js";

/** Keep transcript rows, including legacy rows with NULL metadata. Shared by
 * chat pagination/count and task-run traces so hidden rows never use the limit.
 * Read JSON paths, not serialized substrings: nested kinds are not row kinds.
 */
export function transcriptVisiblePredicate(db: Db): string {
  const kind = jsonScalarOrNull(db, "metadata", "$.kind");
  const call = jsonScalarOrNull(db, "metadata", "$.llm_call");
  return `NOT (COALESCE(${kind}, '') = 'thinking'
    OR (role = 'assistant' AND TRIM(COALESCE(content, '')) = ''
      AND COALESCE(${kind}, '') = '' AND ${call} IS NOT NULL))`;
}
