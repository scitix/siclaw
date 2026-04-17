import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { extractToolCallsFromAssistant, extractToolResultId } from "./message-utils.js";

function makeAssistant(content: unknown): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content,
    api: "anthropic",
    provider: "anthropic",
    model: "test",
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  } as unknown as Extract<AgentMessage, { role: "assistant" }>;
}

describe("extractToolCallsFromAssistant", () => {
  it("returns empty array when content is not an array (e.g. string)", () => {
    const msg = makeAssistant("just text");
    expect(extractToolCallsFromAssistant(msg)).toEqual([]);
  });

  it("returns empty array for assistant with no tool call blocks", () => {
    const msg = makeAssistant([{ type: "text", text: "hello" }]);
    expect(extractToolCallsFromAssistant(msg)).toEqual([]);
  });

  it("extracts toolCall blocks with id and name", () => {
    const msg = makeAssistant([
      { type: "text", text: "" },
      { type: "toolCall", id: "call_1", name: "search", arguments: {} },
    ]);
    expect(extractToolCallsFromAssistant(msg)).toEqual([{ id: "call_1", name: "search" }]);
  });

  it("accepts 'toolUse' type (Anthropic block type)", () => {
    const msg = makeAssistant([
      { type: "toolUse", id: "call_2", name: "bash", input: {} },
    ]);
    expect(extractToolCallsFromAssistant(msg)).toEqual([{ id: "call_2", name: "bash" }]);
  });

  it("accepts 'functionCall' type (generic)", () => {
    const msg = makeAssistant([
      { type: "functionCall", id: "call_3", name: "fn" },
    ]);
    expect(extractToolCallsFromAssistant(msg)).toEqual([{ id: "call_3", name: "fn" }]);
  });

  it("ignores blocks missing id", () => {
    const msg = makeAssistant([
      { type: "toolCall", name: "no_id" },
      { type: "toolCall", id: "", name: "empty_id" },
    ]);
    expect(extractToolCallsFromAssistant(msg)).toEqual([]);
  });

  it("ignores unrecognized block types", () => {
    const msg = makeAssistant([
      { type: "randomBlock", id: "x", name: "y" },
    ]);
    expect(extractToolCallsFromAssistant(msg)).toEqual([]);
  });

  it("ignores non-object / null blocks", () => {
    const msg = makeAssistant([
      null,
      "string entry",
      { type: "toolCall", id: "good", name: "ok" },
    ]);
    expect(extractToolCallsFromAssistant(msg)).toEqual([{ id: "good", name: "ok" }]);
  });

  it("leaves name undefined when non-string", () => {
    const msg = makeAssistant([{ type: "toolCall", id: "a", name: 42 }]);
    expect(extractToolCallsFromAssistant(msg)).toEqual([{ id: "a", name: undefined }]);
  });
});

describe("extractToolResultId", () => {
  it("returns toolCallId when present", () => {
    const msg = { role: "toolResult", toolCallId: "call_1" } as unknown as Extract<AgentMessage, { role: "toolResult" }>;
    expect(extractToolResultId(msg)).toBe("call_1");
  });

  it("falls back to toolUseId when toolCallId missing", () => {
    const msg = { role: "toolResult", toolUseId: "use_1" } as unknown as Extract<AgentMessage, { role: "toolResult" }>;
    expect(extractToolResultId(msg)).toBe("use_1");
  });

  it("returns null when neither field is present", () => {
    const msg = { role: "toolResult" } as unknown as Extract<AgentMessage, { role: "toolResult" }>;
    expect(extractToolResultId(msg)).toBeNull();
  });

  it("returns null for empty string toolCallId", () => {
    const msg = { role: "toolResult", toolCallId: "" } as unknown as Extract<AgentMessage, { role: "toolResult" }>;
    expect(extractToolResultId(msg)).toBeNull();
  });

  it("prefers toolCallId when both present", () => {
    const msg = { role: "toolResult", toolCallId: "call_x", toolUseId: "use_y" } as unknown as Extract<AgentMessage, { role: "toolResult" }>;
    expect(extractToolResultId(msg)).toBe("call_x");
  });
});
