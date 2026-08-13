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
import { STRUCTURED_RESULT_TOOL_NAME } from "./structured-result.js";
import type { ToolRefs } from "./tool-registry.js";

// Contract-bound tools are authorized by their per-agent resource binding and
// projected into allowedTools before registry resolution. They must not grow a
// second, independently configurable capability switch.
const BINDING_GRANTED_TOOLS = new Set<string>([STRUCTURED_RESULT_TOOL_NAME]);

describe("capability-group registry coverage", () => {
  it("every registered tool belongs to some capability group", () => {
    const grouped = new Set(Object.values(CAPABILITY_GROUPS).flat());
    // Minimal stub: tool factories read executor refs lazily inside execute(),
    // not at construction, so an empty-ish refs object is enough to read .name.
    const stubRefs = { sessionIdRef: { current: "coverage-probe" } } as unknown as ToolRefs;

    const missing: string[] = [];
    for (const entry of allToolEntries) {
      const name = entry.create(stubRefs).name;
      if (!grouped.has(name) && !BINDING_GRANTED_TOOLS.has(name)) missing.push(name);
    }

    expect(missing).toEqual([]);
  });
});
