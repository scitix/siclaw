import { describe, it, expect } from "vitest";
import {
  enforceToolResultContextBudgetInPlace,
  estimateMessageChars,
  getToolResultText,
  truncateTextToBudget,
  installToolResultContextGuard,
  PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
} from "./tool-result-context-guard.js";

function artifactReference(id = "tra_0123456789abcdef0123456789abcdef") {
  return {
    version: 1,
    id,
    sizeChars: 10_000,
    sizeBytes: 10_000,
    sha256: "a".repeat(64),
    createdAt: "2026-09-03T00:00:00.000Z",
    expiresAt: "2026-09-04T00:00:00.000Z",
  };
}

describe("estimateMessageChars", () => {
  it("estimates user text message", () => {
    const msg = { role: "user", content: "hello world", timestamp: Date.now() } as any;
    expect(estimateMessageChars(msg)).toBe(11);
  });

  it("estimates assistant text message", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "response here" }],
      timestamp: Date.now(),
    } as any;
    expect(estimateMessageChars(msg)).toBe(13);
  });

  it("estimates toolResult message with weighting", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "result text" }],
      timestamp: Date.now(),
    } as any;
    const chars = estimateMessageChars(msg);
    // Tool results have weighted chars (CHARS_PER_TOKEN / TOOL_RESULT_CHARS_PER_TOKEN = 2x)
    expect(chars).toBeGreaterThanOrEqual(11);
  });

  it("returns 0 for null/undefined", () => {
    expect(estimateMessageChars(null as any)).toBe(0);
    expect(estimateMessageChars(undefined as any)).toBe(0);
  });
});

describe("getToolResultText", () => {
  it("extracts text from toolResult content", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "hello world" }],
      timestamp: Date.now(),
    } as any;
    expect(getToolResultText(msg)).toBe("hello world");
  });

  it("concatenates multiple text blocks", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
      timestamp: Date.now(),
    } as any;
    expect(getToolResultText(msg)).toBe("line1\nline2");
  });

  it("handles string content", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      content: "plain text",
      timestamp: Date.now(),
    } as any;
    expect(getToolResultText(msg)).toBe("plain text");
  });

  it("returns empty string for non-toolResult", () => {
    const msg = { role: "user", content: "hello", timestamp: Date.now() } as any;
    expect(getToolResultText(msg)).toBe("");
  });
});

describe("truncateTextToBudget", () => {
  it("returns original text when within budget", () => {
    const text = "short text";
    expect(truncateTextToBudget(text, 100)).toBe(text);
  });

  it("truncates long text with notice", () => {
    const text = "a".repeat(200);
    const result = truncateTextToBudget(text, 50);
    expect(result.length).toBeLessThanOrEqual(55); // some overhead for notice
    expect(result).toContain("[truncated:");
  });

  it("returns notice for zero budget", () => {
    const result = truncateTextToBudget("some text", 0);
    expect(result).toContain("[truncated:");
  });
});

