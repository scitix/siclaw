import { expect, it } from "vitest";
import { parseHandoffPolicy } from "./agent-handoff.js";
it("snapshots per-request policy and fails closed on malformed data", () => {
  const source = { remaining: 1, visitedAgentIds: ["a", "b"], history: [{ from: "a", to: "b", brief: "check" }] };
  const parsed = parseHandoffPolicy(source)!;
  source.visitedAgentIds.push("c"); source.history[0].brief = "changed";
  expect(parsed.visitedAgentIds).toEqual(["a", "b"]);
  expect(parsed.history[0].brief).toBe("check");
  for (const value of [null, {}, { ...parsed, remaining: -1 }, { ...parsed, remaining: 100 }, { ...parsed, history: [null] }]) {
    expect(() => parseHandoffPolicy(value)).toThrow("Invalid conversation handoff policy");
  }
  expect(parseHandoffPolicy(undefined)).toBeUndefined();
});
