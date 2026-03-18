import { describe, it, expect } from "vitest";
import {
  sanitizeToolCallId,
  isValidCloudCodeAssistToolId,
  sanitizeToolCallIdsForCloudCodeAssist,
} from "./tool-call-id.js";

describe("sanitizeToolCallId", () => {
  it("strips non-alphanumeric characters in strict mode", () => {
    expect(sanitizeToolCallId("call_abc-123")).toBe("callabc123");
  });

  it("returns sanitizedtoolid for empty input in strict mode", () => {
    expect(sanitizeToolCallId("")).toBe("defaulttoolid");
    expect(sanitizeToolCallId("---")).toBe("sanitizedtoolid");
  });

  it("truncates to 9 chars in strict9 mode", () => {
    const result = sanitizeToolCallId("call_abcdefgh123", "strict9");
    expect(result).toHaveLength(9);
    expect(result).toMatch(/^[a-zA-Z0-9]+$/);
  });

  it("returns defaultid for empty input in strict9 mode", () => {
    expect(sanitizeToolCallId("", "strict9")).toBe("defaultid");
  });

  it("hashes short inputs in strict9 mode", () => {
    const result = sanitizeToolCallId("ab", "strict9");
    expect(result).toHaveLength(9);
    expect(result).toMatch(/^[a-zA-Z0-9]+$/);
  });
});

describe("isValidCloudCodeAssistToolId", () => {
  it("accepts alphanumeric IDs in strict mode", () => {
    expect(isValidCloudCodeAssistToolId("abc123")).toBe(true);
    expect(isValidCloudCodeAssistToolId("toolcall42")).toBe(true);
  });

  it("rejects non-alphanumeric IDs in strict mode", () => {
    expect(isValidCloudCodeAssistToolId("call_1")).toBe(false);
    expect(isValidCloudCodeAssistToolId("tool-id")).toBe(false);
    expect(isValidCloudCodeAssistToolId("")).toBe(false);
  });

  it("validates strict9 format", () => {
    expect(isValidCloudCodeAssistToolId("abcdefgh1", "strict9")).toBe(true);
    expect(isValidCloudCodeAssistToolId("abc", "strict9")).toBe(false);
    expect(isValidCloudCodeAssistToolId("abcdefghij", "strict9")).toBe(false);
  });
});

describe("sanitizeToolCallIdsForCloudCodeAssist", () => {
  it("returns original reference when all IDs are already valid", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: Date.now() },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "callabc123", name: "test", arguments: {} },
        ],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "callabc123",
        content: [{ type: "text", text: "result" }],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = sanitizeToolCallIdsForCloudCodeAssist(messages, "strict");
    expect(result).toBe(messages);
  });

  it("rewrites non-alphanumeric IDs and preserves pairing", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_abc-123", name: "test", arguments: {} },
        ],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call_abc-123",
        content: [{ type: "text", text: "result" }],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = sanitizeToolCallIdsForCloudCodeAssist(messages, "strict");
    expect(result).not.toBe(messages);
    // Both should have matching rewritten IDs
    const assistantId = result[0].content[0].id;
    const resultId = result[1].toolCallId;
    expect(assistantId).toBe(resultId);
    expect(assistantId).toMatch(/^[a-zA-Z0-9]+$/);
  });

  it("handles duplicate raw IDs by creating unique rewrites", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "tool_a", arguments: {} },
        ],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "result a" }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "tool_b", arguments: {} },
        ],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "result b" }],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = sanitizeToolCallIdsForCloudCodeAssist(messages, "strict");
    // First pair should match
    expect(result[0].content[0].id).toBe(result[1].toolCallId);
    // Second pair should match
    expect(result[2].content[0].id).toBe(result[3].toolCallId);
    // The two pairs should have different IDs
    expect(result[0].content[0].id).not.toBe(result[2].content[0].id);
  });

  it("does not modify user messages", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: Date.now() },
    ] as any[];
    const result = sanitizeToolCallIdsForCloudCodeAssist(messages, "strict");
    expect(result).toBe(messages);
  });

  it("handles toolUseId on toolResult messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "toolu_abc-123", name: "test", input: {} },
        ],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "toolu_abc-123",
        toolUseId: "toolu_abc-123",
        content: [{ type: "text", text: "result" }],
        timestamp: Date.now(),
      },
    ] as any[];
    const result = sanitizeToolCallIdsForCloudCodeAssist(messages, "strict");
    expect(result).not.toBe(messages);
    const assistantId = result[0].content[0].id;
    expect(result[1].toolCallId).toBe(assistantId);
    expect(result[1].toolUseId).toBe(assistantId);
  });
});
