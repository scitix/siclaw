import { describe, it, expect } from "vitest";
import {
  wrapStreamFnTrimToolCallNames,
  wrapStreamFnRepairMalformedToolCallArguments,
  extractBalancedJsonPrefix,
  shouldAttemptMalformedToolCallRepair,
  tryParseMalformedToolCallArguments,
} from "./stream-wrappers.js";

// ── Helper: create a mock stream ─────────────────────────────────────────

function createMockStream(events: any[], finalMessage: any) {
  let eventIndex = 0;
  return {
    result: async () => finalMessage,
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (eventIndex < events.length) {
            return { done: false, value: events[eventIndex++] };
          }
          return { done: true, value: undefined };
        },
        async return() { return { done: true as const, value: undefined }; },
        async throw() { return { done: true as const, value: undefined }; },
      };
    },
  };
}

// ── extractBalancedJsonPrefix ────────────────────────────────────────────

describe("extractBalancedJsonPrefix", () => {
  it("extracts balanced JSON object", () => {
    expect(extractBalancedJsonPrefix('{"key": "value"}trailing')).toBe('{"key": "value"}');
  });

  it("extracts balanced JSON array", () => {
    expect(extractBalancedJsonPrefix('[1, 2, 3]extra')).toBe("[1, 2, 3]");
  });

  it("handles nested objects", () => {
    const input = '{"a": {"b": "c"}}xyz';
    expect(extractBalancedJsonPrefix(input)).toBe('{"a": {"b": "c"}}');
  });

  it("handles strings with braces", () => {
    const input = '{"text": "hello { world }"}extra';
    expect(extractBalancedJsonPrefix(input)).toBe('{"text": "hello { world }"}');
  });

  it("returns null for unbalanced JSON", () => {
    expect(extractBalancedJsonPrefix('{"key": "value"')).toBeNull();
  });

  it("returns null for non-JSON input", () => {
    expect(extractBalancedJsonPrefix("just text")).toBeNull();
  });

  it("skips leading whitespace", () => {
    expect(extractBalancedJsonPrefix('  {"a": 1}rest')).toBe('{"a": 1}');
  });

  it("handles escaped quotes in strings", () => {
    const input = '{"text": "say \\"hello\\""}rest';
    expect(extractBalancedJsonPrefix(input)).toBe('{"text": "say \\"hello\\""}');
  });
});

// ── shouldAttemptMalformedToolCallRepair ──────────────────────────────────

describe("shouldAttemptMalformedToolCallRepair", () => {
  it("returns true when delta contains closing brace", () => {
    expect(shouldAttemptMalformedToolCallRepair('{"a": 1}', "}")).toBe(true);
  });

  it("returns true when delta contains closing bracket", () => {
    expect(shouldAttemptMalformedToolCallRepair("[1]", "]")).toBe(true);
  });

  it("returns true for short trailing chars when partialJson has closing braces", () => {
    expect(shouldAttemptMalformedToolCallRepair('{"a": 1}x', "x")).toBe(true);
  });

  it("returns false for long delta without closing chars", () => {
    expect(shouldAttemptMalformedToolCallRepair('{"a":', '"value"')).toBe(false);
  });
});

// ── tryParseMalformedToolCallArguments ────────────────────────────────────

describe("tryParseMalformedToolCallArguments", () => {
  it("returns undefined for valid JSON", () => {
    expect(tryParseMalformedToolCallArguments('{"key": "value"}')).toBeUndefined();
  });

  it("repairs JSON with short trailing suffix", () => {
    const result = tryParseMalformedToolCallArguments('{"key": "value"}x');
    expect(result).toBeDefined();
    expect(result!.args).toEqual({ key: "value" });
    expect(result!.trailingSuffix).toBe("x");
  });

  it("returns undefined for empty input", () => {
    expect(tryParseMalformedToolCallArguments("")).toBeUndefined();
    expect(tryParseMalformedToolCallArguments("  ")).toBeUndefined();
  });

  it("returns undefined when trailing suffix is too long", () => {
    expect(tryParseMalformedToolCallArguments('{"key": "value"}toolong')).toBeUndefined();
  });

  it("returns undefined for non-object JSON", () => {
    expect(tryParseMalformedToolCallArguments("[1, 2, 3]x")).toBeUndefined();
  });

  it("returns undefined when no balanced prefix found", () => {
    expect(tryParseMalformedToolCallArguments('{"key": "value')).toBeUndefined();
  });
});

// ── wrapStreamFnTrimToolCallNames ────────────────────────────────────────

