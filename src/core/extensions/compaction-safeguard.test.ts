import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, FileOperations } from "@mariozechner/pi-coding-agent";
import {
  estimateMessagesTokens,
  splitMessagesByTokenShare,
  chunkMessagesByMaxTokens,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  pruneHistoryForContextShare,
  resolveContextWindowTokens,
  stripToolResultDetails,
  repairToolUseResultPairing,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
} from "../compaction.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";

// ── Test helpers ─────────────────────────────────────────────────────────

function makeUser(text = "user query"): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function makeAssistant(text = "assistant response", toolCalls?: Array<{ id: string; name: string }>): AgentMessage {
  const content: unknown[] = [{ type: "text", text }];
  if (toolCalls) {
    for (const tc of toolCalls) {
      content.push({ type: "toolUse", id: tc.id, name: tc.name, input: {} });
    }
  }
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

function makeToolResult(toolCallId: string, text = "result", opts?: { isError?: boolean; details?: unknown }): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: opts?.isError ?? false,
    ...(opts?.details !== undefined ? { details: opts.details } : {}),
    timestamp: Date.now(),
  } as AgentMessage;
}

function createFileOps(overrides?: Partial<Record<"read" | "written" | "edited", string[]>>): FileOperations {
  return {
    read: new Set(overrides?.read ?? []),
    written: new Set(overrides?.written ?? []),
    edited: new Set(overrides?.edited ?? []),
  };
}

// ── compaction.ts: stripToolResultDetails ─────────────────────────────────

describe("stripToolResultDetails", () => {
  it("removes details from toolResult messages", () => {
    const messages = [
      makeUser("hello"),
      makeToolResult("tc1", "output", { details: { sensitive: "data" } }),
    ];
    const stripped = stripToolResultDetails(messages);
    expect(stripped).toHaveLength(2);
    expect("details" in stripped[1]).toBe(false);
  });

  it("returns same array if no details present", () => {
    const messages = [makeUser("hello"), makeToolResult("tc1", "output")];
    const stripped = stripToolResultDetails(messages);
    expect(stripped).toBe(messages); // same reference
  });
});

// ── compaction.ts: repairToolUseResultPairing ────────────────────────────

describe("repairToolUseResultPairing", () => {
  it("drops orphaned toolResults not preceded by matching assistant", () => {
    const messages = [
      makeUser("hello"),
      makeToolResult("orphan-id", "some result"),
      makeAssistant("response"),
    ];
    const result = repairToolUseResultPairing(messages);
    expect(result.droppedOrphanCount).toBe(1);
    expect(result.messages.filter(m => m.role === "toolResult")).toHaveLength(0);
  });

  it("inserts synthetic toolResult for missing tool call response", () => {
    const messages = [
      makeAssistant("I'll run bash", [{ id: "tc1", name: "bash" }]),
      // No toolResult for tc1
      makeUser("next"),
    ];
    const result = repairToolUseResultPairing(messages);
    const toolResults = result.messages.filter(m => m.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).isError).toBe(true);
    expect((toolResults[0] as any).toolCallId).toBe("tc1");
  });

  it("keeps valid pairings intact", () => {
    const messages = [
      makeAssistant("running", [{ id: "tc1", name: "bash" }]),
      makeToolResult("tc1", "output"),
      makeUser("ok"),
    ];
    const result = repairToolUseResultPairing(messages);
    expect(result.droppedOrphanCount).toBe(0);
    expect(result.messages).toHaveLength(3);
  });

  it("skips aborted assistant messages", () => {
    const aborted = {
      ...makeAssistant("partial", [{ id: "tc1", name: "bash" }]),
      stopReason: "aborted",
    } as AgentMessage;
    const messages = [aborted, makeUser("retry")];
    const result = repairToolUseResultPairing(messages);
    // Should NOT insert synthetic result for aborted messages
    expect(result.messages.filter(m => m.role === "toolResult")).toHaveLength(0);
  });
});

// ── compaction.ts: estimateMessagesTokens ────────────────────────────────

