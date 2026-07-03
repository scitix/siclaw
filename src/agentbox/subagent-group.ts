/**
 * spawn_subagent batch — pure orchestration logic (design §"Orchestration (batch path)").
 *
 * Everything that can be a pure function or pure class and is worth unit-testing on its
 * own lives here, so `session.ts` keeps only the glue (worker-pool submission, child
 * lifecycle, persistence). Nothing in this module touches a session, the network, the
 * clock, or process.env — validation bounds are passed in as parameters.
 *
 * Contents:
 *  - {@link validateAndRenderGroupPlan} — validate a group plan and render per-item prompts.
 *  - {@link buildReduceInput} — assemble the reduce child's prompt from all item results.
 *  - {@link GroupCircuitBreaker} — trip when a systematic template/environment error burns tokens.
 *  - {@link truncateReduceSummary} — bound the model-visible reduce summary.
 */

import {
  GROUP_REDUCE_INPUT_MAX_CHARS,
  GROUP_REDUCE_SUMMARY_MAX_CHARS,
} from "../core/subagent-registry.js";
// GroupItemStatus is the shared group/tool contract, defined once in core/tool-registry.ts
// (`skipped` = never started, never persisted as a child event). Import it for local use here
// and re-export so this module's existing consumers keep importing the name from here.
// (agentbox → core is the correct dependency direction; core never imports from agentbox.)
import type { GroupItemStatus } from "../core/tool-registry.js";
export type { GroupItemStatus };

/** One rendered task: the original item plus the fully-substituted child prompt. */
export interface RenderedGroupTask {
  item: string | Record<string, string>;
  prompt: string;
}

export interface GroupPlanInput {
  /** Template with `{{key}}` placeholders. Omitted/blank ⇒ equivalent to `"{{item}}"`. */
  taskTemplate?: string;
  /** Items — must be homogeneous (all strings OR all objects). */
  items: Array<string | Record<string, string>>;
  /** Upper bound on item count (resolved from env by the caller). */
  maxItems: number;
}

/** Structured result — never throws; the tool layer turns `{ ok: false }` into an errorResult. */
export type GroupPlanResult =
  | { ok: true; tasks: RenderedGroupTask[] }
  | { ok: false; error: string };

/** One item's outcome, fed into {@link buildReduceInput}. */
export interface GroupItemOutcome {
  item: string | Record<string, string>;
  status: GroupItemStatus;
  /** Capsule for a completed child, or a short error/skip note. */
  summary: string;
}

/** `{{key}}` placeholder. Keys are simple identifiers; whitespace inside the braces is allowed. */
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** The implicit template used when `task_template` is omitted (string items only). */
const DEFAULT_ITEM_TEMPLATE = "{{item}}";

/** The reserved placeholder that maps to a string item's whole value. */
const STRING_ITEM_KEY = "item";

function extractPlaceholders(template: string): Set<string> {
  const keys = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER_RE)) keys.add(m[1]);
  return keys;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_all, key: string) => values[key] ?? "");
}

/** A short, single-line label for an item, used in reduce headers and error messages. */
function itemLabel(item: string | Record<string, string>): string {
  const raw = typeof item === "string" ? item : JSON.stringify(item);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}

/** Stable key for duplicate detection (object key order does not matter). */
function dedupeKey(item: string | Record<string, string>): string {
  if (typeof item === "string") return `s:${item}`;
  const sorted = Object.keys(item).sort().map((k) => `${k}=${item[k]}`);
  return `o:${sorted.join("")}`;
}

/**
 * Validate a group plan and render one child prompt per item (design §"Tool layer (single entry)").
 * All checks are fail-fast: on the first violation it returns a structured error and NO
 * child is ever started. Rules:
 *  - `items` count is 1..maxItems (over the cap ⇒ error with a "split into batches" hint).
 *  - items are homogeneous — all strings OR all objects (mixing is rejected).
 *  - with `task_template` omitted, items must all be strings.
 *  - object form: the template's placeholder set and each item's key set must strictly
 *    cover each other (a referenced-but-missing key, OR an unreferenced key — likely a
 *    typo — are both errors).
 *  - string form: the only valid placeholder is `{{item}}`, and it must be referenced.
 *  - duplicate items are rejected.
 */
