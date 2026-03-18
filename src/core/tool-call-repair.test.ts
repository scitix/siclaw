import { describe, it, expect } from "vitest";
import { repairToolCallInputs } from "./tool-call-repair.js";

describe("repairToolCallInputs", () => {
  it("returns original messages when all tool calls are valid", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: Date.now() },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me search" },
          { type: "toolCall", id: "call_1", name: "memory_search", arguments: { query: "test" } },
        ],
        timestamp: Date.now(),
        stopReason: "toolUse",
      },
    ] as any[];
    const result = repairToolCallInputs(messages);
    expect(result.messages).toBe(messages); // same reference
    expect(result.droppedToolCalls).toBe(0);
  });

  it("drops toolCall blocks with empty id", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me search" },
          { type: "toolCall", id: "", name: "memory_search", arguments: { query: "test" } },
        ],
        timestamp: Date.now(),
        stopReason: "toolUse",
      },
    ] as any[];
    const result = repairToolCallInputs(messages);
    expect(result.droppedToolCalls).toBe(1);
    expect(result.messages[0].content).toHaveLength(1);
    expect(result.messages[0].content[0].type).toBe("text");
  });

  it("drops toolCall blocks with empty name", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "", arguments: {} },
        ],
        timestamp: Date.now(),
        stopReason: "toolUse",
      },
    ] as any[];
    const result = repairToolCallInputs(messages);
    expect(result.droppedToolCalls).toBe(1);
    expect(result.droppedAssistantMessages).toBe(1);
    expect(result.messages).toHaveLength(0);
  });

  it("drops toolCall blocks with missing input/arguments", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "memory_search" },
        ],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = repairToolCallInputs(messages);
    expect(result.droppedToolCalls).toBe(1);
  });

  it("drops toolCall blocks with invalid name characters", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "invalid tool name!", arguments: {} },
        ],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = repairToolCallInputs(messages);
    expect(result.droppedToolCalls).toBe(1);
  });

  it("preserves non-toolCall content blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking..." },
          { type: "toolCall", id: "", name: "", arguments: {} },
          { type: "text", text: "more text" },
        ],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = repairToolCallInputs(messages);
    expect(result.messages[0].content).toHaveLength(2);
    expect(result.messages[0].content[0].text).toBe("thinking...");
    expect(result.messages[0].content[1].text).toBe("more text");
  });

  it("handles toolUse and functionCall types", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "", name: "", input: {} },
          { type: "functionCall", id: "", name: "", arguments: {} },
        ],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = repairToolCallInputs(messages);
    expect(result.droppedToolCalls).toBe(2);
    expect(result.droppedAssistantMessages).toBe(1);
  });

  it("does not modify user or toolResult messages", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: Date.now() },
      { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "result" }], timestamp: Date.now() },
    ] as any[];
    const result = repairToolCallInputs(messages);
    expect(result.messages).toBe(messages);
  });
});
