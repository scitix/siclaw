import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// Mock the LLM summarization function before importing the code under test.
// This lets us exercise summarizeWithFallback / summarizeInStages without a real API.
vi.mock("@mariozechner/pi-coding-agent", async (orig) => {
  const original = await orig<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...original,
    generateSummary: vi.fn(async (messages: AgentMessage[]) => {
      // Return a short fake summary derived from message count — deterministic.
      return `fake-summary(${messages.length})`;
    }),
  };
});

import * as piAgent from "@mariozechner/pi-coding-agent";
import {
  repairToolUsePairingGuard,
  summarizeWithFallback,
  summarizeInStages,
  EXACT_IDENTIFIERS_HEADING,
  IDENTIFIER_PRESERVATION_INSTRUCTIONS,
  SUMMARIZATION_OVERHEAD_TOKENS,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
} from "./compaction.js";

function makeUser(text = "u"): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}
function makeAssistant(text = "a", toolCalls?: Array<{ id: string; name: string }>): AgentMessage {
  const content: unknown[] = [{ type: "text", text }];
  if (toolCalls) for (const tc of toolCalls) content.push({ type: "toolUse", id: tc.id, name: tc.name, input: {} });
  return {
    role: "assistant",
    content,
    api: "anthropic",
    provider: "anthropic",
    model: "test",
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  } as AgentMessage;
}
function makeToolResult(toolCallId: string, text = "r"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

// ── Constants ──────────────────────────────────────────────────────────

describe("compaction constants", () => {
  it("exposes numeric tuning constants", () => {
    expect(BASE_CHUNK_RATIO).toBeGreaterThan(MIN_CHUNK_RATIO);
    expect(MIN_CHUNK_RATIO).toBeGreaterThan(0);
    expect(SAFETY_MARGIN).toBeGreaterThan(1);
    expect(SUMMARIZATION_OVERHEAD_TOKENS).toBeGreaterThan(1000);
  });

  it("EXACT_IDENTIFIERS_HEADING is the canonical markdown heading", () => {
    expect(EXACT_IDENTIFIERS_HEADING).toBe("## Exact identifiers");
  });

  it("IDENTIFIER_PRESERVATION_INSTRUCTIONS mentions opaque identifiers", () => {
    expect(IDENTIFIER_PRESERVATION_INSTRUCTIONS).toMatch(/opaque identifiers/i);
    expect(IDENTIFIER_PRESERVATION_INSTRUCTIONS).toMatch(/URLs/);
  });
});

// ── repairToolUsePairingGuard ──────────────────────────────────────────

describe("repairToolUsePairingGuard (InputGuard adapter)", () => {
  it("returns the same reference when no change is needed", () => {
    const msgs = [makeUser("hi"), makeAssistant("hello")];
    const out = repairToolUsePairingGuard(msgs);
    expect(out).toBe(msgs);
  });

  it("inserts synthetic tool result for missing pair", () => {
    const msgs = [
      makeAssistant("running", [{ id: "tc1", name: "bash" }]),
      makeUser("next"),
    ];
    const out = repairToolUsePairingGuard(msgs);
    const synthetic = out.find((m) => (m as any).role === "toolResult");
    expect(synthetic).toBeDefined();
    expect((synthetic as any).toolCallId).toBe("tc1");
    expect((synthetic as any).isError).toBe(true);
  });

  it("drops orphaned toolResult messages", () => {
    const msgs = [makeToolResult("orphan"), makeUser("continue")];
    const out = repairToolUsePairingGuard(msgs);
    expect(out.filter((m) => (m as any).role === "toolResult")).toHaveLength(0);
  });
});

// ── summarizeWithFallback ──────────────────────────────────────────────

describe("summarizeWithFallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseArgs = (messages: AgentMessage[] = [makeUser("a"), makeAssistant("b")]) => ({
    messages,
    model: { id: "m", contextWindow: 200000 } as any,
    apiKey: "fake",
    signal: new AbortController().signal,
    reserveTokens: 16384,
    maxChunkTokens: 100_000,
    contextWindow: 200_000,
  });

  it("returns previousSummary or default when messages empty", async () => {
    const res = await summarizeWithFallback({ ...baseArgs([]), previousSummary: "keep-me" });
    expect(res).toBe("keep-me");

    const res2 = await summarizeWithFallback({ ...baseArgs([]) });
    expect(res2).toMatch(/No prior history/i);
  });

  it("returns summary from generateSummary on happy path", async () => {
    const res = await summarizeWithFallback(baseArgs());
    expect(res).toMatch(/fake-summary/);
    expect(piAgent.generateSummary).toHaveBeenCalled();
  });

  it("falls back to partial summary when full summarization throws", async () => {
    const genSpy = piAgent.generateSummary as any;
    // First call throws, second call (partial) succeeds.
    genSpy
      .mockImplementationOnce(async () => { throw new Error("first failure"); })
      .mockImplementationOnce(async () => { throw new Error("retry failure"); })
      .mockImplementation(async (msgs: AgentMessage[]) => `partial(${msgs.length})`);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const msgs = [makeUser("hello"), makeAssistant("world")];
    const res = await summarizeWithFallback({ ...baseArgs(msgs), maxChunkTokens: 100_000 });
    expect(res).toMatch(/partial/);
  });

  it("returns size-limit note when both full and partial summarization fail", async () => {
    const genSpy = piAgent.generateSummary as any;
    genSpy.mockImplementation(async () => { throw new Error("boom"); });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Use oversized message so it gets filtered from the partial set,
    // then no small messages remain and the fallback final string is returned.
    const huge = makeUser("x".repeat(500_000));
    const res = await summarizeWithFallback({ ...baseArgs([huge]), contextWindow: 200_000 });
    expect(res).toMatch(/Summary unavailable/);
  });
});

