import { describe, it, expect, vi } from "vitest";
import { ToolRegistry, type ChannelMessageRequest, type ToolRefs } from "../../core/tool-registry.js";
import { createChannelUpdateTool, registration } from "./channel-update.js";

function makeRefs(executor: ToolRefs["channelMessageExecutor"]): ToolRefs {
  return {
    kubeconfigRef: {} as any,
    userId: "user-1",
    agentId: "agent-1",
    sessionIdRef: { current: "sess-1" },
    taskListId: "tl-1",
    memoryRef: {} as any,
    dpStateRef: {} as any,
    channelMessageExecutor: executor,
  };
}

const text = (r: any) => (r.content[0] as any).text as string;

describe("channel_update tool", () => {
  it("is channel-only and unavailable without a channel message executor", () => {
    expect(registration.modes).toEqual(["channel"]);
    expect(registration.available?.(makeRefs(undefined))).toBe(false);
    expect(registration.available?.(makeRefs(vi.fn() as any))).toBe(true);

    const registry = new ToolRegistry();
    registry.register(registration);
    const webTools = registry.resolve({ mode: "web", refs: makeRefs(vi.fn() as any), allowedTools: null });
    const channelTools = registry.resolve({ mode: "channel", refs: makeRefs(vi.fn() as any), allowedTools: null });
    expect(webTools.map((tool) => tool.name)).not.toContain("channel_update");
    expect(channelTools.map((tool) => tool.name)).toContain("channel_update");
  });

  it("is suppressed on a delegated turn even in channel mode", () => {
    const delegatedRefs: ToolRefs = { ...makeRefs(vi.fn() as any), delegation: { delegationId: "d1", readOnly: true } };
    expect(registration.available?.(delegatedRefs)).toBe(false);

    const registry = new ToolRegistry();
    registry.register(registration);
    const channelTools = registry.resolve({ mode: "channel", refs: delegatedRefs, allowedTools: null });
    expect(channelTools.map((t) => t.name)).not.toContain("channel_update");
  });

  it("maps concise params to the injected Gateway-owned executor", async () => {
    let captured: ChannelMessageRequest | undefined;
    const executor = vi.fn(async (req: ChannelMessageRequest) => {
      captured = req;
      return { delivered: true, message: "accepted" };
    });
    const tool = createChannelUpdateTool(makeRefs(executor));

    const r = await tool.execute("call-1", { text: "  已完成节点列表检查。  " });

    expect(captured).toEqual({
      sessionId: "sess-1",
      kind: "milestone",
      text: "已完成节点列表检查。",
    });
    expect(text(r)).toBe("accepted");
    expect((r.details as any).delivered).toBe(true);
  });

  it("passes through explicit final/artifact kinds", async () => {
    const executor = vi.fn(async () => ({ delivered: true, message: "ok" }));
    const tool = createChannelUpdateTool(makeRefs(executor));

    await tool.execute("call-final", { kind: "final", text: "最终结论" });
    await tool.execute("call-artifact", { kind: "artifact", text: "已生成图片" });

    expect(executor.mock.calls[0][0]).toMatchObject({ kind: "final", text: "最终结论" });
    expect(executor.mock.calls[1][0]).toMatchObject({ kind: "artifact", text: "已生成图片" });
  });

  it("rejects empty visible text before calling the executor", async () => {
    const executor = vi.fn();
    const tool = createChannelUpdateTool(makeRefs(executor as any));

    const r = await tool.execute("call-empty", { text: "   " });

    expect(executor).not.toHaveBeenCalled();
    expect(text(r)).toMatch(/non-empty text/i);
    expect((r.details as any).delivered).toBe(false);
  });

  it("returns an explicit not-available result if called without runtime wiring", async () => {
    const tool = createChannelUpdateTool(makeRefs(undefined));

    const r = await tool.execute("call-missing", { text: "hello" });

    expect(text(r)).toMatch(/not available/i);
    expect((r.details as any).delivered).toBe(false);
  });
});
