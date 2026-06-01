import { describe, it, expect } from "vitest";
import {
  getSubagentType, listSubagentTypes, DEFAULT_SUBAGENT_TYPE,
  getSubagentMaxRuntimeMs, DEFAULT_SUBAGENT_MAX_RUNTIME_MS,
} from "./subagent-registry.js";

describe("getSubagentMaxRuntimeMs", () => {
  it("defaults to 10 minutes when the env is unset or blank", () => {
    expect(getSubagentMaxRuntimeMs({})).toBe(DEFAULT_SUBAGENT_MAX_RUNTIME_MS);
    expect(getSubagentMaxRuntimeMs({ SICLAW_SUBAGENT_MAX_RUNTIME: "  " })).toBe(DEFAULT_SUBAGENT_MAX_RUNTIME_MS);
  });
  it("reads SICLAW_SUBAGENT_MAX_RUNTIME as seconds → ms", () => {
    expect(getSubagentMaxRuntimeMs({ SICLAW_SUBAGENT_MAX_RUNTIME: "300" })).toBe(300_000);
  });
  it("falls back to the default on invalid / non-positive values", () => {
    expect(getSubagentMaxRuntimeMs({ SICLAW_SUBAGENT_MAX_RUNTIME: "0" })).toBe(DEFAULT_SUBAGENT_MAX_RUNTIME_MS);
    expect(getSubagentMaxRuntimeMs({ SICLAW_SUBAGENT_MAX_RUNTIME: "abc" })).toBe(DEFAULT_SUBAGENT_MAX_RUNTIME_MS);
  });
});

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

  // Recursion prevention is structural (a child is created without the spawn
  // executor) and is asserted in spawn-subagent.test.ts via the `available` guard,
  // not by a deny-list constant here.
});
