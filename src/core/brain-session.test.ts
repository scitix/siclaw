import { describe, it, expect } from "vitest";
import type {
  BrainType,
  BrainModelInfo,
  BrainContextUsage,
  BrainSessionStats,
  BrainSession,
} from "./brain-session.js";

// This module is a type/interface surface. We assert that a conforming
// in-memory implementation satisfies the interface shape and that type
// aliases accept expected values.

describe("BrainSession interface", () => {
  it("type BrainType accepts 'pi-agent'", () => {
    const t: BrainType = "pi-agent";
    expect(t).toBe("pi-agent");
  });

  it("BrainModelInfo accepts complete model record", () => {
    const info: BrainModelInfo = {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      provider: "anthropic",
      contextWindow: 200_000,
      maxTokens: 8192,
      reasoning: false,
    };
    expect(info.contextWindow).toBe(200_000);
  });

  it("BrainContextUsage keeps numeric fields", () => {
    const u: BrainContextUsage = { tokens: 100, contextWindow: 1000, percent: 10 };
    expect(u.percent).toBe(10);
  });

  it("BrainSessionStats.tokens has 5 numeric sub-fields", () => {
    const s: BrainSessionStats = {
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      cost: 0.01,
    };
    expect(s.tokens.total).toBe(10);
  });

  it("minimal BrainSession implementation satisfies the interface", async () => {
    let text = "";
    const fake: BrainSession = {
      brainType: "pi-agent",
      async prompt(t) { text = t; },
      async abort() {},
      subscribe() { return () => {}; },
      async reload() {},
      async steer() {},
      clearQueue() { return { steering: [], followUp: [] }; },
      getContextUsage() { return undefined; },
      getSessionStats() { return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }; },
      getModel() { return undefined; },
      async setModel() {},
      findModel() { return undefined; },
    };

    await fake.prompt("hi");
    expect(text).toBe("hi");
    expect(fake.brainType).toBe("pi-agent");
    expect(fake.clearQueue()).toEqual({ steering: [], followUp: [] });
    expect(fake.getSessionStats().cost).toBe(0);
    expect(fake.findModel("x", "y")).toBeUndefined();
  });

  it("registerProvider is optional", () => {
    const fake: BrainSession = {
      brainType: "pi-agent",
      async prompt() {},
      async abort() {},
      subscribe() { return () => {}; },
      async reload() {},
      async steer() {},
      clearQueue() { return { steering: [], followUp: [] }; },
      getContextUsage() { return undefined; },
      getSessionStats() { return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }; },
      getModel() { return undefined; },
      async setModel() {},
      findModel() { return undefined; },
      // no registerProvider
    };
    expect(fake.registerProvider).toBeUndefined();
  });
});