export function validateAndRenderGroupPlan(input: GroupPlanInput): GroupPlanResult {
  const { items, maxItems } = input;

  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "spawn_subagent requires a non-empty `items` array." };
  }
  if (items.length > maxItems) {
    return {
      ok: false,
      error:
        `spawn_subagent got ${items.length} items but the limit is ${maxItems}. ` +
        `Split the work into batches of ≤${maxItems} and call spawn_subagent once per batch.`,
    };
  }

  // Classify homogeneity. A plain object (not null, not array) is "object"; a string is
  // "string"; anything else is invalid input.
  let sawString = false;
  let sawObject = false;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (typeof it === "string") {
      sawString = true;
    } else if (it !== null && typeof it === "object" && !Array.isArray(it)) {
      sawObject = true;
    } else {
      return { ok: false, error: `Item ${i + 1} is neither a string nor an object.` };
    }
  }
  if (sawString && sawObject) {
    return {
      ok: false,
      error:
        "`items` must be homogeneous: either all strings (with `{{item}}`) or all objects " +
        "(with `{{key}}` placeholders). Do not mix the two forms in one call.",
    };
  }
  const isObjectForm = sawObject;

  const rawTemplate = input.taskTemplate?.trim();
  if (!rawTemplate && isObjectForm) {
    return {
      ok: false,
      error:
        "`task_template` is required for object items (it holds the `{{key}}` placeholders). " +
        "Omit it only when every item is a plain string.",
    };
  }
  const template = rawTemplate || DEFAULT_ITEM_TEMPLATE;
  const placeholders = extractPlaceholders(template);

  if (isObjectForm) {
    // Each object item's key set must strictly equal the template's placeholder set.
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Record<string, string>;
      for (const [k, v] of Object.entries(item)) {
        if (typeof v !== "string") {
          return { ok: false, error: `Item ${i + 1} key "${k}" must be a string value.` };
        }
      }
      const keys = new Set(Object.keys(item));
      const missing = [...placeholders].filter((p) => !keys.has(p));
      if (missing.length > 0) {
        return {
          ok: false,
          error:
            `Item ${i + 1} is missing key(s) referenced by the template: ${missing.map((k) => `{{${k}}}`).join(", ")}.`,
        };
      }
      const extra = [...keys].filter((k) => !placeholders.has(k));
      if (extra.length > 0) {
        return {
          ok: false,
          error:
            `Item ${i + 1} has key(s) the template never references: ${extra.join(", ")} ` +
            `(typo, or a missing placeholder in task_template?).`,
        };
      }
    }
  } else {
    // String form: {{item}} is the only valid placeholder and it must appear.
    const invalid = [...placeholders].filter((p) => p !== STRING_ITEM_KEY);
    if (invalid.length > 0) {
      return {
        ok: false,
        error:
          `With string items the only valid placeholder is {{item}}, but the template references: ` +
          `${invalid.map((k) => `{{${k}}}`).join(", ")}. Use object items to pass multiple fields.`,
      };
    }
    if (!placeholders.has(STRING_ITEM_KEY)) {
      return {
        ok: false,
        error: "The template never references {{item}}, so each item's text would be dropped.",
      };
    }
    for (let i = 0; i < items.length; i++) {
      if ((items[i] as string).trim() === "") {
        return { ok: false, error: `Item ${i + 1} is an empty string.` };
      }
    }
  }

  // Duplicate detection (after structural validation so messages are clean).
  const seen = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const key = dedupeKey(items[i]);
    const prev = seen.get(key);
    if (prev !== undefined) {
      return {
        ok: false,
        error: `Item ${i + 1} duplicates item ${prev + 1} ("${itemLabel(items[i])}"). Remove the duplicate.`,
      };
    }
    seen.set(key, i);
  }

  const tasks: RenderedGroupTask[] = items.map((item) => {
    const values = typeof item === "string" ? { [STRING_ITEM_KEY]: item } : (item as Record<string, string>);
    return { item, prompt: renderTemplate(template, values) };
  });
  return { ok: true, tasks };
}

/** Truncate a body to `allowed` chars, appending a `[truncated]` marker when it cuts. */
function truncateBody(body: string, allowed: number): string {
  if (body.length <= allowed) return body;
  const marker = "\n[truncated]";
  const keep = Math.max(0, allowed - marker.length);
  return body.slice(0, keep) + marker;
}

