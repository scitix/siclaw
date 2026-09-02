/**
 * Which `role='user'` rows the Prompts figure counts.
 *
 * Companion to {@link ./session-origin.ts} on the other axis: that one asks
 * whether the SESSION is a conversation or an execution trace, this one asks
 * whether the ROW is a person's question or the runtime writing to itself.
 * Both are needed — synthetic rows land in ordinary user sessions, so the
 * origin filter never sees them.
 *
 * The vocabulary lives in `shared/message-kinds.ts` because the runtime writes
 * these values; only the SQL lives here, because it needs the database driver.
 */

import type { Db } from "../gateway/db.js";
import { jsonScalarOrNull } from "../gateway/dialect-helpers.js";
import { SYNTHETIC_USER_KINDS } from "../shared/message-kinds.js";

/**
 * SQL predicate keeping only `role='user'` rows a person actually wrote.
 *
 * Reads `metadata.kind` through JSON rather than matching the serialized column
 * with LIKE. The predicate this replaces was `metadata NOT LIKE
 * '%"kind":"delegation_event"%'`, which depended on the exact serialized shape
 * (no space after the colon) and matched anywhere in the column — so a row whose
 * metadata merely mentioned a kind name in some unrelated field was dropped from
 * the count.
 *
 * Dialect-aware through `jsonScalarOrNull`, and that is not optional: the first
 * version of this predicate hardcoded MySQL's `JSON_UNQUOTE`, which SQLite does
 * not have, and every metrics endpoint 500'd under `siclaw local`. Any change
 * here must keep the SQLite execution test in `human-prompt.test.ts` passing —
 * asserting on the string alone is what missed it.
 *
 * Rows with no metadata, unparseable metadata, or no `kind` at all are KEPT:
 * a plain question carries no kind, and that is the common case, not an edge
 * one. They reach the comparison as NULL, and COALESCE — rather than a second
 * copy of the extraction under an `IS NULL` arm — is what lets the JSON be
 * parsed once per row instead of twice.
 */
export function humanPromptPredicate(db: Db, alias: "m" | "msg" | "" = "m"): string {
  const column = alias ? `${alias}.metadata` : "metadata";
  const kind = jsonScalarOrNull(db, column, "$.kind");
  const list = SYNTHETIC_USER_KINDS.map((k) => `'${k}'`).join(", ");
  return `(COALESCE(${kind}, '') NOT IN (${list}))`;
}
