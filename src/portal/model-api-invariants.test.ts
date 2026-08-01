/**
 * Source-level invariant — every `model_entries` SELECT that feeds
 * `buildProviderModelDescriptor` must name the `api_type` column.
 *
 * A model's wire protocol is a per-model property (one aggregator gateway can
 * host OpenAI-protocol and Claude-protocol models side by side), resolved in
 * `core/model-compat.ts` from `row.api_type`. A SELECT that forgets the column
 * doesn't fail — it silently hands the descriptor `api_type: undefined`, the
 * model inherits the provider's protocol, and the turn dies upstream with
 * `unsupported_protocol`. That is close to undiagnosable in production, so it
 * is caught here instead: one test covering every call site, present and
 * future, including the HTTP/WS adapter mirrors that are easy to update singly.
 *
 * Follows the precedent set by `schema-invariants.test.ts` — grep the source
 * tree to prove a contract that types can't express.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Scan the whole src tree, not just portal/ + gateway/: a descriptor call site
// added under core/, lib/, or agentbox/ would otherwise be invisible here and
// the count-pin below would still read 7.
const SRC_ROOT = path.resolve(__dirname, "..");
const ROOTS = [SRC_ROOT];

function* walkSources(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSources(full);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      yield full;
    }
  }
}

/**
 * Return every `SELECT … FROM model_entries` statement in the file, collapsed
 * to one line. SQL here lives in both plain strings and template literals, so
 * this scans raw text rather than parsing.
 *
 * The projection body may not contain a quote, backtick, semicolon, or another
 * SELECT/FROM — without that the non-greedy match happily starts at an earlier,
 * unrelated `SELECT … FROM model_providers` and swallows the JS in between.
 */
function extractModelEntrySelects(src: string): string[] {
  const out: string[] = [];
  const pattern = /SELECT\s+((?:(?!FROM|SELECT|["`;])[\s\S]){0,400}?)FROM\s+model_entries\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(src)) !== null) {
    out.push(match[0].replace(/\s+/g, " ").trim());
  }
  return out;
}

/**
 * Column-list SELECTs that legitimately do NOT need api_type, because they feed
 * something other than a model descriptor. Keyed by the projected columns.
 *
 * - `model_id` alone: default-model lookups (adapter's sicore endpoints,
 *   ai-security-reviewer's bare chat/completions fetch) — no descriptor built.
 * - `me.id`: ownership checks in the admin CRUD.
 * - `*`: admin CRUD echoes the whole row back to the Portal UI.
 * - `me.model_id, me.max_tokens_field, …`: the model-test probe, which joins
 *   the provider for connection details and builds ONE request by hand rather
 *   than a descriptor. It reads the protocol off the provider row it joined, so
 *   the api_type assertion would pass anyway — the exclusion exists to keep the
 *   call-site count below honest about what actually hydrates a descriptor.
 */
const DESCRIPTOR_FREE_PROJECTIONS = [
  /^SELECT \* FROM model_entries/i,
  /^SELECT model_id FROM model_entries/i,
  /^SELECT me\.id FROM model_entries/i,
  /^SELECT me\.model_id, me\.max_tokens_field/i,
];

describe("model_entries SELECTs feeding buildProviderModelDescriptor", () => {
  it("all name the api_type column", () => {
    const offenders: string[] = [];

    for (const root of ROOTS) {
      for (const file of walkSources(root)) {
        const src = fs.readFileSync(file, "utf-8");
        if (!src.includes("model_entries")) continue;
        for (const stmt of extractModelEntrySelects(src)) {
          if (DESCRIPTOR_FREE_PROJECTIONS.some((re) => re.test(stmt))) continue;
          if (!/\bapi_type\b/.test(stmt)) {
            offenders.push(`${path.relative(SRC_ROOT, file)}: ${stmt}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("finds the known descriptor call sites (guards the scanner itself)", () => {
    // If a refactor moves these SELECTs somewhere the walker doesn't reach, the
    // test above would pass vacuously. Pin the expected count instead.
    let matched = 0;
    for (const root of ROOTS) {
      for (const file of walkSources(root)) {
        const src = fs.readFileSync(file, "utf-8");
        if (!src.includes("model_entries")) continue;
        for (const stmt of extractModelEntrySelects(src)) {
          if (DESCRIPTOR_FREE_PROJECTIONS.some((re) => re.test(stmt))) continue;
          matched++;
        }
      }
    }
    // adapter.ts ×4 (HTTP + WS mirrors), chat-gateway, cli-snapshot-api,
    // model-routing-config. Bump this deliberately when adding a call site.
    expect(matched).toBe(7);
  });
});
