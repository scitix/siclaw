import { describe, it, expect } from "vitest";
import { dropThinkingBlocks } from "./thinking-blocks.js";

describe("dropThinkingBlocks", () => {
  it("returns original reference when no thinking blocks present", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it("strips thinking blocks from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think..." },
          { type: "text", text: "Here is the answer" },
        ],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = dropThinkingBlocks(messages);
    expect(result).not.toBe(messages);
    expect(result[0].content).toHaveLength(1);
    expect(result[0].content[0].type).toBe("text");
    expect(result[0].content[0].text).toBe("Here is the answer");
  });

  it("replaces empty content with synthetic text block when all blocks are thinking", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Internal reasoning" }],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = dropThinkingBlocks(messages);
    expect(result).not.toBe(messages);
    expect(result[0].content).toHaveLength(1);
    expect(result[0].content[0]).toEqual({ type: "text", text: "" });
  });

  it("does not modify user or toolResult messages", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: Date.now() },
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "result" }],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it("handles multiple assistant messages with mixed content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "step 1" },
          { type: "text", text: "response 1" },
        ],
        timestamp: Date.now(),
      },
      { role: "user", content: "ok", timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "response 2" }],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = dropThinkingBlocks(messages);
    expect(result).not.toBe(messages);
    expect(result[0].content).toHaveLength(1);
    expect(result[0].content[0].text).toBe("response 1");
    // Unmodified assistant message should keep original reference
    expect(result[2]).toBe(messages[2]);
  });

  it("handles assistant messages without array content", () => {
    const messages = [
      { role: "assistant", content: "plain string", timestamp: Date.now() },
    ] as any[];
    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages);
  });
});