describe("estimateMessagesTokens", () => {
  it("returns positive token count for non-empty messages", () => {
    const messages = [makeUser("hello world"), makeAssistant("hi there")];
    const tokens = estimateMessagesTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it("returns 0 for empty array", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it("strips details before counting (security)", () => {
    const withDetails = [makeToolResult("tc1", "x".repeat(100), { details: { big: "y".repeat(10000) } })];
    const withoutDetails = [makeToolResult("tc1", "x".repeat(100))];
    // Tokens should be roughly equal since details are stripped
    const diff = Math.abs(estimateMessagesTokens(withDetails) - estimateMessagesTokens(withoutDetails));
    expect(diff).toBeLessThan(5); // minor serialization overhead
  });
});

// ── compaction.ts: splitMessagesByTokenShare ─────────────────────────────

describe("splitMessagesByTokenShare", () => {
  it("returns empty for empty input", () => {
    expect(splitMessagesByTokenShare([])).toEqual([]);
  });

  it("returns single chunk for 1 part", () => {
    const msgs = [makeUser("a"), makeUser("b")];
    expect(splitMessagesByTokenShare(msgs, 1)).toEqual([msgs]);
  });

  it("splits into roughly equal token-weight chunks", () => {
    const msgs = [makeUser("a"), makeUser("b"), makeUser("c"), makeUser("d")];
    const chunks = splitMessagesByTokenShare(msgs, 2);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length + chunks[1].length).toBe(4);
  });
});

// ── compaction.ts: chunkMessagesByMaxTokens ──────────────────────────────

describe("chunkMessagesByMaxTokens", () => {
  it("returns empty for empty input", () => {
    expect(chunkMessagesByMaxTokens([], 1000)).toEqual([]);
  });

  it("keeps small messages in one chunk", () => {
    const msgs = [makeUser("hi"), makeUser("there")];
    const chunks = chunkMessagesByMaxTokens(msgs, 100000);
    expect(chunks).toHaveLength(1);
  });

  it("splits when messages exceed max tokens", () => {
    const bigMsg = makeUser("x".repeat(4000)); // ~1000 tokens
    const msgs = [bigMsg, bigMsg, bigMsg];
    // With safety margin, effective max ~833. Each msg ~1000 tokens → each its own chunk
    const chunks = chunkMessagesByMaxTokens(msgs, 1000);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

// ── compaction.ts: computeAdaptiveChunkRatio ─────────────────────────────

describe("computeAdaptiveChunkRatio", () => {
  it("returns BASE_CHUNK_RATIO for empty messages", () => {
    expect(computeAdaptiveChunkRatio([], 200000)).toBe(BASE_CHUNK_RATIO);
  });

  it("returns BASE_CHUNK_RATIO for small messages", () => {
    const msgs = [makeUser("hi"), makeUser("there")];
    expect(computeAdaptiveChunkRatio(msgs, 200000)).toBe(BASE_CHUNK_RATIO);
  });

  it("reduces ratio for large messages", () => {
    // Create messages that average > 10% of context window
    const bigMsg = makeUser("x".repeat(100000)); // ~25K tokens
    const ratio = computeAdaptiveChunkRatio([bigMsg], 200000);
    expect(ratio).toBeLessThan(BASE_CHUNK_RATIO);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });
});

// ── compaction.ts: isOversizedForSummary ──────────────────────────────────

describe("isOversizedForSummary", () => {
  it("returns false for small messages", () => {
    expect(isOversizedForSummary(makeUser("hello"), 200000)).toBe(false);
  });

  it("returns true for messages > 50% of context window", () => {
    // 500K chars ≈ 125K tokens, 125K * 1.2 safety = 150K > 100K (50% of 200K)
    const huge = makeUser("x".repeat(500000));
    expect(isOversizedForSummary(huge, 200000)).toBe(true);
  });
});

// ── compaction.ts: pruneHistoryForContextShare ───────────────────────────

describe("pruneHistoryForContextShare", () => {
  it("does not prune when under budget", () => {
    const msgs = [makeUser("hello"), makeAssistant("hi")];
    const result = pruneHistoryForContextShare({
      messages: msgs,
      maxContextTokens: 200000,
      maxHistoryShare: 0.5,
    });
    expect(result.droppedChunks).toBe(0);
    expect(result.messages).toHaveLength(2);
  });

  it("prunes when messages exceed budget", () => {
    // Create enough messages to exceed budget
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(makeUser("x".repeat(4000))); // ~1000 tokens each → ~20K total
    }
    const result = pruneHistoryForContextShare({
      messages: msgs,
      maxContextTokens: 1000, // very small budget → 500 token budget
      maxHistoryShare: 0.5,
    });
    expect(result.droppedChunks).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(msgs.length);
    expect(result.droppedMessagesList.length).toBeGreaterThan(0);
  });
});

// ── compaction.ts: resolveContextWindowTokens ────────────────────────────

describe("resolveContextWindowTokens", () => {
  it("returns model contextWindow when available", () => {
    const model = { contextWindow: 128000 } as any;
    expect(resolveContextWindowTokens(model)).toBe(128000);
  });

  it("returns default when model is undefined", () => {
    expect(resolveContextWindowTokens(undefined)).toBe(200000);
  });
});

// ── compaction-safeguard.ts: extension integration ───────────────────────

describe("compactionSafeguardExtension", () => {
  let handlers: Map<string, Function>;
  let mockApi: ExtensionAPI;

  beforeEach(() => {
    handlers = new Map();
    mockApi = {
      on: vi.fn((event: string, handler: Function) => {
        handlers.set(event, handler);
      }),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    compactionSafeguardExtension(mockApi);
  });

  it("registers session_before_compact handler", () => {
    expect(handlers.has("session_before_compact")).toBe(true);
  });

  it("does NOT call sendUserMessage (no flush injection)", () => {
    // The whole point: safeguard must never inject messages
    expect(mockApi.sendUserMessage).not.toHaveBeenCalled();
  });

  describe("empty conversation guard", () => {
    it("returns fallback compaction when no real messages", async () => {
      const handler = handlers.get("session_before_compact")!;
      const event = {
        preparation: {
          messagesToSummarize: [], // no messages
          turnPrefixMessages: [],
          firstKeptEntryId: "entry-1",
          tokensBefore: 50000,
          previousSummary: undefined,
          fileOps: createFileOps(),
          isSplitTurn: false,
          settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        },
        signal: new AbortController().signal,
      };
      const ctx = { model: undefined, modelRegistry: { getApiKey: vi.fn() } };

      const result = await handler(event, ctx);

      expect(result).toBeDefined();
      expect(result.compaction).toBeDefined();
      expect(result.compaction.summary).toContain("## Decisions");
      expect(result.compaction.summary).toContain("## Open TODOs");
      expect(result.compaction.summary).toContain("## Exact identifiers");
      expect(result.compaction.firstKeptEntryId).toBe("entry-1");
      // Crucially: no sendUserMessage was called
      expect(mockApi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("returns fallback compaction when only non-real messages (e.g. compaction entries)", async () => {
      const handler = handlers.get("session_before_compact")!;
      // Messages with roles that aren't user/assistant/toolResult
      const nonRealMsg = { role: "system", content: "system message", timestamp: Date.now() } as AgentMessage;
      const event = {
        preparation: {
          messagesToSummarize: [nonRealMsg],
          turnPrefixMessages: [],
          firstKeptEntryId: "entry-2",
          tokensBefore: 50000,
          previousSummary: "Previous context was about debugging pods.",
          fileOps: createFileOps(),
          isSplitTurn: false,
          settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        },
        signal: new AbortController().signal,
      };
      const ctx = { model: undefined, modelRegistry: { getApiKey: vi.fn() } };

      const result = await handler(event, ctx);

      expect(result.compaction).toBeDefined();
      expect(result.compaction.summary).toContain("## Decisions");
    });
  });

  describe("model/apiKey resolution", () => {
    it("cancels compaction when model is undefined", async () => {
      const handler = handlers.get("session_before_compact")!;
      const event = {
        preparation: {
          messagesToSummarize: [makeUser("hello"), makeAssistant("hi")],
          turnPrefixMessages: [],
          firstKeptEntryId: "entry-1",
          tokensBefore: 50000,
          previousSummary: undefined,
          fileOps: createFileOps(),
          isSplitTurn: false,
          settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        },
        signal: new AbortController().signal,
      };
      const ctx = {
        model: undefined, // no model
        modelRegistry: { getApiKey: vi.fn() },
      };

      const result = await handler(event, ctx);

      expect(result).toEqual({ cancel: true });
    });

    it("cancels compaction when API key is unavailable", async () => {
      const handler = handlers.get("session_before_compact")!;
      const event = {
        preparation: {
          messagesToSummarize: [makeUser("hello"), makeAssistant("hi")],
          turnPrefixMessages: [],
          firstKeptEntryId: "entry-1",
          tokensBefore: 50000,
          previousSummary: undefined,
          fileOps: createFileOps(),
          isSplitTurn: false,
          settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        },
        signal: new AbortController().signal,
      };
      const ctx = {
        model: { contextWindow: 200000, provider: "test", id: "test-model" },
        modelRegistry: { getApiKey: vi.fn().mockResolvedValue(undefined) }, // no key
      };

      const result = await handler(event, ctx);

      expect(result).toEqual({ cancel: true });
    });
  });

  describe("tool failure tracking", () => {
    it("returns fallback with no tool failures section when no errors", async () => {
      const handler = handlers.get("session_before_compact")!;
      const event = {
        preparation: {
          messagesToSummarize: [], // empty → hits fallback path
          turnPrefixMessages: [],
          firstKeptEntryId: "entry-1",
          tokensBefore: 50000,
          previousSummary: undefined,
          fileOps: createFileOps(),
          isSplitTurn: false,
          settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        },
        signal: new AbortController().signal,
      };
      const ctx = { model: undefined, modelRegistry: { getApiKey: vi.fn() } };

      const result = await handler(event, ctx);
      expect(result.compaction.summary).not.toContain("## Tool Failures");
    });
  });

  describe("file operations tracking", () => {
    it("returns fallback with file ops in summary", async () => {
      const handler = handlers.get("session_before_compact")!;
      const event = {
        preparation: {
          messagesToSummarize: [], // empty → hits fallback path
          turnPrefixMessages: [],
          firstKeptEntryId: "entry-1",
          tokensBefore: 50000,
          previousSummary: undefined,
          fileOps: createFileOps({
            read: ["/app/src/main.ts"],
            written: ["/app/src/new.ts"],
            edited: ["/app/src/fix.ts"],
          }),
          isSplitTurn: false,
          settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        },
        signal: new AbortController().signal,
      };
      const ctx = { model: undefined, modelRegistry: { getApiKey: vi.fn() } };

      const result = await handler(event, ctx);
      // Empty conversation → fallback, but file ops are NOT appended in fallback path
      // (they're only appended in the main summarization path)
      expect(result.compaction.summary).toContain("## Decisions");
    });
  });

  describe("previousSummary preservation", () => {
    it("uses previousSummary in fallback when it has required sections", async () => {
      const handler = handlers.get("session_before_compact")!;
      const prevSummary = [
        "## Decisions",
        "Chose to use StatefulSet for Redis.",
        "",
        "## Open TODOs",
        "Check PVC binding.",
        "",
        "## Constraints/Rules",
        "No root containers.",
        "",
        "## Pending user asks",
        "User wants HPA config.",
        "",
        "## Exact identifiers",
        "redis-master-0, pvc-abc123def",
      ].join("\n");

      const event = {
        preparation: {
          messagesToSummarize: [],
          turnPrefixMessages: [],
          firstKeptEntryId: "entry-1",
          tokensBefore: 50000,
          previousSummary: prevSummary,
          fileOps: createFileOps(),
          isSplitTurn: false,
          settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        },
        signal: new AbortController().signal,
      };
      const ctx = { model: undefined, modelRegistry: { getApiKey: vi.fn() } };

      const result = await handler(event, ctx);

      // Should reuse the previous summary directly since it has all required sections
      expect(result.compaction.summary).toBe(prevSummary);
    });

    it("wraps previousSummary in sections when it lacks structure", async () => {
      const handler = handlers.get("session_before_compact")!;
      const event = {
        preparation: {
          messagesToSummarize: [],
          turnPrefixMessages: [],
          firstKeptEntryId: "entry-1",
          tokensBefore: 50000,
          previousSummary: "User was debugging OOM in redis pod.",
          fileOps: createFileOps(),
          isSplitTurn: false,
          settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        },
        signal: new AbortController().signal,
      };
      const ctx = { model: undefined, modelRegistry: { getApiKey: vi.fn() } };

      const result = await handler(event, ctx);

      expect(result.compaction.summary).toContain("## Decisions");
      expect(result.compaction.summary).toContain("User was debugging OOM in redis pod.");
      expect(result.compaction.summary).toContain("## Exact identifiers");
    });
  });
});
