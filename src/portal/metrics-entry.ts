/**
 * Entry-form axis for audit / metrics filtering.
 *
 * Mirrors `chat_sessions.origin`, which records how a session was created:
 *   web     → origin IS NULL   (Portal Web UI — the default)
 *   api     → origin = 'api'   (external API key, /api/v1/run)
 *   a2a     → origin = 'a2a'   (agent-to-agent)
 *   channel → origin = 'channel' (IM channels: Feishu / DingTalk)
 *   scheduled → origin = 'task'   (cron / scheduled runs)
 *   (delegation → origin = 'delegation' — sub-agent execution traces, never a
 *    top-level entry; its tool calls inherit the PARENT session's entry.)
 *
 * The audit UI can view one entry at a time or the combined **overview**
 * ("all" = web+api+a2a+channel, the interactive family; scheduled is its own
 * selectable bucket).
 *
 * Two predicate flavours:
 *  - session-level (`entrySessionPredicate`): for per-session queries (session
 *    list, session/prompt counts). Delegation sessions are excluded (traces).
 *  - message-level (`entryMessagePredicate`): for per-message/tool queries
 *    (tool audit, tool counts, timing). A delegation child's rows are counted
 *    under its parent's entry via a LEFT JOIN on the parent session.
 */

export type EntryMode = "all" | "web" | "api" | "a2a" | "channel" | "scheduled";

/** The user-selectable entry buckets (excludes the internal "delegation"). */
export const ENTRY_MODES: readonly EntryMode[] = ["all", "web", "api", "a2a", "channel", "scheduled"];

/**
 * Coerce a raw `entry`/`source` query value to an EntryMode. Accepts the entry
 * modes and `source` aliases ("interactive" → overview, "scheduled" →
 * scheduled). Unknown / empty → "all" (overview).
 */
export function normalizeEntry(raw: string | null | undefined): EntryMode {
  if (!raw) return "all";
  if (raw === "interactive") return "all"; // alias: interactive == overview here
  if (raw === "task") return "scheduled";  // accept the raw origin value as an alias
  return (ENTRY_MODES as readonly string[]).includes(raw) ? (raw as EntryMode) : "all";
}

/**
 * Base origin predicate for one session alias, with NO delegation handling.
 * "all" (overview) = the interactive family (web+api+a2a+channel): everything
 * except scheduled (`task`) and `delegation` traces.
 */
function baseOriginPredicate(entry: EntryMode, alias: string): string {
  switch (entry) {
    case "web": return `${alias}.origin IS NULL`;
    case "api": return `${alias}.origin = 'api'`;
    case "a2a": return `${alias}.origin = 'a2a'`;
    case "channel": return `${alias}.origin = 'channel'`;
    case "scheduled": return `${alias}.origin = 'task'`;
    case "all":
    default: return `(${alias}.origin IS NULL OR ${alias}.origin NOT IN ('task', 'delegation'))`;
  }
}

/**
 * Session-level predicate (per-session queries). Excludes delegation traces.
 * Returns a parenthesized SQL fragment over the given session alias (default "s").
 */
export function entrySessionPredicate(entry: EntryMode, alias = "s"): string {
  return `(${baseOriginPredicate(entry, alias)})`;
}

/**
 * Message-level predicate (per-message / per-tool queries) WITH delegation
 * inheritance: a delegation child session's rows count under the parent's entry.
 *
 * Returns:
 *  - `join`: a LEFT JOIN clause binding `parentAlias` to `sAlias`'s parent
 *    session (empty string if inheritance is disabled).
 *  - `predicate`: a parenthesized fragment to AND into the WHERE clause.
 *
 * With inheritance: `<entry on s> OR (s.origin='delegation' AND <entry on parent_s>)`.
 */
export function entryMessagePredicate(
  entry: EntryMode,
  opts: { sAlias?: string; parentAlias?: string; delegationInheritance?: boolean } = {},
): { join: string; predicate: string } {
  const sAlias = opts.sAlias ?? "s";
  const parentAlias = opts.parentAlias ?? "parent_s";
  const inherit = opts.delegationInheritance !== false; // default ON

  if (!inherit) {
    return { join: "", predicate: entrySessionPredicate(entry, sAlias) };
  }

  const join = `LEFT JOIN chat_sessions ${parentAlias} ON ${sAlias}.parent_session_id = ${parentAlias}.id`;
  const predicate =
    `(${baseOriginPredicate(entry, sAlias)} ` +
    `OR (${sAlias}.origin = 'delegation' AND ${baseOriginPredicate(entry, parentAlias)}))`;
  return { join, predicate };
}
