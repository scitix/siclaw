import { describe, it, expect } from "vitest";
import {
  getSubagentType, listSubagentTypes, DEFAULT_SUBAGENT_TYPE, SUBAGENT_ALWAYS_DENIED_TOOLS,
} from "./subagent-registry.js";

describe("subagent-registry", () => {
  it("has a general-purpose default type", () => {
    expect(DEFAULT_SUBAGENT_TYPE).toBe("general-purpose");
    expect(getSubagentType("general-purpose")?.agentType).toBe("general-purpose");
  });

  it("resolves undefined/empty to the default type", () => {
    expect(getSubagentType()?.agentType).toBe(DEFAULT_SUBAGENT_TYPE);
    expect(getSubagentType("")?.agentType).toBe(DEFAULT_SUBAGENT_TYPE);
    expect(getSubagentType("  ")?.agentType).toBe(DEFAULT_SUBAGENT_TYPE);
  });

  it("returns undefined for an unknown explicit type", () => {
    expect(getSubagentType("does-not-exist")).toBeUndefined();
  });

  it("listSubagentTypes includes the default and each carries whenToUse", () => {
    const types = listSubagentTypes();
    expect(types.length).toBeGreaterThanOrEqual(1);
    expect(types.some(t => t.agentType === DEFAULT_SUBAGENT_TYPE)).toBe(true);
    for (const t of types) expect(t.whenToUse.length).toBeGreaterThan(0);
  });

  it("always denies spawn_subagent (no recursion)", () => {
    expect(SUBAGENT_ALWAYS_DENIED_TOOLS).toContain("spawn_subagent");
  });
});
