import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractJSON, llmComplete, llmCompleteWithTool, getFormattedSkillsPrompt } from "./sub-agent.js";

// Note: runSubAgent is exercised indirectly via engine.test.ts; testing it
// directly requires a full pi-agent session stand-up which is beyond the
// minimal-DI bar. Here we cover pure helpers + the fetch-backed LLM wrappers.

describe("extractJSON — pure function", () => {
  it("parses strictly valid JSON", () => {
    expect(extractJSON('{"a":1}')).toBe('{"a":1}');
  });

  it("parses arrays", () => {
    expect(extractJSON('[1,2,3]')).toBe('[1,2,3]');
  });

  it("extracts from ```json fenced block", () => {
    expect(extractJSON('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("extracts from unlabeled fenced block", () => {
    expect(extractJSON('```\n{"b":2}\n```')).toBe('{"b":2}');
  });

  it("extracts first top-level JSON from mixed text", () => {
    expect(extractJSON('prefix {"x":42} suffix')).toBe('{"x":42}');
  });

  it("handles nested objects", () => {
    expect(extractJSON('start {"a":{"b":1}} end')).toBe('{"a":{"b":1}}');
  });

  it("handles strings containing curly braces", () => {
    const src = '{"note":"{not an object}"}';
    expect(extractJSON(src)).toBe(src);
  });

  it("returns null for non-JSON text", () => {
    expect(extractJSON("no json here")).toBeNull();
  });

  it("returns null when braces balanced but invalid", () => {
    expect(extractJSON("{bogus}")).toBeNull();
  });
});

// --- llmComplete / llmCompleteWithTool via mocked fetch ---

describe("llmComplete", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws when apiKey missing", async () => {
    await expect(
      llmComplete("sys", "user", { model: "m", baseUrl: "http://x" } as any),
    ).rejects.toThrow(/API key not configured/);
  });

  it("throws when model missing", async () => {
    await expect(
      llmComplete("sys", "user", { apiKey: "k", baseUrl: "http://x" } as any),
    ).rejects.toThrow(/Model not configured/);
  });

  it("throws when baseUrl missing", async () => {
    await expect(
      llmComplete("sys", "user", { apiKey: "k", model: "m" } as any),
    ).rejects.toThrow(/Base URL not configured/);
  });

  it("returns content from chat completion", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
      }),
    }) as any);

    const text = await llmComplete(
      "system",
      "prompt",
      { apiKey: "k", baseUrl: "http://api.example", model: "m" },
    );
    expect(text).toBe("hello world");
  });
});

describe("llmCompleteWithTool", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses tool_calls.arguments into toolArgs", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: "",
            tool_calls: [
              {
                id: "1",
                type: "function",
                function: { name: "submit", arguments: '{"result":"ok"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        }],
      }),
    }) as any);

    const res = await llmCompleteWithTool<{ result: string }>(
      undefined, "u", "submit", "desc", { type: "object" },
      { apiKey: "k", baseUrl: "http://api.example", model: "m" },
    );
    expect(res.toolArgs).toEqual({ result: "ok" });
  });

  it("falls back to extractJSON when no tool_calls", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: 'The answer is {"result":"ok"}.' },
          finish_reason: "stop",
        }],
      }),
    }) as any);

    const res = await llmCompleteWithTool<{ result: string }>(
      undefined, "u", "submit", "desc", { type: "object" },
      { apiKey: "k", baseUrl: "http://api.example", model: "m" },
    );
    expect(res.toolArgs).toEqual({ result: "ok" });
  });

  it("returns null toolArgs when neither tool_calls nor extractable JSON", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: "plain text no json" },
          finish_reason: "stop",
        }],
      }),
    }) as any);

    const res = await llmCompleteWithTool<any>(
      undefined, "u", "submit", "desc", { type: "object" },
      { apiKey: "k", baseUrl: "http://api.example", model: "m" },
    );
    expect(res.toolArgs).toBeNull();
    expect(res.textContent).toBe("plain text no json");
  });

  it("throws when config missing (apiKey)", async () => {
    await expect(
      llmCompleteWithTool(
        undefined, "u", "x", "d", {},
        { model: "m", baseUrl: "http://x" } as any,
      ),
    ).rejects.toThrow(/API key not configured/);
  });
});

describe("getFormattedSkillsPrompt", () => {
  it("returns a string (possibly empty if no skills dir)", () => {
    // First call lazily loads skills; just confirm it's a string
    expect(typeof getFormattedSkillsPrompt()).toBe("string");
  });
});
