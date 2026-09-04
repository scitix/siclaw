import { describe, it, expect } from "vitest";
// Relative import on purpose: the converter is not on pi-ai's export map, and
// this test exists precisely to pin the behaviour of the installed version.
import { convertMessages } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";

/** The compat shape openai-completions' converter reads; plain OpenAI defaults. */
const OPENAI_COMPAT = {
  supportsStore: true,
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: "openai",
  openRouterRouting: {},
  supportsStrictMode: true,
};

/**
 * The recorder stamps `llmCall` onto the assistant message object that pi-agent
 * keeps in its context. That object is replayed to the provider on every later
 * turn, so the stamp must never reach the request body. Pinned against the
 * installed pi-ai: an upgrade that starts forwarding unknown message fields
 * would fail here rather than in production.
 */
describe("llmCall stamp does not leak into the provider request", () => {
  const model = {
    id: "gpt-5",
    name: "gpt-5",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as any;

  it("openai-completions convertMessages drops the llmCall property", () => {
    const assistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      ],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-5",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 1,
      llmCall: { v: 1, round: 1, ms: { net_ttft: 1, thinking: 1, output: 1, total: 3 }, blocks: [], tool_call_ids: ["call_1"] },
    } as any;
    const context = {
      systemPrompt: "sys",
      messages: [
        { role: "user", content: "hi", timestamp: 0 },
        assistant,
        { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 },
      ],
    } as any;

    const params = convertMessages(model, context, OPENAI_COMPAT as any);
    const serialized = JSON.stringify(params);
    expect(serialized).not.toContain("llmCall");
    expect(serialized).not.toContain("net_ttft");
    // Sanity: the assistant turn itself is still forwarded.
    expect(params.some((m: any) => m.role === "assistant")).toBe(true);
  });
});
