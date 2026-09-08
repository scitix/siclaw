import { describe, expect, it, vi } from "vitest";
import type { BrainSession } from "../core/brain-session.js";
import { runSubagentToAcceptance } from "./subagent-completion.js";

function fixture(statuses: string[]) {
  const brain = { prompt: vi.fn(async () => {}), assessTaskCompletion: vi.fn(async () => ({ status: statuses.shift() ?? "incomplete", reason: "Missing node evidence" })) } as unknown as BrainSession;
  const reviewing = vi.fn();
  const run = (overrides = {}) => runSubagentToAcceptance({ brain, prompt: "Check node", assignment: "Check all interfaces", stopped: () => false, stopReason: () => "stop", reviewing, ...overrides });
  return { brain, reviewing, run };
}
describe("subagent task acceptance", () => {
  it("continues an intent-only final answer in the same session before accepting", async () => {
    const f = fixture(["incomplete", "complete"]);
    expect(await f.run()).toEqual({ accepted: true });
    expect(f.brain.prompt).toHaveBeenCalledTimes(2);
    expect(f.brain.prompt).toHaveBeenLastCalledWith(expect.stringContaining("Missing node evidence"));
    expect(f.reviewing.mock.calls).toEqual([[true], [false], [true], [false]]);
  });
  it("accepts evidence-backed analysis without requiring any tool calls", async () => {
    const f = fixture(["complete"]);
    expect((await f.run()).accepted).toBe(true);
    expect(f.brain.prompt).toHaveBeenCalledTimes(1);
  });
  it("bounds incomplete repairs to two and never reports them done", async () => {
    const f = fixture([]);
    expect((await f.run()).accepted).toBe(false);
    expect(f.brain.prompt).toHaveBeenCalledTimes(3);
  });
  it("does not retry an external blocker", async () => {
    const f = fixture(["blocked"]);
    expect((await f.run()).accepted).toBe(false);
    expect(f.brain.prompt).toHaveBeenCalledTimes(1);
  });
  it("does not turn an invalid assessment into success", async () => {
    const f = fixture([]);
    vi.mocked(f.brain.assessTaskCompletion!).mockRejectedValue(new Error("invalid JSON"));
    expect(await f.run()).toEqual({ accepted: false, reason: "Completion could not be verified" });
    expect(f.reviewing).toHaveBeenLastCalledWith(false);
  });
  it("does not continue after cancellation during assessment", async () => {
    const f = fixture([]); let stopped = false;
    vi.mocked(f.brain.assessTaskCompletion!).mockImplementation(async () => { stopped = true; return { status: "incomplete", reason: "more" }; });
    expect((await f.run({ stopped: () => stopped })).accepted).toBe(false);
    expect(f.brain.prompt).toHaveBeenCalledTimes(1);
  });
  it("continues a length-limited response instead of accepting its fragment", async () => {
    const f = fixture(["complete"]); let count = 0;
    expect((await f.run({ stopReason: () => ++count === 1 ? "length" : "stop" })).accepted).toBe(true);
    expect(f.brain.prompt).toHaveBeenCalledTimes(2);
    expect(f.brain.assessTaskCompletion).toHaveBeenCalledTimes(1);
  });
  it.each(["error", "aborted"])("does not accept a %s response", async stop => {
    const f = fixture(["complete"]);
    expect((await f.run({ stopReason: () => stop })).accepted).toBe(false);
    expect(f.brain.assessTaskCompletion).not.toHaveBeenCalled();
  });
});
