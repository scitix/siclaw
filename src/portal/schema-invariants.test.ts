/**
 * Schema invariants — grep the source tree to prove every UPDATE statement
 * against a table that has `updated_at` explicitly sets the column.
 *
 * Without `ON UPDATE CURRENT_TIMESTAMP` (removed for SQLite compatibility),
 * the app layer is now solely responsible for maintaining `updated_at`.
 * This test guards against mechanical-edit omissions in future PRs.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTAL_DIR = path.resolve(__dirname);
const GATEWAY_DIR = path.resolve(__dirname, "..", "gateway");

/** Tables whose schema carries `updated_at` and therefore every UPDATE must touch it. */
const TABLES_WITH_UPDATED_AT = [
  "agents",
  "clusters",
  "hosts",
  "agent_tasks",
  "channels",
  "mcp_servers",
  "skills",
  "model_providers",
  "agent_diagnostics",
  "system_config",
];

/** Scan .ts files in portal/ and gateway/, excluding tests and migrate.ts. */
function* walkBusinessSources(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkBusinessSources(full);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      entry.name !== "migrate.ts" &&
      entry.name !== "migrate-compat.ts"
    ) {
      yield full;
    }
  }
}

/**
 * Extract each `UPDATE <table>` statement and return up to 600 chars of
 * context after the `SET`. This is a heuristic — SQL inside JS may span
 * template literals, contain string literals with embedded quotes, etc.
 * We don't need precise SQL boundaries: we just need to know whether
 * `updated_at` appears somewhere in the SET clause neighbourhood.
 */
function extractUpdateStatements(src: string): Array<{ table: string; body: string }> {
  const results: Array<{ table: string; body: string }> = [];
  const pattern = /UPDATE\s+(\w+)\s+SET\s+/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(src)) !== null) {
    const bodyStart = match.index + match[0].length;
    const windowSlice = src.slice(bodyStart, bodyStart + 600);
    // Stop at the next UPDATE <table> SET to prevent two adjacent statements
    // from bleeding into each other.
    const nextUpdate = windowSlice.search(/UPDATE\s+\w+\s+SET/i);
    const body = nextUpdate >= 0 ? windowSlice.slice(0, nextUpdate) : windowSlice;
    results.push({ table: match[1], body });
  }
  return results;
}

describe("schema invariants: updated_at must be set on every UPDATE", () => {
  it("every UPDATE to an ON UPDATE table explicitly sets updated_at", () => {
    const violations: Array<{ file: string; table: string; body: string }> = [];

    for (const filePath of [
      ...walkBusinessSources(PORTAL_DIR),
      ...walkBusinessSources(GATEWAY_DIR),
    ]) {
      const src = fs.readFileSync(filePath, "utf-8");
      for (const stmt of extractUpdateStatements(src)) {
        if (!TABLES_WITH_UPDATED_AT.includes(stmt.table)) continue;
        // Does the SET body reference updated_at? (allow variable interpolation
        // like `${setClauses}` too, which would have updated_at appended via
        // setClauses.push elsewhere — we can't introspect the runtime value,
        // so we require a *literal* reference in the body instead.)
        if (!stmt.body.includes("updated_at")) {
          violations.push({ file: path.relative(process.cwd(), filePath), ...stmt });
        }
      }
    }

    // Expected exception: dynamic UPDATEs that push updated_at into setClauses
    // at runtime. Filter those by confirming the enclosing file contains any
    // form of `setClauses.push(... updated_at ...)` — the quote style varies
    // (backticks, single quotes, double quotes).
    const trueViolations = violations.filter(({ file, body }) => {
      const isDynamicSetClauses = /\$\{setClauses\.join/i.test(body);
      if (!isDynamicSetClauses) return true;
      const src = fs.readFileSync(path.resolve(process.cwd(), file), "utf-8");
      return !/setClauses\.push\([`'"][^`'"]*updated_at/.test(src);
    });

    if (trueViolations.length > 0) {
      const msg = trueViolations
        .map((v) => `  ${v.file}: UPDATE ${v.table} SET ${v.body.slice(0, 80).trim()}...`)
        .join("\n");
      expect.fail(`Found ${trueViolations.length} UPDATE(s) missing updated_at:\n${msg}`);
    }
  });

  it("no MySQL millisecond precision literals remain in business SQL", () => {
    const offenders: Array<{ file: string; snippet: string }> = [];
    const patterns = [
      /CURRENT_TIMESTAMP\s*\(\s*\d+\s*\)/i,
      /\bNOW\s*\(\s*\d+\s*\)/i,
    ];

    for (const filePath of [
      ...walkBusinessSources(PORTAL_DIR),
      ...walkBusinessSources(GATEWAY_DIR),
    ]) {
      // Allow the SQLite driver's own preprocessor mention (it targets the
      // exact same patterns defensively).
      if (filePath.endsWith("db-sqlite.ts")) continue;
      const src = fs.readFileSync(filePath, "utf-8");
      for (const pattern of patterns) {
        const m = src.match(pattern);
        if (m) {
          offenders.push({ file: path.relative(process.cwd(), filePath), snippet: m[0] });
        }
      }
    }

    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}: ${o.snippet}`).join("\n");
      expect.fail(`Found MySQL (3) millisecond precision literals:\n${msg}`);
    }
  });

  it("no MySQL-only date functions remain in business SQL", () => {
    // Case-sensitive uppercase: SQL functions like `NOW()` are always
    // uppercase in this codebase, while JS `Date.now()` / `performance.now()`
    // are lowercase and must not trip the check.
    const offenders: Array<{ file: string; snippet: string }> = [];
    const patterns: RegExp[] = [
      /\bNOW\s*\(\s*\)/,          // uppercase SQL NOW()
      /\bDATE_SUB\s*\(/,
      /\bCURDATE\s*\(\s*\)/,
      /\bINTERVAL\s+\?\s+DAY\b/i,
      /\bINTERVAL\s+\?\s+HOUR\b/i,
    ];

    for (const filePath of [
      ...walkBusinessSources(PORTAL_DIR),
      ...walkBusinessSources(GATEWAY_DIR),
    ]) {
      const src = fs.readFileSync(filePath, "utf-8");
      for (const pattern of patterns) {
        const m = src.match(pattern);
        if (m) {
          offenders.push({ file: path.relative(process.cwd(), filePath), snippet: m[0] });
        }
      }
    }

    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}: ${o.snippet}`).join("\n");
      expect.fail(`Found MySQL date functions still in business SQL:\n${msg}`);
    }
  });
});