describe("enforceToolResultContextBudgetInPlace", () => {
  it("does nothing when all messages are under budget", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: Date.now() },
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "short result" }],
        timestamp: Date.now(),
      },
    ] as any[];
    const original = JSON.parse(JSON.stringify(messages));
    enforceToolResultContextBudgetInPlace({
      messages,
      contextBudgetChars: 100_000,
      maxSingleToolResultChars: 50_000,
    });
    // Content should be unchanged
    expect(messages[1].content[0].text).toBe(original[1].content[0].text);
  });

  it("truncates oversized single tool result", () => {
    const longText = "x".repeat(10_000);
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: longText }],
        timestamp: Date.now(),
      },
    ] as any[];
    enforceToolResultContextBudgetInPlace({
      messages,
      contextBudgetChars: 100_000,
      maxSingleToolResultChars: 500,
    });
    // Should be truncated (in-place mutation)
    const resultContent = messages[0].content;
    const text = typeof resultContent === "string"
      ? resultContent
      : Array.isArray(resultContent)
        ? resultContent.map((b: any) => b.text ?? "").join("")
        : "";
    expect(text.length).toBeLessThan(longText.length);
    expect(text).toContain("[truncated:");
  });

  it("replaces an oversized captured result with a recoverable artifact reference", () => {
    const artifact = artifactReference();
    const messages = [{
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: `head\n${"x".repeat(9_900)}\nroot cause` }],
      details: { providerNoise: "drop me", toolResultArtifact: artifact },
      timestamp: Date.now(),
    }] as any[];

    enforceToolResultContextBudgetInPlace({
      messages,
      contextBudgetChars: 100_000,
      maxSingleToolResultChars: 1_000,
    });

    const text = getToolResultText(messages[0]);
    expect(text).toContain(artifact.id);
    expect(text).toContain("tool_result_search");
    expect(text).toContain("root cause");
    expect(messages[0].details).toEqual({ toolResultArtifact: artifact });
  });

  it("keeps artifact recovery instructions when old results are compacted", () => {
    const artifact = artifactReference();
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "old evidence ".repeat(300) }],
        details: { toolResultArtifact: artifact },
        timestamp: Date.now(),
      },
      { role: "user", content: "new context ".repeat(300), timestamp: Date.now() },
    ] as any[];

    enforceToolResultContextBudgetInPlace({
      messages,
      contextBudgetChars: 2_000,
      maxSingleToolResultChars: 20_000,
    });

    const text = getToolResultText(messages[0]);
    expect(text).toContain(artifact.id);
    expect(text).toContain("tool_result_read");
    expect(text).not.toContain("[compacted:");
    expect(messages[0].details.toolResultArtifact).toEqual(artifact);
  });

  it("states when an oversized result cannot be recovered", () => {
    const messages = [{
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "x".repeat(10_000) }],
      details: {
        toolResultArtifactFailure: {
          version: 1,
          reason: "too_large",
          sizeChars: 10_000,
          sizeBytes: 10_000,
        },
      },
      timestamp: Date.now(),
    }] as any[];

    enforceToolResultContextBudgetInPlace({
      messages,
      contextBudgetChars: 100_000,
      maxSingleToolResultChars: 1_000,
    });

    const text = getToolResultText(messages[0]);
    expect(text).toContain("complete artifact is unavailable");
    expect(text).toContain("cannot be recovered");
    expect(text).toContain("reason: too_large");
  });

  it("does not replace a small artifact-tagged result with a larger recovery stub", () => {
    const artifact = artifactReference();
    const smallText = "recovered snippet";
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call_read",
        content: [{ type: "text", text: smallText }],
        details: { toolResultArtifact: artifact },
        timestamp: Date.now(),
      },
      { role: "user", content: "new context ".repeat(400), timestamp: Date.now() },
    ] as any[];

    enforceToolResultContextBudgetInPlace({
      messages,
      contextBudgetChars: 2_000,
      maxSingleToolResultChars: 20_000,
    });

    expect(getToolResultText(messages[0])).toBe(smallText);
    expect(messages[0].details.toolResultArtifact).toEqual(artifact);
  });

  it("compacts oldest tool results when total context exceeds budget", () => {
    // Create many tool results that together exceed budget
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "toolResult",
      toolCallId: `call_${i}`,
      content: [{ type: "text", text: "x".repeat(500) }],
      timestamp: Date.now(),
    })) as any[];

    enforceToolResultContextBudgetInPlace({
      messages,
      contextBudgetChars: 2_000,
      maxSingleToolResultChars: 1_000,
    });

    // Oldest messages should be compacted
    const firstContent = messages[0].content;
    const firstText = typeof firstContent === "string"
      ? firstContent
      : Array.isArray(firstContent)
        ? firstContent.map((b: any) => b.text ?? "").join("")
        : "";
    expect(firstText).toContain("[compacted:");
  });
});

describe("installToolResultContextGuard", () => {
  it("installs transformContext", () => {
    const agent = {} as any;
    installToolResultContextGuard({
      agent,
      contextWindowTokens: 128_000,
    });
    expect(typeof agent.transformContext).toBe("function");
  });

  it("preserves existing transformContext", async () => {
    let originalCalled = false;
    const agent = {
      transformContext: async (msgs: any[]) => {
        originalCalled = true;
        return msgs;
      },
    } as any;
    const originalFn = agent.transformContext;
    installToolResultContextGuard({
      agent,
      contextWindowTokens: 128_000,
    });
    expect(agent.transformContext).not.toBe(originalFn);
    const messages = [
      { role: "user", content: "test", timestamp: Date.now() },
    ] as any[];
    await agent.transformContext(messages, new AbortController().signal);
    expect(originalCalled).toBe(true);
  });

  it("throws preemptive overflow when context is still too large after compaction", async () => {
    const agent = {} as any;
    installToolResultContextGuard({
      agent,
      contextWindowTokens: 100, // Very small window
    });
    // Create messages that far exceed the tiny window
    const messages = [
      { role: "user", content: "x".repeat(10_000), timestamp: Date.now() },
    ] as any[];
    await expect(
      agent.transformContext(messages, new AbortController().signal),
    ).rejects.toThrow(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
  });
});
