import { describe, it, expect } from "vitest";
import { modelNeedsRebind } from "./brain-session.js";
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


describe("modelNeedsRebind", () => {
  const base: BrainModelInfo = {
    id: "claude-sonnet-5",
    name: "claude-sonnet-5",
    provider: "scitix",
    contextWindow: 1000000,
    maxTokens: 65536,
    reasoning: true,
    api: "openai-completions",
    maxTokensField: "max_tokens",
  };

  it("rebinds when nothing is bound yet", () => {
    expect(modelNeedsRebind(undefined, base)).toBe(true);
  });

  it("does not rebind an identical model", () => {
    expect(modelNeedsRebind(base, { ...base })).toBe(false);
  });

  // The regression this function exists for: toggling a per-model api_type
  // override in Portal changes ONLY the protocol. Every other field stays
  // identical, so a comparison that omits `api` reports "no change" — the
  // session keeps the previously-bound model object and the provider rejects
  // the turn with unsupported_protocol, i.e. the exact 400 the per-model
  // override was built to fix, reappearing one layer down.
  it("rebinds when only the wire protocol changed", () => {
    expect(modelNeedsRebind(base, { ...base, api: "anthropic-messages" })).toBe(true);
  });

  it("rebinds when the protocol appears or disappears", () => {
    expect(modelNeedsRebind({ ...base, api: undefined }, base)).toBe(true);
    expect(modelNeedsRebind(base, { ...base, api: undefined })).toBe(true);
  });

  it.each([
    ["id", { id: "claude-opus-4-8" }],
    ["provider", { provider: "other-provider" }],
    ["reasoning", { reasoning: false }],
    ["contextWindow", { contextWindow: 200000 }],
    ["maxTokens", { maxTokens: 8192 }],
  ])("rebinds when %s changed", (_field, patch) => {
    expect(modelNeedsRebind(base, { ...base, ...patch } as BrainModelInfo)).toBe(true);
  });

  it("ignores display name — it does not affect how a turn is issued", () => {
    expect(modelNeedsRebind(base, { ...base, name: "Claude Sonnet 5" })).toBe(false);
  });

  // The same failure one layer down: a max-tokens-field correction also leaves
  // every other compared attribute identical, so a check that omits it skips
  // setModel and the fix looks applied everywhere except in the actual request.
  it("rebinds when only the max-tokens field changed", () => {
    expect(modelNeedsRebind(base, { ...base, maxTokensField: "max_completion_tokens" })).toBe(true);
  });

  it("rebinds when the max-tokens field appears or disappears", () => {
    // A descriptor that stopped stating the field is not the same binding as
    // one that stated it — don't silently keep the old value.
    expect(modelNeedsRebind({ ...base, maxTokensField: undefined }, base)).toBe(true);
    expect(modelNeedsRebind(base, { ...base, maxTokensField: undefined })).toBe(true);
  });
});
