import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for reverse delegation invalidation — the coordinators that delegate to a
 * changed member (sre/peer) agent must be notified to reload their toolset (→ roster
 * re-fetch), the SAME treatment the member itself gets. These tests assert the notify
 * ACTUALLY fires (a prior regression let the query throw inside a catch, so the green
 * suite verified nothing).
 */

let dbQueryImpl: (sql: string, params: unknown[]) => Promise<[unknown[], unknown]>;
vi.mock("../gateway/db.js", () => ({
  getDb: () => ({ query: (sql: string, params: unknown[]) => dbQueryImpl(sql, params) }),
}));

import { notifyCoordinatorsForMembers, collectDependentCoordinators, notifyCoordinators } from "./coordinator-invalidation.js";

function makeConnMap() {
  return { notify: vi.fn(), notifyMany: vi.fn(), sendCommand: vi.fn() } as any;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("notifyCoordinatorsForMembers", () => {
  it("notifies each coordinator referencing the members with a tools reload", async () => {
    dbQueryImpl = async (sql, params) => {
      expect(sql).toMatch(/agent_delegates/);
      expect(sql).toMatch(/member_agent_id IN/);
      expect(params).toEqual(["m1", "m2"]);
      return [[{ coordinator_agent_id: "coordA" }, { coordinator_agent_id: "coordB" }], undefined];
    };
    const cm = makeConnMap();
    await notifyCoordinatorsForMembers(cm, ["m1", "m2"]);
    expect(cm.notify).toHaveBeenCalledTimes(2);
    expect(cm.notify).toHaveBeenCalledWith("coordA", "agent.reload", { agentId: "coordA", resources: ["tools"] });
    expect(cm.notify).toHaveBeenCalledWith("coordB", "agent.reload", { agentId: "coordB", resources: ["tools"] });
  });

  it("de-dupes member ids and no-ops on an empty/blank list (no DB query)", async () => {
    let queried = false;
    dbQueryImpl = async () => { queried = true; return [[], undefined]; };
    const cm = makeConnMap();
    await notifyCoordinatorsForMembers(cm, []);
    await notifyCoordinatorsForMembers(cm, ["", ""]);
    expect(queried).toBe(false);
    expect(cm.notify).not.toHaveBeenCalled();
  });

  it("swallows a DB error (best-effort — never fails the triggering mutation)", async () => {
    dbQueryImpl = async () => { throw new Error("db down"); };
    const cm = makeConnMap();
    await expect(notifyCoordinatorsForMembers(cm, ["m1"])).resolves.toBeUndefined();
    expect(cm.notify).not.toHaveBeenCalled();
  });
});

describe("collectDependentCoordinators / notifyCoordinators (split for delete ordering)", () => {
  it("collect resolves + de-dupes coordinator ids; notify sends each a tools reload", async () => {
    dbQueryImpl = async () => [[{ coordinator_agent_id: "coordA" }, { coordinator_agent_id: "coordA" }, { coordinator_agent_id: "coordB" }], undefined];
    const ids = await collectDependentCoordinators(["m1"]);
    expect(ids).toEqual(["coordA", "coordA", "coordB"]); // raw rows (SELECT DISTINCT dedupes in prod)

    const cm = makeConnMap();
    notifyCoordinators(cm, ids);
    // notify de-dupes defensively → coordA once, coordB once.
    expect(cm.notify).toHaveBeenCalledTimes(2);
    expect(cm.notify).toHaveBeenCalledWith("coordA", "agent.reload", { agentId: "coordA", resources: ["tools"] });
    expect(cm.notify).toHaveBeenCalledWith("coordB", "agent.reload", { agentId: "coordB", resources: ["tools"] });
  });

  it("collect returns [] on empty input (no query) and on a DB error", async () => {
    let queried = false;
    dbQueryImpl = async () => { queried = true; return [[], undefined]; };
    expect(await collectDependentCoordinators([])).toEqual([]);
    expect(queried).toBe(false);
    dbQueryImpl = async () => { throw new Error("db down"); };
    expect(await collectDependentCoordinators(["m1"])).toEqual([]);
  });

  it("notifyCoordinators is a no-op on an empty list", () => {
    const cm = makeConnMap();
    notifyCoordinators(cm, []);
    expect(cm.notify).not.toHaveBeenCalled();
  });

  it("isolates a throwing notify: one bad connection neither escapes nor blocks the rest", () => {
    const cm = makeConnMap();
    cm.notify = vi.fn((id: string) => { if (id === "bad") throw new Error("ws send failed"); });
    // Must not throw (callers void this — an escape would be an unhandled rejection).
    expect(() => notifyCoordinators(cm, ["coordA", "bad", "coordB"])).not.toThrow();
    // The good coordinators are still notified despite the bad one in the middle.
    expect(cm.notify).toHaveBeenCalledWith("coordA", "agent.reload", { agentId: "coordA", resources: ["tools"] });
    expect(cm.notify).toHaveBeenCalledWith("coordB", "agent.reload", { agentId: "coordB", resources: ["tools"] });
  });

  it("notifyCoordinatorsForMembers stays resolved (never rejects) when notify throws", async () => {
    dbQueryImpl = async () => [[{ coordinator_agent_id: "bad" }], undefined];
    const cm = makeConnMap();
    cm.notify = vi.fn(() => { throw new Error("ws send failed"); });
    await expect(notifyCoordinatorsForMembers(cm, ["m1"])).resolves.toBeUndefined();
  });
});
