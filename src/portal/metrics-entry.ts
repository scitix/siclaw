/**
 * Entry-form axis for audit / metrics filtering.
 *
 * Mirrors `chat_sessions.origin` — see `session-origin.ts` for the full origin
 * vocabulary and which values are execution traces. The entry axis covers the
 * NON-trace origins (web / api / a2a / channel) plus `task` as its own
 * `scheduled` bucket; trace rows are never a top-level entry.
 *
 * The audit UI can view one entry at a time or the combined **overview**
 * ("all" = web+api+a2a+channel, the interactive family; scheduled is its own
 * selectable bucket).
 *
 * Three predicate flavours, and WHICH ONE a query takes is a semantic choice,
 * not a matter of which alias is in scope:
 *
 *  - session-level (`entrySessionPredicate`): per-session queries (session list,
 *    session counts). Trace sessions excluded.
 *
 *  - prompt-level (`entryPromptPredicate`): counting `role='user'` rows, i.e.
 *    "how many requests did people make". Trace sessions excluded, WITHOUT
 *    parent attribution. A trace child's opening `role='user'` row is the task
 *    text its parent generated — a sub-agent briefing or a delegated
 *    instruction — never something a user typed, so attributing it to the
 *    parent's entry would count one human request as two.
 *
 *  - message-level (`entryMessagePredicate`): per-tool / per-assistant queries
 *    (tool audit, tool counts, timing). Here a parent-attributed child's rows
 *    (delegation / sub-agent) DO count under the parent's entry: the parent's
 *    own `spawn_subagent` call and the child's tool calls are all real calls,
 *    so counting both is the honest total of work performed.
 *
 * ⚠️ Do NOT use `entryMessagePredicate` for a `role='user'` count. That is
 * exactly how sub-agent briefings inflated `totalPrompts` while the sibling
 * `adapter.ts` summary excluded them, leaving two endpoints disagreeing about
 * one number.
 */

import { nonTraceOriginPredicate, parentAttributedOriginPredicate } from "./session-origin.js";

export type EntryMode = "all" | "web" | "api" | "a2a" | "channel" | "scheduled";

/**
 * SQL expression for the "user" a row is attributed to in the Metrics axis.
 *
 * For **channel** sessions the audit actor is the channel sender (the raw
 * sender id — Lark open_id / DingTalk staffId — which is the "same person" key),
 * NOT the binding owner. For every other origin it is the session's `user_id`
 * (web=logged-in, api/a2a=API-key owner). siclaw has no remote-user concept, so
 * no ControlPlane identity appears here.
 *
 * Use this ONLY for the actor-based FILTER and the distinct-actor COUNT — it is
 * the canonical "who acted" expression. Do NOT project it as the response
 * `userId` field: row payloads expose `user_id` (always the owner) and
 * `sender_external_id` separately, so a consumer never has to disambiguate one
 * overloaded field by `origin`.
 *
 * The channel dimension is intentionally NOT scoped here: Lark `open_id` is
 * per-app unique and DingTalk `staffId` has a distinct shape, so senders never
 * collide across origins/channels — narrowing to one channel is left to the
 * explicit `channel_id` filter, not folded into this expression.
 *
 * `alias` is the chat_sessions table alias (default "s"); pass "" for an
 * unaliased `FROM chat_sessions`.
 */
export function actorUserColumn(alias = "s"): string {
  const p = alias ? `${alias}.` : "";
  return `CASE WHEN ${p}origin = 'channel' THEN ${p}sender_external_id ELSE ${p}user_id END`;
}

/**
 * SQL column expression for a channel_id / sender_external_id filter, parent-aware.
 *
 * `channel_id` and `sender_external_id` are stamped on the PARENT channel
 * session only. A MESSAGE-LEVEL query that uses {@link entryMessagePredicate}'s
 * parent join counts a parent-attributed child's rows (delegation / sub-agent,
 * where these columns are NULL) under the parent's channel entry — so it MUST
 * filter/project via `COALESCE(child, parent)`, or those rows vanish the moment
 * a channel/sender filter is applied. Pass `parentAlias` for such queries. Omit
 * it for SESSION-LEVEL queries (no parent join; such a child is never a channel
 * session there) — passing it would reference an unjoined alias.
 *
 * Centralized so every filter site inherits the same parent-aware form and the
 * three query endpoints (audit / summary / timing) cannot silently diverge.
 */
export function channelColExpr(col: "channel_id" | "sender_external_id", alias = "s", parentAlias?: string): string {
  const a = alias ? `${alias}.` : "";
  return parentAlias ? `COALESCE(${a}${col}, ${parentAlias}.${col})` : `${a}${col}`;
}

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
 * Base origin predicate for one session alias, with NO parent attribution.
 * "all" (overview) = the interactive family (web+api+a2a+channel): every
 * non-trace origin, so scheduled (`task`) and every execution trace are out.
 */
function baseOriginPredicate(entry: EntryMode, alias: string): string {
  switch (entry) {
    case "web": return `${alias}.origin IS NULL`;
    case "api": return `${alias}.origin = 'api'`;
    case "a2a": return `${alias}.origin = 'a2a'`;
    case "channel": return `${alias}.origin = 'channel'`;
    case "scheduled": return `${alias}.origin = 'task'`;
    case "all":
    default: return nonTraceOriginPredicate(alias);
  }
}

/**
 * Session-level predicate (per-session queries). Excludes execution traces.
 * Returns a parenthesized SQL fragment over the given session alias (default "s").
 */
export function entrySessionPredicate(entry: EntryMode, alias = "s"): string {
  return `(${baseOriginPredicate(entry, alias)})`;
}

/**
 * Prompt-level predicate: for counting `role='user'` rows.
 *
 * Identical to {@link entrySessionPredicate} — trace sessions excluded, no
 * parent join — and separately named because the DIFFERENCE FROM
 * {@link entryMessagePredicate} is the contract, not an implementation detail.
 * A prompt count answers "how many requests did people make", and a trace
 * child's opening `role='user'` row was written by its parent agent, not by a
 * person: a sub-agent briefing, or a coordinator's delegated instruction.
 *
 * Callers must NOT pass a `parentAlias` to their channel/user filters here —
 * there is no parent join, so referencing it is a SQL error.
 */
export function entryPromptPredicate(entry: EntryMode, alias = "s"): string {
  return entrySessionPredicate(entry, alias);
}

/**
 * Message-level predicate (per-tool / per-assistant queries) WITH parent
 * attribution: a delegation OR sub-agent child session's rows count under the
 * parent's entry.
 *
 * NOT for `role='user'` counts — see {@link entryPromptPredicate}.
 *
 * Returns:
 *  - `join`: a LEFT JOIN clause binding `parentAlias` to `sAlias`'s parent
 *    session (empty string if inheritance is disabled).
 *  - `predicate`: a parenthesized fragment to AND into the WHERE clause.
 *
 * With inheritance:
 * `<entry on s> OR (s.origin IN (<parent-attributed>) AND <entry on parent_s>)`.
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
    `OR (${parentAttributedOriginPredicate(sAlias)} AND ${baseOriginPredicate(entry, parentAlias)}))`;
  return { join, predicate };
}
