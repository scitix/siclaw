/**
 * Reads token usage out of `llm_calls`.
 *
 * The write side went to great lengths to keep "the provider reported 0" apart
 * from "the provider reported nothing". An aggregate is exactly where that
 * distinction gets thrown away again, in two ways, so both are designed against
 * here rather than left to each caller:
 *
 *   1. `SUM(col)` SKIPS NULLs. A column that was never reported on half the
 *      calls therefore produces a number that LOOKS like a total and is not.
 *      Every field is returned as a sum PLUS the count of rows that actually
 *      reported it, so a caller can see the sum's basis instead of assuming it.
 *   2. Rows whose usage is untrustworthy (`sdk_default`, `rehydrated`,
 *      `unknown`) would contribute zeros and silently deflate every figure.
 *      They are EXCLUDED from the sums and counted separately, so a page can
 *      state its coverage rather than present a partial total as complete.
 *
 * Grouping always includes `api_type`, because the protocols disagree about
 * what `input_tokens` covers — see {@link billableTokens}. Without it one sum
 * would mix two different meanings.
 */

import type { Db } from "../gateway/db.js";
import { billableTokens } from "../shared/llm-call-record.js";
import { parentAttributedOriginPredicate } from "./session-origin.js";

/** Sums are over reporting rows only; the counts say how many those were. */
export interface TokenFieldTotals {
  /** Sum over rows that reported this field; null when none did. */
  total: number | null;
  /** How many calls reported it — compare against `calls` to judge the sum. */
  reportedCalls: number;
}

export interface UsageGroup {
  provider: string;
  modelId: string;
  apiType: string;
  /** Calls with trustworthy usage — the basis of every figure below. */
  calls: number;
  input: TokenFieldTotals;
  output: TokenFieldTotals;
  reasoning: TokenFieldTotals;
  cacheRead: TokenFieldTotals;
  cacheWrite: TokenFieldTotals;
  /**
   * Charged tokens for this group, computed per protocol. Null when a required
   * component was never reported — the ranking then places the group last
   * rather than treating unknown as zero.
   */
  billable: number | null;
}

export interface UsageCoverage {
  /** Calls in the window whose usage is provider-reported and safe to sum. */
  trustworthy: number;
  /** Calls excluded: the provider never reported, or provenance is unknown. */
  excluded: number;
}

export interface UsageByModel {
  groups: UsageGroup[];
  coverage: UsageCoverage;
}

/** An actor is a platform user, or a channel sender with no platform account. */
export interface UsageActor {
  kind: "user" | "channel";
  /** User id, or the channel's external sender id. */
  id: string;
  calls: number;
  input: TokenFieldTotals;
  output: TokenFieldTotals;
  cacheRead: TokenFieldTotals;
  cacheWrite: TokenFieldTotals;
  billable: number | null;
  /** Set when one actor's calls span protocols with different billing shapes. */
  mixedProtocols: boolean;
}

/**
 * What a ranking is ordered by.
 *
 * Server-side because the result is CAPPED: sorting a truncated page in the
 * browser would rank the wrong rows — "top spenders by cache write" computed
 * over the top 50 by total is not the same list.
 */
export type UsageSortKey = "billable" | "input" | "output" | "cacheRead" | "cacheWrite" | "calls";

export const USAGE_SORT_KEYS: readonly UsageSortKey[] = [
  "billable", "input", "output", "cacheRead", "cacheWrite", "calls",
];

function sortValue(row: { calls: number; billable: number | null } & Partial<Record<Exclude<UsageSortKey, "billable" | "calls">, TokenFieldTotals>>, key: UsageSortKey): number | null {
  if (key === "calls") return row.calls;
  if (key === "billable") return row.billable;
  return row[key]?.total ?? null;
}

/**
 * Descending, with UNKNOWN last.
 *
 * A null total is not "the smallest" — it is the one we could not compute, and
 * ranking it as zero would put a possibly-huge spender at the bottom of a page
 * whose whole purpose is to find the big ones. Ties fall back to call count so
 * the order is stable rather than arbitrary.
 */
function byMetricDesc<T extends { calls: number; billable: number | null }>(key: UsageSortKey) {
  return (a: T, b: T): number => {
    const av = sortValue(a as never, key);
    const bv = sortValue(b as never, key);
    if (av === null && bv === null) return b.calls - a.calls;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av || b.calls - a.calls;
  };
}

export interface UsageByActor {
  actors: UsageActor[];
  coverage: UsageCoverage;
}

