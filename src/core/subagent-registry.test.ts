import { describe, it, expect } from "vitest";
import {
  getSubagentType, listSubagentTypes, DEFAULT_SUBAGENT_TYPE,
  getSubagentMaxRuntimeMs, DEFAULT_SUBAGENT_MAX_RUNTIME_MS,
  getMaxGroupItems, DEFAULT_MAX_GROUP_ITEMS,
  getSubagentGroupMaxRuntimeMs, GROUP_RUNTIME_FLOOR_MS, DEFAULT_GROUP_RUNTIME_HARD_CAP_MS,
  getGroupWorkerShare, getGroupItemBudgetMs, DEFAULT_GROUP_ITEM_BUDGET_MS,
  getGroupHardCapMs, SUBAGENT_GROUP_ENABLED,
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

describe("getMaxGroupItems", () => {
  it("defaults when the env is unset or blank", () => {
    expect(getMaxGroupItems({})).toBe(DEFAULT_MAX_GROUP_ITEMS);
    expect(getMaxGroupItems({ SICLAW_SUBAGENT_GROUP_MAX_ITEMS: "  " })).toBe(DEFAULT_MAX_GROUP_ITEMS);
  });
  it("reads a positive integer", () => {
    expect(getMaxGroupItems({ SICLAW_SUBAGENT_GROUP_MAX_ITEMS: "80" })).toBe(80);
    expect(getMaxGroupItems({ SICLAW_SUBAGENT_GROUP_MAX_ITEMS: "12.7" })).toBe(12);
  });
  it("falls back to the default on invalid / non-positive values", () => {
    expect(getMaxGroupItems({ SICLAW_SUBAGENT_GROUP_MAX_ITEMS: "0" })).toBe(DEFAULT_MAX_GROUP_ITEMS);
    expect(getMaxGroupItems({ SICLAW_SUBAGENT_GROUP_MAX_ITEMS: "-5" })).toBe(DEFAULT_MAX_GROUP_ITEMS);
    expect(getMaxGroupItems({ SICLAW_SUBAGENT_GROUP_MAX_ITEMS: "abc" })).toBe(DEFAULT_MAX_GROUP_ITEMS);
  });
});

describe("getGroupItemBudgetMs / getGroupHardCapMs", () => {
  it("read seconds → ms and fall back on invalid values", () => {
    expect(getGroupItemBudgetMs({})).toBe(DEFAULT_GROUP_ITEM_BUDGET_MS);
    expect(getGroupItemBudgetMs({ SICLAW_SUBAGENT_GROUP_ITEM_BUDGET: "120" })).toBe(120_000);
    expect(getGroupItemBudgetMs({ SICLAW_SUBAGENT_GROUP_ITEM_BUDGET: "0" })).toBe(DEFAULT_GROUP_ITEM_BUDGET_MS);
    expect(getGroupHardCapMs({})).toBe(DEFAULT_GROUP_RUNTIME_HARD_CAP_MS);
    expect(getGroupHardCapMs({ SICLAW_SUBAGENT_GROUP_MAX_RUNTIME: "3600" })).toBe(3_600_000);
    expect(getGroupHardCapMs({ SICLAW_SUBAGENT_GROUP_MAX_RUNTIME: "abc" })).toBe(DEFAULT_GROUP_RUNTIME_HARD_CAP_MS);
  });
});

describe("getSubagentGroupMaxRuntimeMs", () => {
  it("clamps up to the floor for a tiny group (N=1)", () => {
    // waves=1 → 300s + 600s margin = 900s < 1800s floor
    expect(getSubagentGroupMaxRuntimeMs(1, 4, {})).toBe(GROUP_RUNTIME_FLOOR_MS);
  });
  it("scales with size below the cap (N=50, concurrency=4)", () => {
    // waves=ceil(50/4)=13 → 13×300s + 600s = 4500s = 4_500_000ms (between floor and cap)
    expect(getSubagentGroupMaxRuntimeMs(50, 4, {})).toBe(4_500_000);
  });
  it("clamps down to the hard cap for a serial worst case (N=50, concurrency=1)", () => {
    // waves=50 → 50×300s + 600s = 15600s → capped at 7200s
    expect(getSubagentGroupMaxRuntimeMs(50, 1, {})).toBe(DEFAULT_GROUP_RUNTIME_HARD_CAP_MS);
  });
  it("guards degenerate itemCount / concurrency inputs", () => {
    expect(getSubagentGroupMaxRuntimeMs(0, 0, {})).toBe(GROUP_RUNTIME_FLOOR_MS);
    expect(getSubagentGroupMaxRuntimeMs(-3, -1, {})).toBe(GROUP_RUNTIME_FLOOR_MS);
  });
  it("honours an env-tuned hard cap", () => {
    expect(getSubagentGroupMaxRuntimeMs(50, 1, { SICLAW_SUBAGENT_GROUP_MAX_RUNTIME: "3600" })).toBe(3_600_000);
  });
});

describe("getGroupWorkerShare", () => {
  it("is concurrency - 1, floored at 1", () => {
    expect(getGroupWorkerShare({})).toBe(3); // default concurrency 4
    expect(getGroupWorkerShare({ SICLAW_SUBAGENT_CONCURRENCY: "1" })).toBe(1);
    expect(getGroupWorkerShare({ SICLAW_SUBAGENT_CONCURRENCY: "8" })).toBe(7);
  });
});

describe("SUBAGENT_GROUP_ENABLED", () => {
  it("is on by default", () => {
    expect(SUBAGENT_GROUP_ENABLED).toBe(true);
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
