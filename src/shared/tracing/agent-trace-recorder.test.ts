/**
 * AgentTraceRecorder unit tests.
 *
 * Strategy: install a NodeTracerProvider wired to an InMemorySpanExporter via a
 * SimpleSpanProcessor (synchronous export on span.end()) through the recorder's
 * test seam, then assert the exported span tree. The PII gate
 * (config.tracing.sendContent) lives in otel-provider module state and is
 * controlled via setSendContent() (re-installs the provider with the flag).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { SpanStatusCode } from "@opentelemetry/api";

import { tracingRecorder, __resetRecorderForTest } from "./agent-trace-recorder.js";
import { __installTracerProviderForTest } from "./otel-provider.js";

// The PII gate now lives in otel-provider module state (set on init/reinit), not
// loadConfig — the recorder reads isSendContentEnabled(). Drive it per test by
// re-installing the same provider with the desired flag through the test seam.
function setSendContent(value: boolean): void {
  __installTracerProviderForTest(provider, value);
}
import { Attr, SpanKind } from "./openinference-attrs.js";
import type { BrainSession, BrainSessionStats } from "../../core/brain-session.js";

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeBrain extends BrainSession {
  _setStats(stats: BrainSessionStats): void;
}

function makeBrain(opts?: { getModelThrows?: boolean }): FakeBrain {
  let stats: BrainSessionStats = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
  const brain = {
    brainType: "pi-agent" as const,
    getModel() {
      if (opts?.getModelThrows) throw new Error("boom");
      return { id: "gpt-x", name: "GPT-X", provider: "openai", contextWindow: 128000, maxTokens: 4096, reasoning: false };
    },
    // Return a copy each call so the start-snapshot is not aliased to later mutations.
    getSessionStats(): BrainSessionStats {
      return { tokens: { ...stats.tokens }, cost: stats.cost };
    },
    _setStats(next: BrainSessionStats) {
      stats = next;
    },
  };
  return brain as unknown as FakeBrain;
}

const SID = "session-1";

// ── span-tree query helpers ───────────────────────────────────────────────────

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

function spans(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}
function byKind(kind: string): ReadableSpan[] {
  return spans().filter((s) => s.attributes[Attr.spanKind] === kind);
}
function root(): ReadableSpan {
  const roots = byKind(SpanKind.AGENT);
  expect(roots.length).toBe(1);
  return roots[0];
}
function parentIdOf(s: ReadableSpan): string | undefined {
  // SDK 2.x exposes the parent via parentSpanContext (legacy parentSpanId is gone).
  return s.parentSpanContext?.spanId;
}
function eventNames(s: ReadableSpan): string[] {
  return s.events.map((e) => e.name);
}

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  __installTracerProviderForTest(provider, false);
  __resetRecorderForTest();
});

afterEach(() => {
  __installTracerProviderForTest(null);
  __resetRecorderForTest();
});

// ── 1. Non-routing: ROOT(AGENT) with LLM + concurrent TOOL children ──────────

describe("non-routing prompt", () => {
  it("builds ROOT(AGENT) > TURN(CHAIN) > {LLM, TOOL×2} with correct parents and no toolCallId collision", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, { userId: "u1", agentId: "a1" });
    tracingRecorder.startPrompt(SID);

    tracingRecorder.handleEvent(SID, { type: "agent_start" });
    tracingRecorder.handleEvent(SID, { type: "turn_start" });
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    // Two concurrent tools with the SAME name but distinct ids — must not collide.
    tracingRecorder.handleEvent(SID, { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { cmd: "ls" } });
    tracingRecorder.handleEvent(SID, { type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { cmd: "pwd" } });
    tracingRecorder.handleEvent(SID, { type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: ["ok"], isError: false });
    tracingRecorder.handleEvent(SID, { type: "tool_execution_end", toolCallId: "b", toolName: "bash", result: ["ok"], isError: false });
    tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "endTurn" } });
    tracingRecorder.handleEvent(SID, { type: "turn_end" });
    tracingRecorder.handleEvent(SID, { type: "agent_end" });

    tracingRecorder.endPrompt(SID, "completed");

    const r = root();
    expect(r.attributes[Attr.sessionId]).toBe(SID);
    expect(r.attributes[Attr.userId]).toBe("u1");
    expect(r.status.code).toBe(SpanStatusCode.OK);

    const turns = byKind(SpanKind.CHAIN);
    expect(turns.length).toBe(1);
    expect(parentIdOf(turns[0])).toBe(r.spanContext().spanId);

    const llms = byKind(SpanKind.LLM);
    expect(llms.length).toBe(1);
    expect(parentIdOf(llms[0])).toBe(turns[0].spanContext().spanId);

    const tools = byKind(SpanKind.TOOL);
    expect(tools.length).toBe(2);
    // distinct spans, both parented to the open TURN
    expect(new Set(tools.map((t) => t.spanContext().spanId)).size).toBe(2);
    for (const t of tools) {
      expect(parentIdOf(t)).toBe(turns[0].spanContext().spanId);
      expect(t.attributes[Attr.toolName]).toBe("bash");
      expect(t.status.code).toBe(SpanStatusCode.OK);
    }
  });

  it("marks an errored tool span ERROR", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "tool_execution_start", toolCallId: "x", toolName: "kubectl", args: {} });
    tracingRecorder.handleEvent(SID, { type: "tool_execution_end", toolCallId: "x", toolName: "kubectl", result: ["nope"], isError: true });
    tracingRecorder.endPrompt(SID, "completed");

    const tools = byKind(SpanKind.TOOL);
    expect(tools.length).toBe(1);
    expect(tools[0].status.code).toBe(SpanStatusCode.ERROR);
  });
});

// ── 2. Routing path: events arrive via handleEvent (extra channel) ────────────

describe("routing path (extra channel)", () => {
  it("records model_route_* as ROOT span events and trees only the winning attempt's brain events", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);

    // model routing replays through emitSessionExtraEvent → handleEvent.
    // Failed attempt's *live brain events* never reach handleEvent (the gated
    // brain.subscribe is off during routing), so we simply do not feed them.
    tracingRecorder.handleEvent(SID, { type: "model_route_start", strategy: "ordered_fallback", candidateCount: 2, primaryProvider: "openai", primaryModelId: "gpt-x" });
    tracingRecorder.handleEvent(SID, { type: "model_route_attempt", attempt: 1, provider: "openai", modelId: "gpt-x", status: "failed", failureKind: "server_error" });
    tracingRecorder.handleEvent(SID, { type: "model_route_switch", attempt: 2, toProvider: "anthropic", toModelId: "claude", failureKind: "server_error" });
    // winning attempt brain events
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "endTurn" } });
    tracingRecorder.handleEvent(SID, { type: "model_route_success", attempt: 2, provider: "anthropic", modelId: "claude", isFallback: true });

    tracingRecorder.endPrompt(SID, "completed");

    const r = root();
    const evts = eventNames(r);
    expect(evts).toContain("model_route_start");
    expect(evts).toContain("model_route_attempt");
    expect(evts).toContain("model_route_switch");
    expect(evts).toContain("model_route_success");
    // route-event attributes are mapped onto the span event
    const successEvt = r.events.find((e) => e.name === "model_route_success");
    expect(successEvt?.attributes?.provider).toBe("anthropic");
    expect(successEvt?.attributes?.attempt).toBe(2);

    // ROOT model identity reflects the WINNING model (claude) from
    // model_route_success, NOT the primary (gpt-x) pinned at startPrompt.
    expect(r.attributes[Attr.llmModelName]).toBe("claude");
    expect(r.attributes[Attr.llmProvider]).toBe("anthropic");

    // Exactly one LLM span — the winning attempt. No failed-attempt span leaked.
    expect(byKind(SpanKind.LLM).length).toBe(1);
  });
});

// ── 3. Multiple agent_start/end (auto-retry) do not split the ROOT ────────────

describe("auto-retry within one prompt", () => {
  it("keeps a single ROOT across multiple agent_start/agent_end pairs", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);

    // first (empty) attempt
    tracingRecorder.handleEvent(SID, { type: "agent_start" });
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [], stopReason: "endTurn" } });
    tracingRecorder.handleEvent(SID, { type: "agent_end" });
    tracingRecorder.handleEvent(SID, { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000 });
    tracingRecorder.handleEvent(SID, { type: "auto_retry_end", attempt: 1, success: true });
    // retried attempt
    tracingRecorder.handleEvent(SID, { type: "agent_start" });
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "endTurn" } });
    tracingRecorder.handleEvent(SID, { type: "agent_end" });

    tracingRecorder.endPrompt(SID, "completed");

    // exactly one ROOT, two LLM spans both parented to it
    expect(byKind(SpanKind.AGENT).length).toBe(1);
    const r = root();
    expect(eventNames(r).filter((n) => n === "agent_start").length).toBe(2);
    expect(eventNames(r).filter((n) => n === "agent_end").length).toBe(2);
    expect(eventNames(r)).toContain("auto_retry_start");
    expect(eventNames(r)).toContain("auto_retry_end");

    const llms = byKind(SpanKind.LLM);
    expect(llms.length).toBe(2);
    for (const llm of llms) expect(parentIdOf(llm)).toBe(r.spanContext().spanId);
  });
});

// ── 4. Authoritative token/cost delta on ROOT from getSessionStats ────────────

describe("token/cost delta", () => {
  it("attaches getSessionStats() delta (post − pre) to ROOT at endPrompt", () => {
    const brain = makeBrain();
    brain._setStats({ tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, total: 16 }, cost: 0.002 });
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID); // snapshot at 16 total / 0.002 cost

    // simulate the prompt consuming more tokens
    brain._setStats({ tokens: { input: 110, output: 55, cacheRead: 4, cacheWrite: 2, total: 171 }, cost: 0.012 });
    tracingRecorder.endPrompt(SID, "completed");

    const r = root();
    expect(r.attributes[Attr.tokenPrompt]).toBe(100);
    expect(r.attributes[Attr.tokenCompletion]).toBe(50);
    expect(r.attributes[Attr.tokenTotal]).toBe(155);
    expect(r.attributes[Attr.tokenCacheRead]).toBe(3);
    expect(r.attributes[Attr.tokenCacheWrite]).toBe(2);
    expect(r.attributes[Attr.cost]).toBeCloseTo(0.01, 6);
  });
});

// ── 5. Disabled: every method is a clean no-op ────────────────────────────────

describe("disabled (no tracer provider installed)", () => {
  it("produces no spans", () => {
    __installTracerProviderForTest(null); // isTracingEnabled() → false
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [], stopReason: "endTurn" } });
    tracingRecorder.endPrompt(SID, "completed");
    expect(spans().length).toBe(0);
  });
});

// ── 6. detach force-ends in-flight spans (ABORTED) and is idempotent ──────────

describe("detach", () => {
  it("force-ends open spans as ERROR/aborted and flushes them", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "turn_start" });
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, { type: "tool_execution_start", toolCallId: "open", toolName: "bash", args: {} });
    // SIGTERM mid-run: detach with LLM + TOOL + TURN + ROOT all open
    tracingRecorder.detach(SID);

    const r = root();
    expect(r.status.code).toBe(SpanStatusCode.ERROR);
    expect(eventNames(r)).toContain("aborted");
    expect(byKind(SpanKind.LLM)[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(byKind(SpanKind.TOOL)[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(byKind(SpanKind.CHAIN)[0].status.code).toBe(SpanStatusCode.ERROR);

    const countAfterFirst = spans().length;
    // second detach is a no-op (idempotent) — no throw, no extra spans
    expect(() => tracingRecorder.detach(SID)).not.toThrow();
    expect(spans().length).toBe(countAfterFirst);
  });
});

// ── 7. Fault tolerance: internal throws are swallowed, never rethrown ─────────

describe("fault isolation", () => {
  it("swallows an internal throw inside handleEvent", () => {
    const brain = makeBrain({ getModelThrows: true });
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID); // getModel throws here too, but is caught
    // message_start dispatch calls brain.getModel() → throws → must be swallowed
    expect(() => tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } })).not.toThrow();
    expect(() => tracingRecorder.endPrompt(SID, "completed")).not.toThrow();
  });

  it("drops events that arrive with no open ROOT without throwing", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    // no startPrompt → no ROOT
    expect(() => tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } })).not.toThrow();
    expect(spans().length).toBe(0);
  });
});

// ── 8. sendContent gate ───────────────────────────────────────────────────────

describe("sendContent gate", () => {
  it("writes NO content attributes when sendContent=false (default)", () => {
    setSendContent(false);
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { cmd: "echo hi" } });
    tracingRecorder.handleEvent(SID, { type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: ["hi"], isError: false });
    tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "endTurn" } });
    tracingRecorder.endPrompt(SID, "completed");

    const tool = byKind(SpanKind.TOOL)[0];
    expect(tool.attributes[Attr.toolParameters]).toBeUndefined();
    expect(tool.attributes[Attr.inputValue]).toBeUndefined();
    expect(tool.attributes[Attr.outputValue]).toBeUndefined();
  });

  it("writes redacted content when sendContent=true, but records tool_result as-is", () => {
    setSendContent(true);
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    // tool args carry a connection-string secret → must be redacted on the way out
    tracingRecorder.handleEvent(SID, { type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { url: "postgres://admin:hunter2@db:5432" } });
    // tool_result is already model-side sanitized → recorded verbatim (not re-redacted)
    tracingRecorder.handleEvent(SID, { type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: "already-clean-result", isError: false });
    tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "plain answer" }], stopReason: "endTurn" } });
    tracingRecorder.endPrompt(SID, "completed");

    const tool = byKind(SpanKind.TOOL)[0];
    const params = String(tool.attributes[Attr.toolParameters]);
    expect(params).not.toContain("hunter2");
    expect(params).toContain("REDACTED");
    // tool_result recorded verbatim
    expect(tool.attributes[Attr.outputValue]).toBe("already-clean-result");

    const llm = byKind(SpanKind.LLM)[0];
    expect(llm.attributes[Attr.outputValue]).toBe("plain answer");
  });
});

// ── 9. Per-call token/cost on the LLM span (from message.usage) ──────────────

describe("per-call token/cost on LLM span", () => {
  const usage = { input: 42, output: 17, totalTokens: 59, cost: { total: 0.0033 } };

  it("attaches llm.token_count.* + llm.cost.total from message.usage, independent of sendContent", () => {
    setSendContent(false); // tokens are metadata, NOT gated by sendContent
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "endTurn", usage },
    });
    tracingRecorder.endPrompt(SID, "completed");

    const llm = byKind(SpanKind.LLM)[0];
    expect(llm.attributes[Attr.tokenPrompt]).toBe(42);
    expect(llm.attributes[Attr.tokenCompletion]).toBe(17);
    expect(llm.attributes[Attr.tokenTotal]).toBe(59);
    expect(llm.attributes[Attr.cost]).toBeCloseTo(0.0033, 6);
  });

  it("attaches per-call token when message_end arrives via the routing extra channel (recorder is source-agnostic)", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    // Simulate the routing replay: model_route_* + the winning attempt's message_*
    // all arrive through the same handleEvent entry.
    tracingRecorder.handleEvent(SID, { type: "model_route_start", strategy: "ordered_fallback", candidateCount: 1 });
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "endTurn", usage },
    });
    tracingRecorder.handleEvent(SID, { type: "model_route_success", attempt: 1, provider: "openai", modelId: "gpt-x" });
    tracingRecorder.endPrompt(SID, "completed");

    const llm = byKind(SpanKind.LLM)[0];
    expect(llm.attributes[Attr.tokenPrompt]).toBe(42);
    expect(llm.attributes[Attr.tokenCompletion]).toBe(17);
    expect(llm.attributes[Attr.tokenTotal]).toBe(59);
    expect(llm.attributes[Attr.cost]).toBeCloseTo(0.0033, 6);
  });

  it("skips fields that are missing or non-numeric, never writing wrong data", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    // Only `input` is a valid number; output is a string, totalTokens absent, cost.total missing.
    tracingRecorder.handleEvent(SID, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "endTurn",
        usage: { input: 7, output: "nope", cost: {} },
      },
    });
    tracingRecorder.endPrompt(SID, "completed");

    const llm = byKind(SpanKind.LLM)[0];
    expect(llm.attributes[Attr.tokenPrompt]).toBe(7);
    expect(llm.attributes[Attr.tokenCompletion]).toBeUndefined();
    expect(llm.attributes[Attr.tokenTotal]).toBeUndefined();
    expect(llm.attributes[Attr.cost]).toBeUndefined();
  });
});

// ── 10. ROOT input.value = the user prompt (gated by sendContent) ─────────────

describe("ROOT input.value", () => {
  it("omits input.value when sendContent=false", () => {
    setSendContent(false);
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID, "what pods are crashing?");
    tracingRecorder.endPrompt(SID, "completed");
    expect(root().attributes[Attr.inputValue]).toBeUndefined();
  });

  it("records the redacted prompt as input.value when sendContent=true", () => {
    setSendContent(true);
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID, "connect to postgres://admin:hunter2@db:5432 and check");
    tracingRecorder.endPrompt(SID, "completed");

    const input = String(root().attributes[Attr.inputValue]);
    expect(input).not.toContain("hunter2");
    expect(input).toContain("REDACTED");
  });

  it("writes no input.value when promptText is absent, even with sendContent=true", () => {
    setSendContent(true);
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID); // no promptText
    tracingRecorder.endPrompt(SID, "completed");
    expect(root().attributes[Attr.inputValue]).toBeUndefined();
  });
});

// ── 11. Content length cap (bloat hygiene) ────────────────────────────────────

describe("content length cap", () => {
  it("truncates over-long content with a visible marker", () => {
    setSendContent(true);
    const brain = makeBrain();
    const big = "x".repeat(20000);
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: big }], stopReason: "endTurn" },
    });
    tracingRecorder.endPrompt(SID, "completed");

    const out = String(byKind(SpanKind.LLM)[0].attributes[Attr.outputValue]);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("[+12000 chars]");
  });
});

// ── 12. tool_execution_start writes tool.parameters but NOT input.value ───────

describe("tool args use tool.parameters only", () => {
  it("sets tool.parameters and leaves input.value unset on the TOOL span", () => {
    setSendContent(true);
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { cmd: "ls" } });
    tracingRecorder.handleEvent(SID, { type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: ["ok"], isError: false });
    tracingRecorder.endPrompt(SID, "completed");

    const tool = byKind(SpanKind.TOOL)[0];
    expect(String(tool.attributes[Attr.toolParameters])).toContain("ls");
    expect(tool.attributes[Attr.inputValue]).toBeUndefined();
  });
});
