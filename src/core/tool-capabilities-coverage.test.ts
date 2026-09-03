// Coverage guard: every tool in the registry (allToolEntries) must belong to
// some CAPABILITY_GROUPS entry. A registered-but-ungrouped tool can never be
// reached by a restricted agent (and "Select All" can't grant it either),
// silently dropping a capability — exactly the regression that the Feishu merge
// introduced for `channel_update`. This test fails loudly with the offending
// name the moment a new tool is added without a group.
//
// Lives in its own file (not tool-capabilities.test.ts) so the heavy
// allToolEntries import graph stays out of the pure-module unit test.
import { describe, it, expect } from "vitest";
import { allToolEntries } from "../tools/all-entries.js";
import { CAPABILITY_GROUPS } from "./tool-capabilities.js";
import { effectForTool, type ToolRefs } from "./tool-registry.js";

// Tools deliberately left out of every group, with the reason. Keep EMPTY unless
// a tool is intentionally ungovernable by capability groups (none today).
const INTENTIONALLY_UNGROUPED = new Set<string>([]);

describe("capability-group registry coverage", () => {
  it("every registered tool belongs to some capability group", () => {
    const grouped = new Set(Object.values(CAPABILITY_GROUPS).flat());
    // Minimal stub: most tool factories read executor refs lazily inside
    // execute(). Dynamic per-session tools need a sentinel definition so this
    // static catalog probe can still read their name without making them
    // available in sessions that lack the real runtime dependency.
    const stubRefs = {
      sessionIdRef: { current: "coverage-probe" },
      sessionEventEmitter: () => {},
      knowledgeCitationTool: { name: "knowledge_cite" },
    } as unknown as ToolRefs;

    const missing: string[] = [];
    for (const entry of allToolEntries) {
      const name = entry.create(stubRefs).name;
      if (!grouped.has(name) && !INTENTIONALLY_UNGROUPED.has(name)) missing.push(name);
    }

    expect(missing).toEqual([]);
  });
});

/**
 * TOOL_EFFECTS (the guard's by-name lookup) and ToolEntry.effect (the annotation
 * carried onto a resolved definition) describe the same fact and must never
 * disagree — a tool declared external_write on its registration but missing from
 * the map would be gated in one code path and waved through in the other.
 *
 * Lives here rather than in tool-registry.test.ts because reading an entry's
 * NAME means instantiating it, which needs the heavy allToolEntries graph this
 * file already imports.
 */
describe("declared effect consistency", () => {
  it("agrees with TOOL_EFFECTS for every registered tool", () => {
    const stubRefs = {
      sessionIdRef: { current: "effect-probe" },
      sessionEventEmitter: () => {},
      knowledgeCitationTool: { name: "knowledge_cite" },
    } as unknown as ToolRefs;

    const disagreements: string[] = [];
    for (const entry of allToolEntries) {
      const name = entry.create(stubRefs).name;
      const declared = entry.effect ?? "observe";
      const mapped = effectForTool(name);
      if (declared !== mapped) {
        disagreements.push(`${name}: registration says "${declared}", TOOL_EFFECTS says "${mapped}"`);
      }
    }

    expect(disagreements).toEqual([]);
  });
});
