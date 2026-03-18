import { describe, it, expect, vi } from "vitest";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

function createMockSessionManager() {
  const appended: any[] = [];
  return {
    appendMessage: vi.fn((msg: any) => {
      appended.push(msg);
      return `entry-${appended.length}`;
    }),
    _appended: appended,
  };
}

describe("installSessionToolResultGuard", () => {
  it("passes through valid messages unchanged", () => {
    const sm = createMockSessionManager();
    installSessionToolResultGuard(sm as any);

    sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "I will search" },
        { type: "toolCall", id: "call_1", name: "memory_search", arguments: { query: "test" } },
      ],
      timestamp: Date.now(),
      stopReason: "toolUse",
    });
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "results" }],
      timestamp: Date.now(),
    });

    expect(sm._appended).toHaveLength(3);
    expect(sm._appended[0].role).toBe("user");
    expect(sm._appended[1].role).toBe("assistant");
    expect(sm._appended[2].role).toBe("toolResult");
  });

  it("drops malformed tool call blocks from assistant messages", () => {
    const sm = createMockSessionManager();
    installSessionToolResultGuard(sm as any);

    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Let me search" },
        { type: "toolCall", id: "", name: "", arguments: {} },
      ],
      timestamp: Date.now(),
    });

    expect(sm._appended).toHaveLength(1);
    // The malformed toolCall was removed, only text remains
    expect(sm._appended[0].content).toHaveLength(1);
    expect(sm._appended[0].content[0].type).toBe("text");
  });

  it("drops entire assistant message if all content blocks are malformed", () => {
    const sm = createMockSessionManager();
    installSessionToolResultGuard(sm as any);

    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "", name: "", arguments: {} },
      ],
      timestamp: Date.now(),
    });

    expect(sm._appended).toHaveLength(0);
  });

  it("inserts synthetic tool results for orphaned tool calls", () => {
    const sm = createMockSessionManager();
    installSessionToolResultGuard(sm as any);

    // Assistant makes a tool call
    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_1", name: "memory_search", arguments: {} },
      ],
      timestamp: Date.now(),
      stopReason: "toolUse",
    });

    // No toolResult follows — user message arrives instead
    sm.appendMessage({ role: "user", content: "never mind", timestamp: Date.now() });

    // A synthetic toolResult should have been inserted before the user message
    expect(sm._appended).toHaveLength(3);
    expect(sm._appended[0].role).toBe("assistant");
    expect(sm._appended[1].role).toBe("toolResult");
    expect(sm._appended[1].toolCallId).toBe("call_1");
    expect(sm._appended[1].isError).toBe(true);
    expect(sm._appended[2].role).toBe("user");
  });

  it("does not create synthetic results for errored assistant messages", () => {
    const sm = createMockSessionManager();
    installSessionToolResultGuard(sm as any);

    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_1", name: "memory_search", arguments: {} },
      ],
      timestamp: Date.now(),
      stopReason: "error",
    });

    // User message follows — should NOT insert synthetic result for errored tool call
    sm.appendMessage({ role: "user", content: "try again", timestamp: Date.now() });

    expect(sm._appended).toHaveLength(2);
    expect(sm._appended[0].role).toBe("assistant");
    expect(sm._appended[1].role).toBe("user");
  });

  it("clears pending when toolResult arrives", () => {
    const sm = createMockSessionManager();
    installSessionToolResultGuard(sm as any);

    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_1", name: "memory_search", arguments: {} },
      ],
      timestamp: Date.now(),
      stopReason: "toolUse",
    });

    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "found it" }],
      timestamp: Date.now(),
    });

    // Now a user message — no synthetic result should be inserted
    sm.appendMessage({ role: "user", content: "thanks", timestamp: Date.now() });

    expect(sm._appended).toHaveLength(3);
    expect(sm._appended.filter((m: any) => m.role === "toolResult")).toHaveLength(1);
  });

  it("drops orphaned toolResult whose tool call was sanitized away", () => {
    const sm = createMockSessionManager();
    installSessionToolResultGuard(sm as any);

    // Assistant with a malformed tool call (empty id/name) — gets sanitized out
    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Let me search" },
        { type: "toolCall", id: "bad_call", name: "", arguments: {} },
      ],
      timestamp: Date.now(),
    });

    // toolResult arrives for the dropped tool call — should be dropped too
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "bad_call",
      content: [{ type: "text", text: "result" }],
      timestamp: Date.now(),
    });

    // Only the sanitized assistant message (text only) should remain
    expect(sm._appended).toHaveLength(1);
    expect(sm._appended[0].role).toBe("assistant");
    expect(sm._appended[0].content).toHaveLength(1);
    expect(sm._appended[0].content[0].type).toBe("text");
  });

  it("truncates oversized tool results at persistence", () => {
    const sm = createMockSessionManager();
    installSessionToolResultGuard(sm as any);

    const hugeText = "x".repeat(500_000); // 500K chars, exceeds 400K hard cap
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: hugeText }],
      timestamp: Date.now(),
    });

    expect(sm._appended).toHaveLength(1);
    const persisted = sm._appended[0];
    expect(persisted.role).toBe("toolResult");
    // Should be truncated to well under the original 500K
    const persistedText = persisted.content[0].text;
    expect(persistedText.length).toBeLessThan(450_000);
    expect(persistedText).toContain("[Content truncated");
  });
});