export interface UsageWindow {
  from: Date;
  to: Date;
  /** Cap on returned groups; the rest are omitted, never merged into an "other". */
  limit?: number;
  /** Ranking metric; the cap applies AFTER it. Defaults to charged tokens. */
  sort?: UsageSortKey;
}

/**
 * Rows safe to aggregate: the provider actually answered.
 *
 * `partial` is included — it means SOME contracted fields were reported, and
 * each field's own count already says which. Excluding it would discard real
 * provider numbers; including it without the per-field counts would overstate
 * them. Both halves are needed, which is why they ship together.
 */
function trustworthy(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `${p}usage_source = 'provider' AND ${p}usage_status IN ('reported','partial')`;
}

/** `SUM(x)` over reporting rows, plus how many rows those were. */
function fieldSql(column: string, alias: string): string {
  return `SUM(${column}) AS ${alias}_sum, COUNT(${column}) AS ${alias}_n`;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** null stays null: an absent sum means nothing reported, not zero. */
function toTotals(sum: unknown, count: unknown): TokenFieldTotals {
  const reportedCalls = toNumber(count);
  return { total: reportedCalls > 0 ? toNumber(sum) : null, reportedCalls };
}

/**
 * Combine two slices of one field.
 *
 * A null side contributes nothing — it reported nothing, so it cannot lower the
 * other side's total. Two nulls stay null: still nothing reported, which is not
 * the same claim as zero.
 */
function addTotals(a: TokenFieldTotals, b: TokenFieldTotals): TokenFieldTotals {
  const reportedCalls = a.reportedCalls + b.reportedCalls;
  if (a.total === null) return { total: b.total, reportedCalls };
  if (b.total === null) return { total: a.total, reportedCalls };
  return { total: a.total + b.total, reportedCalls };
}

/**
 * Coverage for the window — computed in the same query shape as the sums so the
 * two cannot describe different row sets.
 */
async function readCoverage(db: Db, window: UsageWindow): Promise<UsageCoverage> {
  const [rows] = (await db.query(
    `SELECT SUM(CASE WHEN ${trustworthy()} THEN 1 ELSE 0 END) AS ok,
            COUNT(*) AS total
       FROM llm_calls
      WHERE request_at >= ? AND request_at <= ?`,
    [window.from.toISOString(), window.to.toISOString()],
  )) as any;
  const row = rows?.[0] ?? {};
  const usable = toNumber(row.ok);
  return { trustworthy: usable, excluded: Math.max(0, toNumber(row.total) - usable) };
}

/**
 * Usage per provider × model, heaviest first.
 *
 * Ordering is done HERE rather than in SQL: the sort key is `billableTokens`,
 * which is protocol-dependent, and expressing it in SQL would be a second
 * answer to a question the shared contract already answers. Group counts are
 * small (providers × models), so the cost is nil.
 */
export async function usageByModel(db: Db, window: UsageWindow): Promise<UsageByModel> {
  const [rows] = (await db.query(
    `SELECT provider, model_id, api_type, COUNT(*) AS calls,
            ${fieldSql("input_tokens_total", "input")},
            ${fieldSql("output_tokens_total", "output")},
            ${fieldSql("reasoning_tokens", "reasoning")},
            ${fieldSql("cache_read_tokens", "cache_read")},
            ${fieldSql("cache_write_tokens", "cache_write")}
       FROM llm_calls
      WHERE request_at >= ? AND request_at <= ? AND ${trustworthy()}
      GROUP BY provider, model_id, api_type`,
    [window.from.toISOString(), window.to.toISOString()],
  )) as [Array<Record<string, unknown>>, unknown];

  const groups: UsageGroup[] = rows.map((r) => {
    const input = toTotals(r.input_sum, r.input_n);
    const output = toTotals(r.output_sum, r.output_n);
    const cacheRead = toTotals(r.cache_read_sum, r.cache_read_n);
    const cacheWrite = toTotals(r.cache_write_sum, r.cache_write_n);
    const apiType = String(r.api_type ?? "");
    return {
      provider: String(r.provider ?? ""),
      modelId: String(r.model_id ?? ""),
      apiType,
      calls: toNumber(r.calls),
      input,
      output,
      reasoning: toTotals(r.reasoning_sum, r.reasoning_n),
      cacheRead,
      cacheWrite,
      billable: billableTokens(apiType, {
        input: input.total, output: output.total,
        cacheRead: cacheRead.total, cacheWrite: cacheWrite.total,
      }),
    };
  });

  groups.sort(byMetricDesc(window.sort ?? "billable"));

  const limit = window.limit ?? 100;
  return { groups: groups.slice(0, limit), coverage: await readCoverage(db, window) };
}

/**
 * Usage per actor, heaviest first.
 *
 * The actor is read from the SESSION, parent-aware: `sender_external_id` is
 * stamped on the channel session only, so a sub-agent's rows — the ones this
 * work exists to capture — would fall out of every channel figure without the
 * COALESCE. Attributing a child's spend to the parent's actor is the intent:
 * the person who asked is who it cost.
 */
export async function usageByActor(db: Db, window: UsageWindow): Promise<UsageByActor> {
  // A trace child has its OWN origin ('subagent' / 'delegation'), so a
  // per-column COALESCE never reaches the parent — the child's own non-null
  // origin wins and its calls land under a platform user instead of the channel
  // sender who actually asked. Switch on WHOSE identity applies first, then read
  // every column from that side.
  const inherits = `(${parentAttributedOriginPredicate("s")} AND parent_s.id IS NOT NULL)`;
  const origin = `CASE WHEN ${inherits} THEN parent_s.origin ELSE s.origin END`;
  const sender = `CASE WHEN ${inherits} THEN parent_s.sender_external_id ELSE s.sender_external_id END`;
  const user = `CASE WHEN ${inherits} THEN parent_s.user_id ELSE s.user_id END`;
  const [rows] = (await db.query(
    `SELECT CASE WHEN ${origin} = 'channel' AND ${sender} IS NOT NULL THEN 'channel' ELSE 'user' END AS actor_kind,
            CASE WHEN ${origin} = 'channel' AND ${sender} IS NOT NULL THEN ${sender} ELSE ${user} END AS actor_id,
            c.api_type,
            COUNT(*) AS calls,
            ${fieldSql("c.input_tokens_total", "input")},
            ${fieldSql("c.output_tokens_total", "output")},
            ${fieldSql("c.cache_read_tokens", "cache_read")},
            ${fieldSql("c.cache_write_tokens", "cache_write")}
       FROM llm_calls c
       LEFT JOIN chat_sessions s ON s.id = c.session_id
       LEFT JOIN chat_sessions parent_s ON parent_s.id = s.parent_session_id
      WHERE c.request_at >= ? AND c.request_at <= ? AND ${trustworthy("c")}
      GROUP BY actor_kind, actor_id, c.api_type`,
    [window.from.toISOString(), window.to.toISOString()],
  )) as [Array<Record<string, unknown>>, unknown];

  // Per (actor, api_type) from SQL, folded to per-actor here — the fold has to
  // happen AFTER billableTokens, since that is what makes two protocols'
  // numbers comparable in the first place.
  const byActor = new Map<string, UsageActor>();
  for (const r of rows) {
    const kind = r.actor_kind === "channel" ? "channel" : "user";
    const id = String(r.actor_id ?? "");
    if (!id) continue; // an unattributable row belongs to no actor; do not invent one
    const key = `${kind}:${id}`;
    const input = toTotals(r.input_sum, r.input_n);
    const output = toTotals(r.output_sum, r.output_n);
    const cacheRead = toTotals(r.cache_read_sum, r.cache_read_n);
    const cacheWrite = toTotals(r.cache_write_sum, r.cache_write_n);
    const slice = billableTokens(String(r.api_type ?? ""), {
      input: input.total, output: output.total,
      cacheRead: cacheRead.total, cacheWrite: cacheWrite.total,
    });
    const existing = byActor.get(key);
    if (!existing) {
      byActor.set(key, {
        kind, id, calls: toNumber(r.calls),
        input, output, cacheRead, cacheWrite,
        billable: slice, mixedProtocols: false,
      });
      continue;
    }
    existing.calls += toNumber(r.calls);
    existing.mixedProtocols = true;
    existing.input = addTotals(existing.input, input);
    existing.output = addTotals(existing.output, output);
    existing.cacheRead = addTotals(existing.cacheRead, cacheRead);
    existing.cacheWrite = addTotals(existing.cacheWrite, cacheWrite);
    // One unknown slice makes the actor's total unknown. Adding the known part
    // alone would report a number that is definitely too small as if it were
    // the total.
    existing.billable = existing.billable === null || slice === null ? null : existing.billable + slice;
  }

  const actors = [...byActor.values()].sort(byMetricDesc(window.sort ?? "billable"));

  const limit = window.limit ?? 100;
  return { actors: actors.slice(0, limit), coverage: await readCoverage(db, window) };
}
