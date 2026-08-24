/**
 * `chat_sessions.origin` classification — the SINGLE answer to "is this row a
 * conversation somebody started, or a trace of how one was executed".
 *
 * The column records how a session came to exist:
 *   web       → origin IS NULL     (Portal Web UI — the default)
 *   api       → origin = 'api'     (external API key, /api/v1/run)
 *   a2a       → origin = 'a2a'     (agent-to-agent)
 *   channel   → origin = 'channel' (IM channels: Feishu / DingTalk)
 *   scheduled → origin = 'task'    (cron / scheduled runs)
 *   delegation → origin = 'delegation' (coordinator → peer agent; the PEER's turn)
 *   subagent   → origin = 'subagent'   (an agent's own spawn_subagent child)
 *
 * ⚠️ `delegation` and `subagent` are DIFFERENT THINGS and both are traces.
 * Delegation hands a request to ANOTHER agent, which runs under its own
 * configuration; a sub-agent is one agent's internal way of isolating context
 * for part of its own work. They are separate mechanisms with separate origins —
 * the overloaded word "delegation" (a sub-agent's spawn id is carried as
 * `delegation_id`, and its persistence rides `delegation-persistence.ts`) is
 * historical and describes the WIRE, not the concept.
 *
 * Every trace origin must be listed in {@link TRACE_ORIGINS}. This file exists
 * because it was not: `'subagent'` shipped in 2026-05 and none of the eight
 * hardcoded `NOT IN ('task', 'delegation')` predicates across Portal learned
 * about it, so sub-agent children leaked into the user's Chat list, inflated
 * every session/prompt count, and were never reachable by retention pruning.
 * Adding an origin means adding it HERE, not at a call site.
 */

/**
 * Origins that mark a row as an EXECUTION TRACE rather than a top-level
 * conversation. These rows live in `chat_sessions` so FK and audit paths keep
 * working, but they are not what a user means by "my chats", they are not
 * countable as sessions, and retention pruning owns them.
 */
export const TRACE_ORIGINS = ["task", "delegation", "subagent"] as const;

/**
 * Trace origins whose MESSAGE rows are attributed to the PARENT session's entry
 * form (see `entryMessagePredicate`): work performed on behalf of a parent turn,
 * so its tool calls belong to whatever entry started that turn.
 *
 * `task` is deliberately absent — a scheduled run IS its own entry bucket and
 * has no parent turn to inherit from.
 */
export const PARENT_ATTRIBUTED_ORIGINS = ["delegation", "subagent"] as const;

export type TraceOrigin = (typeof TRACE_ORIGINS)[number];

/** Render a string list as a SQL literal list for an `IN (...)` clause. */
function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(", ");
}

/** `'task', 'delegation', 'subagent'` — for `origin IN (...)` / `NOT IN (...)`. */
export function traceOriginSqlList(): string {
  return sqlList(TRACE_ORIGINS);
}

/**
 * Predicate selecting rows that are NOT execution traces — the user-visible
 * conversations. NULL-safe: `origin IS NULL` (web) is the common case and
 * `NOT IN` alone would drop it.
 *
 * `alias` is the `chat_sessions` alias; pass "" for an unaliased FROM.
 */
export function nonTraceOriginPredicate(alias = "s"): string {
  const p = alias ? `${alias}.` : "";
  return `(${p}origin IS NULL OR ${p}origin NOT IN (${traceOriginSqlList()}))`;
}

/**
 * Predicate selecting trace rows that inherit their parent session's entry form.
 * Pairs with a LEFT JOIN on `parent_session_id`.
 */
export function parentAttributedOriginPredicate(alias = "s"): string {
  const p = alias ? `${alias}.` : "";
  return `${p}origin IN (${sqlList(PARENT_ATTRIBUTED_ORIGINS)})`;
}
