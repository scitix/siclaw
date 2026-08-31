import { describe, expect, it } from "vitest";
import { redactToolset, ToolsetCapture } from "./toolset-capture.js";

describe("ToolsetCapture", () => {
  it("wraps one assistant LLM round without inventing a toolset id", () => {
    const capture = new ToolsetCapture();
    capture.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-a", name: "bash", arguments: { command: "date" } },
          { type: "toolCall", id: "call-b", name: "node_exec", arguments: '{"command":"uptime"}' },
        ],
      },
    });

    const first = capture.match({ type: "tool_execution_start", toolCallId: "call-a" });
    const second = capture.match({ type: "tool_execution_start", toolCallId: "call-b" });
    expect(first?.toolset).toEqual(second?.toolset);
    expect(first?.toolset).toEqual({
      version: 1,
      llm_round: 1,
      tool_calls: [
        { tool_call_id: "call-a", position: 0, tool_name: "bash", tool_input: '{"command":"date"}' },
        { tool_call_id: "call-b", position: 1, tool_name: "node_exec", tool_input: '{"command":"uptime"}' },
      ],
    });
    expect(first?.toolset).not.toHaveProperty("id");
    expect(first?.toolset).not.toHaveProperty("toolset_id");
  });

  it("counts every assistant message as an LLM round but never groups missing invocation ids", () => {
    const capture = new ToolsetCapture();
    capture.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "thinking" }] } });
    capture.observe({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "bash", args: {} }] },
    });
    expect(capture.match({ toolCallId: "call-2" })?.toolset.llm_round).toBe(2);
    expect(capture.match({ toolName: "bash" })).toBeNull();
  });

  it("redacts persisted inputs without mutating the captured envelope", () => {
    const capture = new ToolsetCapture();
    capture.observe({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", args: { token: "secret" } }] },
    });
    const original = capture.match({ toolCallId: "c" })!.toolset;
    const redacted = redactToolset(original, (value) => value.replace("secret", "[REDACTED]"));
    expect(redacted.tool_calls[0].tool_input).toContain("[REDACTED]");
    expect(original.tool_calls[0].tool_input).toContain("secret");
  });
});