// ── summarizeInStages ──────────────────────────────────────────────────

describe("summarizeInStages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (piAgent.generateSummary as any).mockImplementation(async (m: AgentMessage[]) => `S(${m.length})`);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseArgs = (messages: AgentMessage[]) => ({
    messages,
    model: { id: "m", contextWindow: 200000 } as any,
    apiKey: "fake",
    signal: new AbortController().signal,
    reserveTokens: 16384,
    maxChunkTokens: 100_000,
    contextWindow: 200_000,
  });

  it("returns previousSummary for empty input", async () => {
    const res = await summarizeInStages({ ...baseArgs([]), previousSummary: "prev" });
    expect(res).toBe("prev");
  });

  it("single-stage path when below split threshold", async () => {
    // parts=2 but messages below minMessagesForSplit (default 4)
    const msgs = [makeUser("a"), makeUser("b")];
    const res = await summarizeInStages({ ...baseArgs(msgs), parts: 2 });
    expect(res).toMatch(/S\(/);
  });

  it("multi-stage path merges partial summaries when split triggers", async () => {
    // Make enough messages, and set maxChunkTokens very small to force splitting.
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 8; i++) msgs.push(makeUser(`msg ${i}`.repeat(200)));
    const res = await summarizeInStages({
      ...baseArgs(msgs),
      parts: 2,
      maxChunkTokens: 50,
      minMessagesForSplit: 4,
    });
    // Ensure generateSummary was called multiple times (one per partial + merge)
    expect((piAgent.generateSummary as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(res).toMatch(/S\(/);
  });

  it("normalizes parts<=1 to single-call path", async () => {
    const msgs = [makeUser("a"), makeUser("b"), makeUser("c"), makeUser("d"), makeUser("e")];
    const res = await summarizeInStages({ ...baseArgs(msgs), parts: 0.5 });
    expect(res).toMatch(/S\(/);
  });

  it("single-call path uses the fallback final string when non-abort error persists", async () => {
    (piAgent.generateSummary as any).mockImplementation(async () => { throw new Error("boom"); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const msgs = [makeUser("a"), makeUser("b")];
    const res = await summarizeInStages(baseArgs(msgs));
    expect(res).toMatch(/Summary unavailable/);
  });
});
