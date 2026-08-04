/**
 * Source-level invariant — every `agents` SELECT that hydrates a full
 * `ResolvedModelBinding` must name the `language` and `timezone` columns.
 *
 * There are two independent readers of agent config, and that is the whole
 * problem: `gateway/agent-model-binding.ts` goes through the control-plane RPC
 * (served by `portal/adapter.ts`), while Portal web chat and a2a call
 * `portal/chat-gateway.ts`'s own direct DB read. A field added to the type but
 * to only one SELECT is `undefined` on the other path — and because both fields
 * are optional, that compiles and every unit test passes. It shipped exactly
 * that way once: the agent-level language and timezone reached the Feishu and
 * cron paths but were silently absent on the Portal web chat a reviewer would
 * actually click.
 *
 * Mirrors `model-api-invariants.test.ts`, which pins `api_type` for the same
 * reason and after the same class of bug.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Scan all of src/: a third reader added under gateway/ or lib/ must not be
// invisible here while the count-pin below still reads 2.
const SRC_ROOT = path.resolve(__dirname, "..");

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
 * Every `SELECT … FROM agents` in the file, collapsed to one line.
 *
 * The projection may not contain a quote, backtick, semicolon or another
 * SELECT/FROM, so a non-greedy match cannot start at an earlier unrelated
 * SELECT and swallow the JS in between.
 */
function extractAgentSelects(src: string): string[] {
  const out: string[] = [];
  const pattern = /SELECT\s+((?:(?!FROM|SELECT|["`;])[\s\S]){0,600}?)FROM\s+agents\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(src)) !== null) {
    out.push(match[0].replace(/\s+/g, " ").trim());
  }
  return out;
}

/**
 * A binding hydrator is recognized by its projection: it needs the model to
 * dial (`model_provider`) AND the agent's own instruction (`system_prompt`).
 * Narrower reads — routing-only lookups, the settings endpoint, the admin CRUD —
 * do not build one and are not required to carry locale.
 */
function isBindingHydrator(stmt: string): boolean {
  return /\bmodel_provider\b/.test(stmt) && /\bsystem_prompt\b/.test(stmt);
}

/**
 * Projections that match the shape but deliberately carry no locale.
 *
 * - `cli-snapshot-api.ts`: the TUI runs on the operator's own machine, which has
 *   its own clock and locale. Sending an agent's defaults there would override a
 *   correct local answer with a worse remote one.
 */
const LOCALE_FREE = [/\btool_capabilities, agent_type, system_prompt, icon, color FROM agents\b/i];

describe("agents SELECTs that hydrate a ResolvedModelBinding", () => {
  const hydrators: { file: string; stmt: string }[] = [];
  for (const file of walkSources(SRC_ROOT)) {
    const src = fs.readFileSync(file, "utf-8");
    if (!src.includes("FROM agents")) continue;
    for (const stmt of extractAgentSelects(src)) {
      if (!isBindingHydrator(stmt)) continue;
      if (LOCALE_FREE.some((re) => re.test(stmt))) continue;
      hydrators.push({ file: path.relative(SRC_ROOT, file), stmt });
    }
  }

  it("all name language and timezone", () => {
    const offenders = hydrators
      .filter(({ stmt }) => !/\blanguage\b/.test(stmt) || !/\btimezone\b/.test(stmt))
      .map(({ file, stmt }) => `${file}: ${stmt}`);
    expect(offenders).toEqual([]);
  });

  // Without this the test above passes vacuously the moment a refactor moves a
  // SELECT somewhere the walker doesn't reach, or rewrites one into a shape
  // `isBindingHydrator` stops recognizing.
  it("finds both known readers (guards the scanner itself)", () => {
    expect(hydrators.map((h) => h.file).sort()).toEqual([
      "portal/adapter.ts",
      "portal/chat-gateway.ts",
    ]);
  });

  /**
   * `GET /api/internal/siclaw/agent/:agentId/model-binding` (adapter.ts) is the
   * HTTP mirror of the `config.getModelBinding` WS handler, and it is BEHIND:
   * it has projected neither `system_prompt` (since #330 added it to the WS
   * side) nor the locale columns. Nothing in this repo fetches it.
   *
   * It is therefore excluded by shape rather than by an exception above — and
   * pinned here, so bringing it to parity is a deliberate decision that trips
   * this test instead of a silent half-fix that adds locale while
   * `systemPrompt` stays missing.
   */
  it("records that the HTTP mirror is behind, not merely locale-less", () => {
    const adapter = fs.readFileSync(path.join(SRC_ROOT, "portal/adapter.ts"), "utf-8");
    const mirror = extractAgentSelects(adapter).filter(
      (s) => /\bmodel_provider\b/.test(s) && !/\bsystem_prompt\b/.test(s),
    );
    expect(mirror.length).toBeGreaterThan(0);
    for (const stmt of mirror) {
      expect(stmt).not.toMatch(/\blanguage\b/);
    }
  });
});
