import { describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { stream as streamAnthropic } from "../../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js";
import { processResponsesStream } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import { LlmCallRecorder } from "./llm-call-recorder.js";
import type { UsageObservation } from "../shared/model-usage.js";

const model: any = { id: "gpt-example", name: "Example", provider: "openai", api: "openai-completions",
  baseUrl: "https://api.example.test/v1", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context: any = { messages: [{ role: "user", content: "test", timestamp: 1 }], tools: [] };
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 10 } };
function fetchEvents(events: any[], named = false): typeof fetch {
  return (async () => new Response(events.map(e => (named ? `event: ${e.type}\n` : "") + `data: ${JSON.stringify(e)}\n\n`).join("") +
    (named ? "" : "data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
}
async function drain(stream: any) { for await (const _ of stream) { /* consume terminal event */ } return stream.result(); }
describe("provider evidence from the pinned parsers", () => {
  it("captures compatible inclusive input without changing legacy cache-exclusive usage", async () => {
    const result: any = await drain(streamOpenAICompletions(model, context, { apiKey: "fixture", fetch: fetchEvents([
      { id: "response-example", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 } } },
    ]) }));
    expect(result.providerUsageEvidence.rawUsage.prompt_tokens).toBe(100);
    expect(result.providerUsageEvidence.finality).toBe("terminal");
    expect(result.usage.input).toBe(40);
  });
  it.each(["openai-responses", "openai-codex-responses"])("captures %s through the shared SSE/WebSocket processor", async api => {
    const output: any = { content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: {} } };
    await processResponsesStream((async function* () { yield { type: "response.completed", response: { id: "response-example", status: "completed", output: [], usage } }; })(), output, { push() {} } as any, { ...model, api });
    expect(output.providerUsageEvidence).toMatchObject({ finality: "terminal", rawUsage: usage, protocol: api === "openai-codex-responses" ? "codex_responses" : "openai_responses" });
    expect(output.usage.input).toBe(40);
  });
  it("retains reported usage on failed Responses", async () => {
    const output: any = { content: [], usage: {} };
    await expect(processResponsesStream((async function* () { yield { type: "response.failed", response: { status: "failed", usage, error: { code: "fixture", message: "failure" } } }; })(), output, { push() {} } as any, { ...model, api: "openai-codex-responses" })).rejects.toThrow();
    expect(output.providerUsageEvidence.rawUsage).toEqual(usage);
  });
  it("merges cumulative Anthropic usage without adding repeated snapshots", async () => {
    const result: any = await drain(streamAnthropic({ ...model, api: "anthropic-messages", provider: "anthropic" }, context, { apiKey: "fixture", fetch: fetchEvents([
      { type: "message_start", message: { id: "response-example", role: "assistant", model: "example", content: [], usage: { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 0 } } },
      { type: "message_delta", delta: {}, usage: { output_tokens: 5 } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ], true) }));
    expect(result.errorMessage).toBeUndefined();
    expect(result.providerUsageEvidence).toMatchObject({ finality: "terminal", rawUsage: { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 20 } });
  });
  it("keeps missing evidence absent and sanitizes invalid optional strings", async () => {
    const missing: any = await drain(streamOpenAICompletions(model, context, { apiKey: "fixture", fetch: fetchEvents([
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]) }));
    expect(missing.providerUsageEvidence).toBeUndefined();
    const bad: any = await drain(streamOpenAICompletions(model, context, { apiKey: "fixture", fetch: fetchEvents([
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: "private-value" }, extra: "private-value" } },
    ]) }));
    expect(JSON.stringify(bad.providerUsageEvidence)).not.toContain("private-value");
    expect(bad.providerUsageEvidence.invalidFields).toEqual(["prompt_tokens_details.cached_tokens"]);
    expect(bad.providerUsageEvidence.rawUsage).toEqual({ prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: {} });
  });
});
describe("independent logical call observations", () => {
  it("retains failed attempts and trailing auxiliary calls under their dispatch identity", async () => {
    const events: UsageObservation[] = [];
    const recorder = new LlmCallRecorder({ warn() {} });
    let trace = "trace-a";
    recorder.setUsageSink({ context: () => ({ sessionId: "session-example", traceId: trace, executionRole: "root" }), record: o => events.push(o) });
    recorder.registerUsageIdentity("openai", { configId: "config-a", name: "Example", sourceKind: "api", sourceId: "config-a", sourceName: "Example", apiKey: "private-value" });
    recorder.beginPrompt();recorder.beginAttempt(1);
    expect(() => recorder.wrapStreamFn(() => { throw new Error("fixture failure"); })(model, context, {})).toThrow();
    recorder.rollbackAttempt();recorder.beginAttempt(2);
    const stream = recorder.wrapStreamFn(() => ({ async result() { return { stopReason: "stop", providerUsageEvidence: { protocol: "codex_responses", providerUsagePresent: true, finality: "terminal", rawUsage: usage } }; } }))(model, { messages: [] }, {});
    trace = "trace-b";
    await stream.result();await stream.result();recorder.endPrompt();
    expect(events.map(e => [e.phase, e.kind, e.routingAttempt])).toEqual([["started","agent",1],["finished","agent",1],["started","aux",2],["finished","aux",2]]);
    expect(events[1].outcome).toBe("error");
    expect(events[3].traceId).toBe("trace-a");
    expect(new Set(events.map(e => e.callId)).size).toBe(2);
    expect(JSON.stringify(events)).not.toContain("private-value");
  });
});
