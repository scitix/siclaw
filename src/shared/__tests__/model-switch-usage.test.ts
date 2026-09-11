import { beforeEach, expect, it } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { emitDiagnostic } from "../diagnostic-events.js";
import { metricsRegistry } from "../metrics.js";

beforeEach(() => metricsRegistry.resetMetrics());

async function response(modelId: string, input: number, cached: number, output: number, reasoning: number) {
  const model = { id: modelId, provider: "test", cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 } };
  const message: any = { role: "assistant", content: [], model: modelId, provider: "test", stopReason: "stop" };
  async function* events() {
    yield { type: "response.completed", response: { status: "completed", output: [], usage: {
      input_tokens: input, input_tokens_details: { cached_tokens: cached },
      output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning }, total_tokens: input + output,
    } } };
  }
  await processResponsesStream(events() as any, message, { push: () => {} } as any, model as any);
  return message;
}

function stats(entries: any[]) {
  // Exercise the installed SDK's accounting across a restored session, without
  // provider calls. Compacted entries still belong to the billable history.
  return AgentSession.prototype.getSessionStats.call({
    sessionManager: { getEntries: () => entries }, getContextUsage: () => undefined,
  } as any);
}

function record(sessionId: string, model: string, before: ReturnType<typeof stats>, after: ReturnType<typeof stats>) {
  emitDiagnostic({ type: "prompt_complete", sessionId, prev: before, curr: after,
    model: { id: model, provider: "test" } as any, durationMs: 1, outcome: "completed" });
}

it("keeps cached and reasoning tokens disjoint across model changes and restored history", async () => {
  const history: any[] = [];
  const empty = stats(history);
  const first = await response("model-a", 100, 60, 30, 20);
  expect(first.usage).toMatchObject({ input: 40, cacheRead: 60, output: 30, reasoning: 20, totalTokens: 130 });
  history.push({ type: "message", message: first });
  const afterA = stats(history);
  expect(afterA.tokens.total).toBe(130); // Reasoning is already included in output.
  record("parent", "model-a", empty, afterA);

  const restored = structuredClone(history);
  const beforeB = stats(restored);
  restored.push({ type: "message", message: await response("model-b", 200, 100, 40, 10) });
  const afterB = stats(restored);
  expect(afterB.tokens.total).toBe(370);
  record("parent", "model-b", beforeB, afterB);

  const child = [{ type: "message", message: await response("fast-model", 50, 10, 20, 5) }];
  record("child", "fast-model", stats([]), stats(child));
  // A later parent turn reuses its own history, excluding the child's tokens.
  expect(stats(restored).tokens.total).toBe(370);
  const samples = (await metricsRegistry.getMetricsAsJSON()).find((metric) => metric.name === "siclaw_tokens_total")!.values;
  const byModel = (id: string) => samples.filter((sample) => sample.labels.model === id).reduce((sum, sample) => sum + sample.value, 0);
  expect(byModel("model-a")).toBe(130);
  expect(byModel("model-b")).toBe(240);
  expect(byModel("fast-model")).toBe(70);
});

it("retains compacted history and charges a recorded compaction only once", async () => {
  const message = await response("model-a", 100, 60, 30, 20);
  const compact = await response("model-a", 50, 0, 10, 0);
  const history = [{ type: "message", message }, { type: "compaction", usage: compact.usage }];
  expect(stats(history).tokens.total).toBe(190);
  expect(stats(structuredClone(history)).tokens.total).toBe(190);
});
