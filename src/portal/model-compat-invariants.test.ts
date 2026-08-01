/**
 * Model-descriptor invariants — grep the source tree to prove every SELECT that
 * hydrates a model descriptor names the columns the descriptor is built from.
 *
 * Why a source-level test rather than per-site unit tests: a descriptor column
 * that a SELECT forgets to name does not fail. The row simply arrives without
 * it, `buildProviderModelDescriptor` falls back to its default, and the model
 * runs on the wrong wire settings. That surfaces in production as a 400 from
 * the provider — seven layers away from the SELECT that caused it, with nothing
 * in between to point at. This is not hypothetical: it is exactly how
 * `maxTokensField` stayed wrong for every model in the repo's history.
 *
 * One test beats N per-site tests here because it also covers the site that
 * does not exist yet. Add an 8th hydration path and forget the column, and this
 * fails loudly instead of the model silently misbehaving.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..");

/**
 * Columns every descriptor-hydrating SELECT must name.
 *
 * Only list columns `buildProviderModelDescriptor` reads and silently defaults
 * when absent. `context_window` doubles as the marker that identifies such a
 * SELECT (see `isDescriptorSelect`), so it is not itself checked here.
 */
const REQUIRED_DESCRIPTOR_COLUMNS = ["max_tokens", "max_tokens_field", "reasoning", "vision"];

/** Number of production call sites of buildProviderModelDescriptor. */
const EXPECTED_DESCRIPTOR_CALL_SITES = 7;

function* walkSources(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* walkSources(full);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      yield full;
    }
  }
}

/**
 * Extract the column list of every `SELECT ... FROM model_entries`, including
 * the multi-line template-literal form used in adapter.ts.
 */
function extractModelEntriesSelects(src: string): string[] {
  const results: string[] = [];
  const pattern = /SELECT([\s\S]{0,400}?)FROM\s+model_entries/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(src)) !== null) {
    results.push(match[1]);
  }
  return results;
}

/**
 * A SELECT hydrates a descriptor iff it asks for `context_window`. Lookup
 * queries (`SELECT model_id ... LIMIT 1`) and the CRUD endpoints' `SELECT *`
 * (raw rows returned to the caller, never turned into a descriptor) do not.
 */
function isDescriptorSelect(columnList: string): boolean {
  return columnList.includes("context_window");
}

describe("model descriptor invariants", () => {
  it("every descriptor-hydrating SELECT names all descriptor columns", () => {
    const violations: Array<{ file: string; missing: string[]; columns: string }> = [];

    for (const filePath of walkSources(SRC_DIR)) {
      const src = fs.readFileSync(filePath, "utf-8");
      for (const columns of extractModelEntriesSelects(src)) {
        if (!isDescriptorSelect(columns)) continue;
        const missing = REQUIRED_DESCRIPTOR_COLUMNS.filter((c) => !columns.includes(c));
        if (missing.length > 0) {
          violations.push({
            file: path.relative(process.cwd(), filePath),
            missing,
            columns: columns.trim().replace(/\s+/g, " "),
          });
        }
      }
    }

    expect(violations, `SELECTs missing descriptor columns:\n${JSON.stringify(violations, null, 2)}`)
      .toEqual([]);
  });

  it("finds every known hydration path (guards the detector itself)", () => {
    // If the regex or the context_window marker ever stops matching, the test
    // above would pass vacuously. Pin the count so a silent detector failure
    // is as loud as a real violation.
    const files = new Set<string>();
    let count = 0;
    for (const filePath of walkSources(SRC_DIR)) {
      const src = fs.readFileSync(filePath, "utf-8");
      for (const columns of extractModelEntriesSelects(src)) {
        if (!isDescriptorSelect(columns)) continue;
        files.add(path.basename(filePath));
        count++;
      }
    }

    expect(count).toBe(EXPECTED_DESCRIPTOR_CALL_SITES);
    expect([...files].sort()).toEqual([
      "adapter.ts",
      "chat-gateway.ts",
      "cli-snapshot-api.ts",
      "model-routing-config.ts",
    ]);
  });

  it("pins the number of buildProviderModelDescriptor call sites", () => {
    let calls = 0;
    for (const filePath of walkSources(SRC_DIR)) {
      if (path.basename(filePath) === "model-compat.ts") continue; // the definition
      const src = fs.readFileSync(filePath, "utf-8");
      calls += (src.match(/buildProviderModelDescriptor\s*\(/g) ?? []).length;
    }
    // A new call site must come with a SELECT that names every descriptor
    // column — bump this only after checking the first test still passes.
    expect(calls).toBe(EXPECTED_DESCRIPTOR_CALL_SITES);
  });
});
