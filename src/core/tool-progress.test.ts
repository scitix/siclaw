import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { withToolProgress, wantsToolProgress } from "./tool-progress.js";
import { TOOL_PROGRESS_FIELD } from "../shared/tool-progress.js";

const makeTool = () => ({ name: "lookup", label: "lookup", description: "lookup", toolset: "query", requiresUserApproval: true,
  parameters: Type.Object({ name: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  execute: vi.fn(async (..._args: unknown[]) => ({ content: [{ type: "text" as const, text: "ok" }] })),
});

describe("public tool progress", () => {
  it("adds required nonblank prose without changing domain validation or metadata", () => {
    const original = makeTool(); const wrapped = withToolProgress(original);
    expect(Value.Check(wrapped.parameters, { name: "demo" })).toBe(false);
    expect(Value.Check(wrapped.parameters, { name: "demo", [TOOL_PROGRESS_FIELD]: "  " })).toBe(false);
    expect(Value.Check(wrapped.parameters, { name: "demo", [TOOL_PROGRESS_FIELD]: "Check the inventory." })).toBe(true);
    expect(Value.Check(wrapped.parameters, { name: "", [TOOL_PROGRESS_FIELD]: "Check." })).toBe(false);
    expect(Value.Check(wrapped.parameters, { name: "demo", extra: true, [TOOL_PROGRESS_FIELD]: "Check." })).toBe(false);
    expect(wrapped.toolset).toBe("query"); expect(wrapped.requiresUserApproval).toBe(true);
    expect(original.parameters.required).toEqual(["name"]);
  });
  it("strips the communication field before executing and preserves cancellation/update context", async () => {
    const tool = makeTool(); const wrapped = withToolProgress(tool);
    const args = Object.freeze({ name: "demo", [TOOL_PROGRESS_FIELD]: "Check inventory." });
    const signal = new AbortController().signal; const update = vi.fn(); const context = {};
    await wrapped.execute("call", args, signal, update, context);
    expect(tool.execute).toHaveBeenCalledWith("call", { name: "demo" }, signal, update, context);
    expect(args[TOOL_PROGRESS_FIELD]).toBe("Check inventory.");
  });
  it("retains prepareArguments compatibility and isolates communication from that shim", () => {
    const prepareArguments = vi.fn((args: any) => ({ name: args.alias }));
    const tool = withToolProgress({ ...makeTool(), prepareArguments });
    const args = tool.prepareArguments!({ alias: "demo", [TOOL_PROGRESS_FIELD]: "Check." });
    expect(prepareArguments).toHaveBeenCalledWith({ alias: "demo" });
    expect(args).toEqual({ name: "demo", [TOOL_PROGRESS_FIELD]: "Check." });
  });
  it("does not rewrite non-object schemas or reserved-name collisions", () => {
    const union = { ...makeTool(), parameters: Type.Union([Type.String(), Type.Number()]) };
    expect(withToolProgress(union)).toBe(union);
    const collision = { ...makeTool(), parameters: Type.Object({ [TOOL_PROGRESS_FIELD]: Type.Number() }) };
    expect(withToolProgress(collision)).toBe(collision);
    const composed = { ...makeTool(), parameters: { ...makeTool().parameters, allOf: [makeTool().parameters] } };
    expect(withToolProgress(composed)).toBe(composed);
  });
  it("scopes narration to the web owner including handoff targets, not background workers", () => {
    expect(wantsToolProgress({})).toBe(true);
    expect(wantsToolProgress({ mode: "web" })).toBe(true);
    for (const options of [{ mode: "cli" }, { mode: "task" }, { mode: "channel" }, { isSubagent: true }, { delegation: {} }]) {
      expect(wantsToolProgress(options)).toBe(false);
    }
  });
});
