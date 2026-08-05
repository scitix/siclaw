/**
 * Source-level invariant — anything that forwards the agent's `systemPrompt`
 * toward a prompt must forward its `language` and `timezone` too.
 *
 * The three values come from the same binding and play the same role: "the
 * agent's own config for this turn". But each entry point builds its own
 * options object, and every one of these fields is optional — so an entry that
 * forwards one and not the others compiles, type-checks, and passes every unit
 * test while silently telling the model the time in UTC.
 *
 * That is not hypothetical. This feature hit the same class of bug three times:
 *
 *   1. Two readers of agent config; only the RPC one gained the columns, so
 *      Portal web chat and a2a sent `undefined` (see
 *      `portal/binding-locale-invariants.test.ts`).
 *   2. The adapter's HTTP `/model-binding` mirror, behind since #330.
 *   3. FIVE prompt entry points — Feishu, DingTalk, cron, delegate, a2a — none
 *      of which forwarded locale, so every one of them reported UTC regardless
 *      of how the agent was configured. Feishu is the most-used path.
 *
 * `systemPrompt` is the marker because it is the field nobody forgets: it is
 * visible in the reply the moment it goes missing, whereas a wrong timezone
 * just makes the agent quietly wrong about the date.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Scan all of src/: a new entry point under portal/ or lib/ must not be
// invisible here while the pin below still lists five files.
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
 * Object literals that set a systemPrompt-ish key, returned with the lines that
 * follow — enough to see its siblings without parsing TypeScript.
 *
 * `systemPromptTemplate:` is the AgentBox `PromptOptions` spelling;
 * `systemPrompt:` is the `chat.send` params spelling. Both hand the value to
 * the same place in the end.
 *
 * SHORTHAND counts (`systemPromptTemplate,` with the value in a local of the
 * same name) — dingtalk.ts writes it that way, and a scan that only understood
 * `key: value` reported it as having no site at all, which reads identically to
 * "correctly forwards" in a pass/fail list.
 */
/**
 * How far past the marker to look for its siblings. These option objects are
 * small, but a comment between the fields pushes them apart — 12 was too tight
 * and reported `server.ts` as an offender when its `timezone` was one line past
 * the edge.
 */
const WINDOW_LINES = 24;

function extractForwardingSites(src: string): { key: string; window: string }[] {
  const out: { key: string; window: string }[] = [];
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    const m = /^\s*(systemPromptTemplate|systemPrompt)(?::\s*(.+?))?,?\s*$/.exec(line);
    if (!m) return;
    // Shorthand has no right-hand side to type-check; it is always a real value.
    if (m[2] === undefined) {
      out.push({ key: m[1], window: lines.slice(i, i + WINDOW_LINES).join("\n") });
      return;
    }
    // A function parameter and an interface field are spelled the same way as an
    // object property, so skip the ones whose right-hand side is a TYPE. Without
    // this the scan reports every signature that happens to take a system prompt.
    if (/^(?:string|number|boolean|undefined|null|unknown|any)(?:\s*\|\s*(?:string|number|boolean|undefined|null|unknown|any))*;?$/.test(m[2])) return;
    out.push({ key: m[1], window: lines.slice(i, i + WINDOW_LINES).join("\n") });
  });
  return out;
}

/**
 * Sites that legitimately forward no locale.
 *
 * - `agentbox/session.ts`: a sub-agent's session is built INSIDE the box, which
 *   has no binding to read — it resolves locale from the parent conversation's
 *   own memory instead (`buildInSessionPrompt`).
 * - `gateway/server.ts`: reads the values off `params`, so the keys appear
 *   as `params.language` rather than beside `systemPromptTemplate`. Asserted
 *   separately below so it is covered, not excused.
 * - `portal/cli-snapshot-api.ts`: the TUI runs on the operator's own machine,
 *   which has its own clock and locale. Sending an agent's defaults there would
 *   override a correct local answer with a worse remote one.
 */
const NOT_A_BINDING_FORWARDER = ["agentbox/session.ts", "portal/cli-snapshot-api.ts"];

describe("locale must travel with systemPrompt on every prompt entry", () => {
  const sites: { file: string; key: string; window: string }[] = [];
  for (const file of walkSources(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file);
    if (NOT_A_BINDING_FORWARDER.includes(rel)) continue;
    const src = fs.readFileSync(file, "utf-8");
    for (const site of extractForwardingSites(src)) {
      sites.push({ file: rel, ...site });
    }
  }

  it("every forwarding site also forwards language and timezone", () => {
    const offenders = sites
      .filter((s) => !/\blanguage\b/.test(s.window) || !/\btimezone\b/.test(s.window))
      .map((s) => `${s.file} (${s.key})`);
    expect(offenders).toEqual([]);
  });

  // Without this the test above passes vacuously as soon as a refactor renames a
  // key or moves a site somewhere the walker does not reach.
  //
  // The list mixes two kinds of site, and that is deliberate — both must carry
  // the fields for a turn to end up with them. The four `gateway/*` files plus
  // `portal/a2a-gateway.ts` FORWARD a binding toward a prompt; `adapter.ts` and
  // the first `chat-gateway.ts` site BUILD the binding in the first place.
  it("finds every known entry point (guards the scanner itself)", () => {
    expect([...new Set(sites.map((s) => s.file))].sort()).toEqual([
      "gateway/channels/dingtalk.ts",
      "gateway/channels/lark.ts",
      "gateway/delegate-api.ts",
      "gateway/server.ts",
      "gateway/task-coordinator.ts",
      "portal/a2a-gateway.ts",
      "portal/adapter.ts",
      "portal/chat-gateway.ts",
    ]);
  });

  // `server.ts` is the far end of the Portal web and a2a paths: it takes the
  // values off `params` rather than a binding, so the generic scan above sees
  // them but this states the contract plainly.
  it("server.ts reads all three off params", () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, "gateway/server.ts"), "utf-8");
    for (const field of ["systemPrompt", "language", "timezone", "clientTimezone"]) {
      expect(src).toContain(`params.${field}`);
    }
  });
});