/**
 * Assemble the reduce child's full prompt from the reduce instruction plus every item's
 * result (design §"Orchestration (batch path)"). Each item is rendered as:
 *
 *   ── item k: <item> — status: <status> ──
 *   <capsule or error/skip note>
 *
 * When the assembled input would exceed `maxChars`, each item BODY is truncated
 * proportionally (by its share of the total body length) and marked `[truncated]` — the
 * headers and the reduce instruction are always kept intact.
 */
export function buildReduceInput(
  reducePrompt: string,
  itemResults: GroupItemOutcome[],
  maxChars = GROUP_REDUCE_INPUT_MAX_CHARS,
): string {
  const header = reducePrompt.trim();
  const blocks = itemResults.map((r, i) => ({
    head: `── item ${i + 1}: ${itemLabel(r.item)} — status: ${r.status} ──`,
    body: r.summary ?? "",
  }));

  const SEP = "\n\n";
  const NL = "\n";
  const bodyLens = blocks.map((b) => b.body.length);
  const totalBody = bodyLens.reduce((a, n) => a + n, 0);
  // Non-body overhead: header + one SEP before the first block + (n-1) SEP between blocks
  // + each block's head and the NL between head and body.
  const overhead =
    header.length +
    SEP.length * blocks.length +
    blocks.reduce((a, b) => a + b.head.length + NL.length, 0);

  const bodyBudget = maxChars - overhead;
  let allowedFor: (i: number) => number;
  if (totalBody <= bodyBudget || totalBody === 0) {
    allowedFor = () => Number.POSITIVE_INFINITY; // no truncation needed
  } else {
    const budget = Math.max(0, bodyBudget);
    allowedFor = (i: number) => Math.floor((bodyLens[i] * budget) / totalBody);
  }

  const rendered = blocks
    .map((b, i) => `${b.head}${NL}${truncateBody(b.body, allowedFor(i))}`)
    .join(SEP);
  return header ? `${header}${SEP}${rendered}` : rendered;
}

/**
 * Guards against a systematic template/environment error that would otherwise burn tokens
 * across a whole group (design §"Orchestration (batch path)", decision #9). Judged by COMPLETION ORDER, not
 * submission order, because concurrent children finish out of order:
 *  - the FIRST {@link window} items to complete were ALL failures (and zero successes) ⇒ trip;
 *  - any `done` result releases the breaker permanently (a working setup — never trip).
 *
 * `partial` and `skipped` count as neither a failure nor a success: a partial means the
 * child ran and produced output (the setup works), so it prevents a trip without releasing;
 * a skipped item was never started, so it is not a completion at all.
 */
export class GroupCircuitBreaker {
  private completed = 0;
  private failed = 0;
  private succeeded = 0;
  private trippedAtWindow = false;

  constructor(private readonly window = 5) {}

  /** Record one item's terminal status (call once per completed item, in completion order). */
  record(status: GroupItemStatus): void {
    if (status === "skipped") return; // never started ⇒ not a completion
    this.completed++;
    if (status === "done") this.succeeded++;
    else if (status === "failed" || status === "timed_out") this.failed++;
    // `partial` counts toward `completed` but is neither a success nor a failure.
    if (this.completed === this.window && this.failed === this.window) {
      this.trippedAtWindow = true;
    }
  }

  /** True once the first-`window`-all-failed condition held and no success has since arrived. */
  get tripped(): boolean {
    return this.trippedAtWindow && this.succeeded === 0;
  }

  /** Human-readable trip reason for the group report. */
  get reason(): string {
    return `Circuit breaker: the first ${this.window} sub-agents all failed with no success — likely a template or environment error. Remaining items were skipped.`;
  }
}

/**
 * Bound the model-visible reduce summary to `maxChars` (design decision #7). A group
 * summary synthesises N items, so it gets a larger budget than a normal capsule (1800).
 */
export function truncateReduceSummary(
  summary: string,
  maxChars = GROUP_REDUCE_SUMMARY_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (summary.length <= maxChars) return { text: summary, truncated: false };
  const marker = `\n\n[reduce summary truncated to ${maxChars} chars]`;
  const keep = Math.max(0, maxChars - marker.length);
  return { text: summary.slice(0, keep) + marker, truncated: true };
}
