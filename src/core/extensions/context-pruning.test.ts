import { describe, it, expect } from "vitest";
import {
  sumChars,
  findPrunableToolResults,
  CHARS_PER_TOKEN,
  SOFT_TRIM_RATIO,
  HARD_CLEAR_RATIO,
  SOFT_TRIM_MAX_CHARS,
  SOFT_TRIM_HEAD,
  SOFT_TRIM_TAIL,
  HARD_CLEAR_PLACEHOLDER,
} from "./context-pruning.js";

// We can't easily test the extension registration (needs ExtensionAPI),
// so we test the exported helpers and simulate the pruning logic inline.

function makeToolResult(text: string, toolName = "kubectl") {
  return {
    role: "toolResult" as const,
    toolCallId: "tc-" + Math.random().toString(36).slice(2, 8),
    toolName,
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function makeAssistant(text = "some response") {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic",
    provider: "anthropic",
    model: "test",
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

function makeUser(text = "user query") {
  return {
    role: "user" as const,
    content: text,
    timestamp: Date.now(),
  };
}

describe("sumChars", () => {
  it("sums string content", () => {
    const messages = [
      makeUser("hello"),      // 5 chars
      makeUser("world!!!"),   // 8 chars
    ];
    expect(sumChars(messages)).toBe(13);
  });

  it("sums text blocks in content arrays", () => {
    const messages = [
      makeToolResult("abc"),   // 3 chars
      makeAssistant("defgh"), // 5 chars
    ];
    expect(sumChars(messages)).toBe(8);
  });

  it("returns 0 for empty messages", () => {
    expect(sumChars([])).toBe(0);
  });
});

describe("findPrunableToolResults", () => {
  it("returns empty array when fewer than KEEP_LAST_ASSISTANTS assistant messages", () => {
    const messages = [
      makeUser(),
      makeAssistant(),
      makeToolResult("data"),
      makeAssistant(),
    ];
    // Only 2 assistant messages, need 3 to have a cutoff
    expect(findPrunableToolResults(messages)).toEqual([]);
  });

  it("finds tool results before the cutoff", () => {
    const messages = [
      makeUser(),              // 0
      makeAssistant(),         // 1
      makeToolResult("old1"),  // 2 - prunable
      makeToolResult("old2"),  // 3 - prunable
      makeAssistant(),         // 4
      makeToolResult("mid"),   // 5 - prunable
      makeAssistant(),         // 6 - 3rd from last
      makeToolResult("new1"),  // 7 - protected
      makeAssistant(),         // 8 - 2nd from last
      makeToolResult("new2"),  // 9 - protected
      makeAssistant(),         // 10 - last
    ];
    const result = findPrunableToolResults(messages);
    // Cutoff at index 6 (3rd assistant from end), so indexes 2,3,5 are prunable
    expect(result).toEqual([2, 3, 5]);
  });

  it("returns empty when no tool results before cutoff", () => {
    const messages = [
      makeUser(),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
      makeToolResult("recent"),
    ];
    expect(findPrunableToolResults(messages)).toEqual([]);
  });
});

describe("context pruning logic (simulated)", () => {
  // Simulate what the extension does, using the same constants
  function simulatePruning(messages: any[], contextWindow: number) {
    const charWindow = contextWindow * CHARS_PER_TOKEN;
    let totalChars = sumChars(messages);
    let ratio = totalChars / charWindow;

    if (ratio < SOFT_TRIM_RATIO) return null;

    const prunableIndexes = findPrunableToolResults(messages);
    if (!prunableIndexes.length) return null;

    const next = messages.slice();

    // Soft trim
    for (const i of prunableIndexes) {
      if (ratio < SOFT_TRIM_RATIO) break;
      const content = next[i].content;
      if (!Array.isArray(content)) continue;

      let msgLen = 0;
      for (const block of content) {
        if (block.type === "text") msgLen += block.text.length;
      }
      if (msgLen <= SOFT_TRIM_MAX_CHARS) continue;

      const newContent = content.map((block: any) => {
        if (block.type !== "text" || block.text.length <= SOFT_TRIM_MAX_CHARS) return block;
        const head = block.text.slice(0, SOFT_TRIM_HEAD);
        const tail = block.text.slice(-SOFT_TRIM_TAIL);
        return { ...block, text: `${head}\n\n... [trimmed]\n\n${tail}` };
      });
      const newMsg = { ...next[i], content: newContent };
      let newLen = 0;
      for (const block of newMsg.content) {
        if (block.type === "text") newLen += block.text.length;
      }
      totalChars -= (msgLen - newLen);
      ratio = totalChars / charWindow;
      next[i] = newMsg;
    }

    // Hard clear
    if (ratio >= HARD_CLEAR_RATIO) {
      for (const i of prunableIndexes) {
        if (ratio < HARD_CLEAR_RATIO) break;
        let msgLen = 0;
        for (const block of next[i].content) {
          if (block.type === "text") msgLen += block.text.length;
        }
        if (msgLen <= HARD_CLEAR_PLACEHOLDER.length) continue;
        next[i] = { ...next[i], content: [{ type: "text", text: HARD_CLEAR_PLACEHOLDER }] };
        totalChars -= (msgLen - HARD_CLEAR_PLACEHOLDER.length);
        ratio = totalChars / charWindow;
      }
    }

    return next;
  }

  it("does not prune when under soft trim ratio", () => {
    // contextWindow = 100k tokens = 400k chars, SOFT_TRIM_RATIO = 0.3 → 120k chars
    const messages = [
      makeUser("short query"),
      makeAssistant("short response"),
      makeToolResult("small result"),
      makeAssistant(),
      makeAssistant(),
      makeAssistant(),
    ];
    // Total chars is tiny compared to 400k char window
    expect(simulatePruning(messages, 100000)).toBeNull();
  });

  it("soft-trims large old tool results", () => {
    // contextWindow = 2500 tokens = 10000 chars
    // 30% threshold = 3000 chars, 50% threshold = 5000 chars
    const bigOutput = "X".repeat(5000);
    const messages = [
      makeUser("q"),            // 0
      makeAssistant("a"),       // 1
      makeToolResult(bigOutput),// 2 - old, large, prunable (5000 chars)
      makeAssistant("a"),       // 3 - 3rd from last
      makeAssistant("a"),       // 4 - 2nd from last
      makeAssistant("a"),       // 5 - last
    ];
    // Total chars: 1 + 1 + 5000 + 1 + 1 + 1 = 5005 chars
    // charWindow = 10000, ratio = 5005/10000 ≈ 0.50 > 0.3 → triggers soft trim
    // After soft trim: 5000 → ~3017, total ≈ 3022, ratio ≈ 0.30 → below 0.5, no hard clear
    const result = simulatePruning(messages, 2500);
    expect(result).not.toBeNull();

    // The tool result at index 2 should have been soft-trimmed (not hard-cleared)
    const trimmedText = result![2].content[0].text;
    expect(trimmedText.length).toBeLessThan(bigOutput.length);
    expect(trimmedText).toContain("trimmed");
    // Should NOT be hard-cleared
    expect(trimmedText).not.toBe(HARD_CLEAR_PLACEHOLDER);
  });

  it("hard-clears when ratio exceeds HARD_CLEAR_RATIO", () => {
    // contextWindow = 500 tokens = 2000 chars, 50% = 1000 chars
    // Put enough data in old tool results to exceed 50%
    const bigOutput = "Y".repeat(3000);
    const messages = [
      makeUser("q"),             // 0
      makeAssistant("a"),        // 1
      makeToolResult(bigOutput), // 2 - old, prunable
      makeAssistant("a"),        // 3
      makeAssistant("a"),        // 4
      makeAssistant("a"),        // 5
    ];
    // Total: 1 + 1 + 3000 + 1 + 1 + 1 = 3005
    // charWindow = 2000, ratio = 1.5 > 0.5
    // After soft trim: head 1500 + tail 1500 + marker ≈ 3017 → ratio still > 0.5
    // Should hard clear
    const result = simulatePruning(messages, 500);
    expect(result).not.toBeNull();

    const clearedText = result![2].content[0].text;
    expect(clearedText).toBe(HARD_CLEAR_PLACEHOLDER);
  });

  it("protects recent tool results from pruning", () => {
    // Only 2 assistants → all tool results are protected
    const bigOutput = "Z".repeat(5000);
    const messages = [
      makeUser("q"),
      makeAssistant("a"),
      makeToolResult(bigOutput),
      makeAssistant("a"),
    ];
    // Even with a small window, no prunable indexes
    const result = simulatePruning(messages, 100);
    // findPrunableToolResults returns [] when < 3 assistants
    expect(result).toBeNull();
  });
});
