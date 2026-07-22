import { describe, expect, it, vi } from "vitest";
import type { SiclawA2aApi } from "./a2a-client.js";
import { AgentRouter, RoutingError } from "./router.js";

function fakeApi(): SiclawA2aApi {
  return {
    sendMessage: vi.fn(),
    getTask: vi.fn(),
    cancelTask: vi.fn(),
    listTasks: vi.fn(),
    waitForTask: vi.fn(),
  } as unknown as SiclawA2aApi;
}

function router(aliases: string[]): AgentRouter {
  return new AgentRouter(aliases.map((alias) => ({ alias, agentId: `agent-${alias}`, api: fakeApi() })));
}

describe("AgentRouter", () => {
  it("rejects an empty or duplicated configuration", () => {
    expect(() => new AgentRouter([])).toThrow(RoutingError);
    expect(() => router(["sre", "sre"])).toThrow(/Duplicate agent alias/);
  });

  it("preserves alias order and describes agents by id, never a key", () => {
    const r = router(["sre", "kb"]);
    expect(r.aliases).toEqual(["sre", "kb"]);
    expect(r.isSingle).toBe(false);
    expect(r.describeAgents()).toBe("sre = agent-sre, kb = agent-kb");
  });

  it("makes the agent optional for a single configured key", () => {
    const r = router(["default"]);
    expect(r.selectExplicit(undefined).alias).toBe("default");
    expect(r.selectExplicit("default").alias).toBe("default");
    expect(() => r.selectExplicit("other")).toThrow(/Unknown agent alias "other"/);
  });

  it("refuses to guess an agent for a create call when several exist", () => {
    const r = router(["sre", "kb"]);
    expect(() => r.selectExplicit(undefined)).toThrow(/Multiple Siclaw agents/);
    expect(r.selectExplicit("kb").alias).toBe("kb");
  });

  it("routes a task to its recorded creator regardless of the argument", () => {
    const r = router(["sre", "kb"]);
    r.remember("t1", "kb");
    expect(r.selectForTask("t1", undefined)).toEqual({ entry: expect.objectContaining({ alias: "kb" }) });

    const mismatched = r.selectForTask("t1", "sre");
    expect(mismatched.entry.alias).toBe("kb");
    expect(mismatched.note).toMatch(/Routed to agent "kb".*ignored agent="sre"/);
  });

  it("still validates a bogus argument even when the mapping wins", () => {
    const r = router(["sre", "kb"]);
    r.remember("t1", "kb");
    expect(() => r.selectForTask("t1", "ghost")).toThrow(/Unknown agent alias "ghost"/);
  });

  it("requires an agent for an untracked task under multiple keys", () => {
    const r = router(["sre", "kb"]);
    expect(() => r.selectForTask("t9", undefined)).toThrow(/was not created in this session/);
    expect(r.selectForTask("t9", "sre").entry.alias).toBe("sre");
  });

  it("uses the sole agent for an untracked task under a single key", () => {
    const r = router(["default"]);
    expect(r.selectForTask("t9", undefined).entry.alias).toBe("default");
  });
});