describe("wrapStreamFnTrimToolCallNames", () => {
  it("trims whitespace from tool call names in stream events", async () => {
    const message = {
      content: [{ type: "toolCall", id: "call_1", name: " memory_search ", arguments: {} }],
    };
    const events = [
      { partial: { ...message }, message: { ...message } },
    ];
    const mockStream = createMockStream(events, { ...message });
    const baseFn = () => mockStream;
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn);
    const stream = wrappedFn("model", {}, {});

    for await (const event of stream) {
      expect(event.partial.content[0].name).toBe("memory_search");
      expect(event.message.content[0].name).toBe("memory_search");
    }

    const result = await stream.result();
    expect(result.content[0].name).toBe("memory_search");
  });

  it("assigns fallback IDs to tool calls with missing IDs", async () => {
    const message = {
      content: [
        { type: "toolCall", name: "test_tool", arguments: {} },
      ],
    };
    const mockStream = createMockStream([], { ...message });
    const baseFn = () => mockStream;
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn);
    const stream = wrappedFn("model", {}, {});
    const result = await stream.result();
    expect(result.content[0].id).toMatch(/^call_auto_/);
  });

  it("handles promise-returning baseFn", async () => {
    const message = {
      content: [{ type: "toolCall", id: "call_1", name: "test ", arguments: {} }],
    };
    const mockStream = createMockStream([], { ...message });
    const baseFn = () => Promise.resolve(mockStream);
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn);
    const stream = await wrappedFn("model", {}, {});
    const result = await stream.result();
    expect(result.content[0].name).toBe("test");
  });

  it("deduplicates tool call IDs", async () => {
    const message = {
      content: [
        { type: "toolCall", id: "call_1", name: "tool_a", arguments: {} },
        { type: "toolCall", id: "call_1", name: "tool_b", arguments: {} },
      ],
    };
    const mockStream = createMockStream([], { ...message });
    const baseFn = () => mockStream;
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn);
    const stream = wrappedFn("model", {}, {});
    const result = await stream.result();
    const ids = result.content.map((b: any) => b.id);
    expect(new Set(ids).size).toBe(2);
  });
});

// ── wrapStreamFnRepairMalformedToolCallArguments ─────────────────────────

describe("wrapStreamFnRepairMalformedToolCallArguments", () => {
  it("repairs malformed JSON arguments on toolcall_end", async () => {
    const partialMessage = {
      content: [{ type: "toolCall", id: "call_1", name: "test", arguments: {} }],
    };
    const events = [
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"query": "hello"}',
        partial: partialMessage,
        message: partialMessage,
      },
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "x",
        partial: partialMessage,
        message: partialMessage,
      },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: "call_1", name: "test", arguments: {} },
        partial: partialMessage,
        message: partialMessage,
      },
    ];
    const finalMessage = {
      content: [{ type: "toolCall", id: "call_1", name: "test", arguments: {} }],
    };
    const mockStream = createMockStream(events, finalMessage);
    const baseFn = () => mockStream;
    const wrappedFn = wrapStreamFnRepairMalformedToolCallArguments(baseFn);
    const stream = wrappedFn("model", {}, {});

    // Consume events
    for await (const _event of stream) {
      // events processed
    }

    const result = await stream.result();
    expect(result.content[0].arguments).toEqual({ query: "hello" });
  });

  it("does not modify valid JSON arguments", async () => {
    const partialMessage = {
      content: [{ type: "toolCall", id: "call_1", name: "test", arguments: {} }],
    };
    const events = [
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"query": "hello"}',
        partial: partialMessage,
        message: partialMessage,
      },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: "call_1", name: "test", arguments: { query: "hello" } },
        partial: partialMessage,
        message: partialMessage,
      },
    ];
    const finalMessage = {
      content: [{ type: "toolCall", id: "call_1", name: "test", arguments: { query: "hello" } }],
    };
    const mockStream = createMockStream(events, finalMessage);
    const baseFn = () => mockStream;
    const wrappedFn = wrapStreamFnRepairMalformedToolCallArguments(baseFn);
    const stream = wrappedFn("model", {}, {});

    for await (const _event of stream) {}

    const result = await stream.result();
    // Valid JSON should not be modified
    expect(result.content[0].arguments).toEqual({ query: "hello" });
  });

  it("disables repair for extremely large buffers", async () => {
    const largeJson = '{"data": "' + "x".repeat(70_000) + '"}';
    const partialMessage = {
      content: [{ type: "toolCall", id: "call_1", name: "test", arguments: {} }],
    };
    const events = [
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: largeJson,
        partial: partialMessage,
        message: partialMessage,
      },
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "}",
        partial: partialMessage,
        message: partialMessage,
      },
    ];
    const finalMessage = {
      content: [{ type: "toolCall", id: "call_1", name: "test", arguments: {} }],
    };
    const mockStream = createMockStream(events, finalMessage);
    const baseFn = () => mockStream;
    const wrappedFn = wrapStreamFnRepairMalformedToolCallArguments(baseFn);
    const stream = wrappedFn("model", {}, {});

    for await (const _event of stream) {}

    const result = await stream.result();
    // Should not have been repaired (buffer too large)
    expect(result.content[0].arguments).toEqual({});
  });
});
