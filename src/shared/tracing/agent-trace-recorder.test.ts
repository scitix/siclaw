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
import { SpanStatusCode, TraceFlags, type SpanContext } from "@opentelemetry/api";

import { tracingRecorder, __resetRecorderForTest } from "./agent-trace-recorder.js";
import { __installTracerProviderForTest } from "./otel-provider.js";

// The PII gate now lives in otel-provider module state (set on init/reinit), not
// loadConfig — the recorder reads isSendContentEnabled(). Drive it per test by
// re-installing the same provider with the desired flag through the test seam.
function setSendContent(value: boolean): void {
  __installTracerProviderForTest(provider, value);
}
import { Attr, SpanKind, redactForExport, toolCallsOutputValue, toolDefinitionsInputValue } from "./openinference-attrs.js";
import type { BrainSession, BrainSessionStats, BrainToolDefinition } from "../../core/brain-session.js";

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeBrain extends BrainSession {
  _setStats(stats: BrainSessionStats): void;
}

function makeBrain(opts?: { getModelThrows?: boolean; tools?: BrainToolDefinition[] }): FakeBrain {
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
    // getTools is only present when tools are supplied — so a bare makeBrain()
    // also exercises the "brain has no getTools" path (input.tools skipped).
    ...(opts?.tools ? { getTools: () => opts.tools! } : {}),
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

  it("an id-less errored end closes the OLDEST open tool span (FIFO) instead of dropping the error", () => {
    // Two concurrent tools open; an end event WITHOUT a toolCallId arrives carrying
    // isError. Previously (size>1, no id) it early-returned, the error was dropped,
    // and endPrompt later closed both spans OK — an errored tool logged as success.
    // Now it FIFO-pairs to the oldest open span so the error is not lost.
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "tool_execution_start", toolCallId: "first", toolName: "older", args: {} });
    tracingRecorder.handleEvent(SID, { type: "tool_execution_start", toolCallId: "second", toolName: "newer", args: {} });
    // No toolCallId on the end — the FIFO fallback must pick the oldest ("older").
    tracingRecorder.handleEvent(SID, { type: "tool_execution_end", toolName: "older", result: ["boom"], isError: true });
    tracingRecorder.endPrompt(SID, "completed");

    const tools = byKind(SpanKind.TOOL);
    expect(tools.length).toBe(2);
    // Exactly one span is ERROR (the error survived, not silently OK'd)...
    const errored = tools.filter((t) => t.status.code === SpanStatusCode.ERROR);
    expect(errored.length).toBe(1);
    // ...and it is the OLDEST-started one.
    expect(errored[0].attributes[Attr.toolName]).toBe("older");
  });
});

describe("redactForExport — tool_result is redacted (not trusted-clean)", () => {
  const secretLine = "AWS_SECRET_ACCESS_KEY=abc123";

  it("redacts a tool_result, so MCP/query secrets never ship raw", () => {
    const out = redactForExport(secretLine, "tool_result");
    expect(out).toContain("**REDACTED**");
    expect(out).not.toContain("abc123");
  });

  it("treats tool_result identically to other kinds (uniform redaction)", () => {
    expect(redactForExport(secretLine, "tool_result")).toBe(redactForExport(secretLine, "llm_input"));
  });
});

// ── 1b. Sub-agent nesting: parentSpanContext + ensureToolSpan (method C) ──────

describe("sub-agent span nesting (parentSpanContext / ensureToolSpan)", () => {
  it("startPrompt nests the child ROOT under a provided parentSpanContext (real spanId, inherited trace id)", () => {
    const parent: SpanContext = {
      traceId: "abcdef12345678900987654321fedcba",
      spanId: "1122334455667788",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
    tracingRecorder.attach(SID, makeBrain(), { userId: "u2" });
    // traceId arg = parent's trace; parentSpanContext = the real spawn span.
    tracingRecorder.startPrompt(SID, "child task", "u2", parent.traceId, parent);
    tracingRecorder.endPrompt(SID, "completed");

    const r = root();
    expect(r.spanContext().traceId).toBe(parent.traceId); // inherits T1
    expect(parentIdOf(r)).toBe(parent.spanId);            // nested UNDER the real span
  });

  it("startPrompt with traceId but NO parentSpanContext stays a sibling root (B fallback): trace inherited, parent not the caller", () => {
    const traceId = "00112233445566778899aabbccddeeff";
    tracingRecorder.attach(SID, makeBrain(), {});
    tracingRecorder.startPrompt(SID, "child", "u2", traceId); // no parentSpanContext
    tracingRecorder.endPrompt(SID, "completed");

    const r = root();
    expect(r.spanContext().traceId).toBe(traceId); // still under T1
    // parent is a synthetic remote id (rootContextForTrace random spanId), i.e. NOT a
    // real observed span — the sibling-root behavior of method B, unchanged.
    expect(parentIdOf(r)).toBeDefined();
  });

  it("ensureToolSpan build-or-gets the tool span; a later tool_execution_start reuses it (no duplicate)", () => {
    tracingRecorder.attach(SID, makeBrain(), {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "turn_start" });

    const sc1 = tracingRecorder.ensureToolSpan(SID, "call-1", "spawn_subagent");
    const sc2 = tracingRecorder.ensureToolSpan(SID, "call-1", "spawn_subagent");
    expect(sc1).toBeDefined();
    expect(sc2?.spanId).toBe(sc1?.spanId); // idempotent: same span, not rebuilt

    // The async event channel later opens the SAME tool call → must reuse, add args.
    tracingRecorder.handleEvent(SID, { type: "tool_execution_start", toolCallId: "call-1", toolName: "spawn_subagent", args: { prompt: "go" } });
    tracingRecorder.handleEvent(SID, { type: "tool_execution_end", toolCallId: "call-1", toolName: "spawn_subagent", result: ["ok"], isError: false });
    tracingRecorder.endPrompt(SID, "completed");

    const tools = byKind(SpanKind.TOOL);
    expect(tools.length).toBe(1);                            // NOT duplicated
    expect(tools[0].spanContext().spanId).toBe(sc1?.spanId); // same span reused
    expect(tools[0].attributes[Attr.toolName]).toBe("spawn_subagent");
  });

  it("end-to-end: a child ROOT (separate session) nests under the parent's spawn_subagent span", () => {
    tracingRecorder.attach(SID, makeBrain(), {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "turn_start" });

    // Dispatch: capture the spawn tool span context synchronously (execute path).
    const spawnCtx = tracingRecorder.ensureToolSpan(SID, "spawn-1", "spawn_subagent");
    expect(spawnCtx).toBeDefined();

    // Child prompt (separate session) opens its ROOT nested under the spawn span.
    const CHILD = "session-child";
    tracingRecorder.attach(CHILD, makeBrain(), { userId: "u2" });
    tracingRecorder.startPrompt(CHILD, "child task", "u2", spawnCtx!.traceId, spawnCtx);
    tracingRecorder.endPrompt(CHILD, "completed");

    // Parent's spawn span resolves (event channel reuses the pre-opened span).
    tracingRecorder.handleEvent(SID, { type: "tool_execution_start", toolCallId: "spawn-1", toolName: "spawn_subagent", args: {} });
    tracingRecorder.handleEvent(SID, { type: "tool_execution_end", toolCallId: "spawn-1", toolName: "spawn_subagent", result: ["done"], isError: false });
    tracingRecorder.endPrompt(SID, "completed");

    const childRoot = byKind(SpanKind.AGENT).find((s) => s.attributes[Attr.sessionId] === CHILD);
    expect(childRoot).toBeDefined();
    expect(childRoot!.spanContext().traceId).toBe(spawnCtx!.traceId); // same trace T1
    expect(parentIdOf(childRoot!)).toBe(spawnCtx!.spanId);            // nested under spawn span
  });

  it("ensureToolSpan returns undefined when tracing is disabled", () => {
    __installTracerProviderForTest(null); // isTracingEnabled() → false
    tracingRecorder.attach(SID, makeBrain(), {});
    tracingRecorder.startPrompt(SID);
    expect(tracingRecorder.ensureToolSpan(SID, "c", "spawn_subagent")).toBeUndefined();
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

// ── 4. Token/cost lives ONLY on per-call spans, never on ROOT (no double-count) ─

describe("token/cost is not written to ROOT", () => {
  it("leaves the ROOT free of token/cost so the backend aggregates from per-call spans", () => {
    const brain = makeBrain();
    brain._setStats({ tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, total: 16 }, cost: 0.002 });
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    // even with session stats moving, the ROOT must carry no token/cost — writing
    // it here as well as on the llm.call spans would double the trace-level total.
    brain._setStats({ tokens: { input: 110, output: 55, cacheRead: 4, cacheWrite: 2, total: 171 }, cost: 0.012 });
    tracingRecorder.endPrompt(SID, "completed");

    const r = root();
    expect(r.attributes[Attr.tokenPrompt]).toBeUndefined();
    expect(r.attributes[Attr.tokenCompletion]).toBeUndefined();
    expect(r.attributes[Attr.tokenTotal]).toBeUndefined();
    expect(r.attributes[Attr.tokenCacheRead]).toBeUndefined();
    expect(r.attributes[Attr.tokenCacheWrite]).toBeUndefined();
    expect(r.attributes[Attr.cost]).toBeUndefined();
  });
});

// ── 4b. abortAll closes in-flight traces before a provider swap (hot-reload) ──

describe("abortAll (tracing hot-reload)", () => {
  it("ends open spans on the current provider and clears state so no span is orphaned", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "turn_start" });
    tracingRecorder.handleEvent(SID, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
    // A reload lands mid-prompt (tool still open, no endPrompt yet).
    expect(spans().length).toBe(0); // nothing finished yet

    tracingRecorder.abortAll();

    // ROOT + TURN + TOOL all closed and exported (not orphaned), with the reload marker.
    expect(byKind(SpanKind.TOOL).length).toBe(1);
    expect(byKind(SpanKind.CHAIN).length).toBe(1);
    expect(eventNames(root())).toContain("tracing_reloaded");
    // State cleared: the decoupled trace id is gone, and a late event is a no-op.
    expect(tracingRecorder.getRootTraceId(SID)).toBeUndefined();
    const before = spans().length;
    tracingRecorder.handleEvent(SID, { type: "tool_execution_end", toolCallId: "t1", result: ["x"], isError: false });
    expect(spans().length).toBe(before);
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

  it("still generates a per-prompt trace id (decoupled from the export switch), cleared on endPrompt", () => {
    __installTracerProviderForTest(null); // isTracingEnabled() → false
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    // Q2 decoupling: a trace id exists for DB stamping even with no exported span.
    expect(tracingRecorder.getRootTraceId(SID)).toMatch(/^[0-9a-f]{32}$/);
    expect(spans().length).toBe(0);
    // Leak guard: endPrompt clears promptTraceIds even when disabled — the delete
    // runs BEFORE the isTracingEnabled early-return. If that ordering regresses,
    // getRootTraceId would still return the id here and this test fails.
    tracingRecorder.endPrompt(SID, "completed");
    expect(tracingRecorder.getRootTraceId(SID)).toBeUndefined();
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

// ── 8b. Tool instrumentation on the llm.call generation ───────────────────────

describe("tool instrumentation on llm.call (Langfuse native filters)", () => {
  const TOOLS: BrainToolDefinition[] = [
    { name: "bash", description: "run a shell command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
    { name: "spawn_subagent", description: "dispatch a sub-agent", parameters: { type: "object", properties: { task: { type: "string" } } } },
  ];

  it("writes called tools as OpenAI output.tool_calls with names unconditional, args gated (sendContent=false)", () => {
    setSendContent(false);
    tracingRecorder.attach(SID, makeBrain(), {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "let me look" },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { cmd: "kubectl get pods" } },
        ],
        stopReason: "toolUse",
      },
    });
    tracingRecorder.endPrompt(SID, "completed");

    const llm = byKind(SpanKind.LLM)[0];
    const out = JSON.parse(String(llm.attributes[Attr.outputValue]));
    expect(out.tool_calls).toHaveLength(1);
    expect(out.tool_calls[0].type).toBe("function");
    expect(out.tool_calls[0].id).toBe("call_1");
    expect(out.tool_calls[0].function.name).toBe("bash");
    // arguments key present but empty (gated); no free-text content leaked.
    expect(out.tool_calls[0].function.arguments).toBe("");
    expect("arguments" in out.tool_calls[0].function).toBe(true);
    expect(out.content).toBeUndefined();
  });

  it("includes redacted arguments + free text when sendContent=true", () => {
    setSendContent(true);
    tracingRecorder.attach(SID, makeBrain(), {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "computing" },
          { type: "toolCall", id: "call_9", name: "bash", arguments: { cmd: "echo hi" } },
        ],
        stopReason: "toolUse",
      },
    });
    tracingRecorder.endPrompt(SID, "completed");

    const out = JSON.parse(String(byKind(SpanKind.LLM)[0].attributes[Attr.outputValue]));
    expect(out.tool_calls[0].function.name).toBe("bash");
    expect(out.tool_calls[0].function.arguments).toContain("echo hi");
    expect(out.content).toBe("computing");
  });

  it("writes available tool definitions to input.value on the FIRST llm.call only", () => {
    setSendContent(false);
    tracingRecorder.attach(SID, makeBrain({ tools: TOOLS }), {});
    tracingRecorder.startPrompt(SID);

    // First assistant turn.
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "a" }], stopReason: "endTurn" } });
    // Second assistant turn in the SAME prompt.
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "b" }], stopReason: "endTurn" } });
    tracingRecorder.endPrompt(SID, "completed");

    const llms = byKind(SpanKind.LLM);
    expect(llms.length).toBe(2);
    const withTools = llms.filter((s) => s.attributes[Attr.inputValue] !== undefined);
    expect(withTools.length).toBe(1); // definitions written once, not per turn

    const input = JSON.parse(String(withTools[0].attributes[Attr.inputValue]));
    const names = input.tools.map((t: any) => t.function.name);
    expect(names).toEqual(["bash", "spawn_subagent"]);
    expect(input.tools[0].type).toBe("function");
    expect(input.tools[0].function.parameters).toBeDefined();
  });

  it("skips input.value tool definitions when the brain has no getTools()", () => {
    setSendContent(false);
    tracingRecorder.attach(SID, makeBrain(), {}); // no tools → no getTools
    tracingRecorder.startPrompt(SID);
    expect(() => {
      tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
      tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "endTurn" } });
    }).not.toThrow();
    tracingRecorder.endPrompt(SID, "completed");
    expect(byKind(SpanKind.LLM)[0].attributes[Attr.inputValue]).toBeUndefined();
  });

  it("leaves a pure-text turn's output.value untouched (no tool_calls envelope)", () => {
    setSendContent(true);
    tracingRecorder.attach(SID, makeBrain(), {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "just text" }], stopReason: "endTurn" } });
    tracingRecorder.endPrompt(SID, "completed");
    // Plain string, not a JSON envelope.
    expect(byKind(SpanKind.LLM)[0].attributes[Attr.outputValue]).toBe("just text");
  });

  it("writes no input.value when getTools() is present but returns an empty set", () => {
    setSendContent(false);
    tracingRecorder.attach(SID, makeBrain({ tools: [] }), {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "endTurn" } });
    tracingRecorder.endPrompt(SID, "completed");
    expect(byKind(SpanKind.LLM)[0].attributes[Attr.inputValue]).toBeUndefined();
  });

  it("does not throw when getTools() itself throws (fault isolation)", () => {
    setSendContent(false);
    const brain = makeBrain();
    (brain as any).getTools = () => { throw new Error("boom"); };
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    expect(() => {
      tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
      tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "endTurn" } });
    }).not.toThrow();
    tracingRecorder.endPrompt(SID, "completed");
    expect(byKind(SpanKind.LLM)[0].attributes[Attr.inputValue]).toBeUndefined();
  });

  it("skips malformed toolCall parts (missing / non-string name) and synthesizes a missing id", () => {
    setSendContent(false);
    tracingRecorder.attach(SID, makeBrain(), {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: 42 },            // non-string name → skipped
          { type: "toolCall" },                       // missing name → skipped
          { type: "toolCall", name: "real_tool" },    // valid, no id → synthesized
        ],
        stopReason: "toolUse",
      },
    });
    tracingRecorder.endPrompt(SID, "completed");

    const out = JSON.parse(String(byKind(SpanKind.LLM)[0].attributes[Attr.outputValue]));
    expect(out.tool_calls).toHaveLength(1);
    expect(out.tool_calls[0].function.name).toBe("real_tool");
    expect(out.tool_calls[0].id).toBe("call_0");
  });
});

// ── 8c. Tool attribute builders (serialization-safety contract) ───────────────

describe("tool attribute builders", () => {
  it("toolCallsOutputValue returns undefined with no calls (caller falls back to text path)", () => {
    expect(toolCallsOutputValue([], "hi", true)).toBeUndefined();
  });

  it("toolCallsOutputValue always keeps the arguments key (OpenAI detection needs it)", () => {
    const gated = JSON.parse(toolCallsOutputValue([{ id: "c", name: "bash", args: { cmd: "ls" } }], undefined, false)!);
    expect("arguments" in gated.tool_calls[0].function).toBe(true);
    expect(gated.tool_calls[0].function.arguments).toBe("");
  });

  it("toolDefinitionsInputValue drops a tool's parameters when they exceed paramBudget (keeps name/description)", () => {
    const big = { type: "object", note: "x".repeat(200) };
    const out = JSON.parse(toolDefinitionsInputValue(
      [{ name: "huge", description: "d", parameters: big }],
      { paramBudget: 50 },
    )!);
    expect(out.tools[0].function.name).toBe("huge");
    expect(out.tools[0].function.description).toBe("d");
    expect(out.tools[0].function.parameters).toBeUndefined(); // dropped, JSON still valid
  });

  it("toolDefinitionsInputValue truncates the tools array at totalBudget but keeps ≥1 whole tool and valid JSON", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `tool_${i}`,
      description: "y".repeat(100),
      parameters: { type: "object", properties: {} },
    }));
    const raw = toolDefinitionsInputValue(many, { totalBudget: 400 })!;
    const out = JSON.parse(raw); // must not throw — always-valid JSON
    expect(out.tools.length).toBeGreaterThanOrEqual(1);
    expect(out.tools.length).toBeLessThan(20); // truncated
  });

  it("toolDefinitionsInputValue returns undefined for an empty tool set", () => {
    expect(toolDefinitionsInputValue([])).toBeUndefined();
  });

  it("toolDefinitionsInputValue drops non-serializable parameters (circular) but stays valid JSON", () => {
    const circular: any = { type: "object" };
    circular.self = circular;
    const raw = toolDefinitionsInputValue([{ name: "loopy", description: "d", parameters: circular }])!;
    const out = JSON.parse(raw); // must not throw
    expect(out.tools[0].function.name).toBe("loopy");
    expect(out.tools[0].function.parameters).toBeUndefined();
  });

  it("toolCallsOutputValue synthesizes an id for empty/absent ids (no dedup collision)", () => {
    const out = JSON.parse(toolCallsOutputValue(
      [{ id: "", name: "a" }, { name: "b" }],
      undefined,
      false,
    )!);
    expect(out.tool_calls[0].id).toBe("call_0"); // empty string → synthesized
    expect(out.tool_calls[1].id).toBe("call_1"); // absent → synthesized
    expect(out.tool_calls[0].id).not.toBe(out.tool_calls[1].id);
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

// ── ROOT user.id: per-request (startPrompt) wins, attach ctx is the fallback ──
describe("root span user.id source (per-request vs attach fallback)", () => {
  it("per-request userId (startPrompt) overrides the attach-time ctx.userId", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, { userId: "env-user", agentId: "a1" });
    tracingRecorder.startPrompt(SID, undefined, "request-user");
    tracingRecorder.endPrompt(SID, "completed");
    expect(root().attributes[Attr.userId]).toBe("request-user");
  });

  it("falls back to attach ctx.userId when the per-request userId is an empty string", () => {
    // An owner-less cron task passes userId = "" — `||` (not `??`) must fall
    // back rather than emit a blank user.id.
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, { userId: "env-user", agentId: "a1" });
    tracingRecorder.startPrompt(SID, undefined, "");
    tracingRecorder.endPrompt(SID, "completed");
    expect(root().attributes[Attr.userId]).toBe("env-user");
  });

  it("uses the per-request userId when no attach-time identity exists (in-process spawner)", () => {
    // local / in-process mode never sets process.env.USER_ID, so the attach ctx
    // has no userId — the per-request value is the only source of user.id.
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID, undefined, "request-user");
    tracingRecorder.endPrompt(SID, "completed");
    expect(root().attributes[Attr.userId]).toBe("request-user");
  });

  it("omits user.id when neither per-request nor attach identity is present", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID, undefined, "");
    tracingRecorder.endPrompt(SID, "completed");
    expect(root().attributes[Attr.userId]).toBeUndefined();
  });
});

// ── ROOT trace id: per-prompt id, exposed via getRootTraceId, genuine root ────
describe("root span trace id (decoupled per-prompt id)", () => {
  it("exposes the ROOT span's trace id via getRootTraceId (matches the exported root)", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    const idWhileOpen = tracingRecorder.getRootTraceId(SID);
    expect(idWhileOpen).toMatch(/^[0-9a-f]{32}$/);
    tracingRecorder.endPrompt(SID, "completed");
    expect(root().spanContext().traceId).toBe(idWhileOpen);
  });

  it("uses a genuine random trace root (32-hex) for the main prompt", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.endPrompt(SID, "completed");
    expect(root().spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("propagates the trace id to child spans (turn/llm share the root trace)", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    tracingRecorder.handleEvent(SID, { type: "turn_start" });
    tracingRecorder.handleEvent(SID, { type: "message_start", message: { role: "assistant", content: [] } });
    tracingRecorder.handleEvent(SID, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "endTurn" } });
    tracingRecorder.handleEvent(SID, { type: "turn_end" });
    tracingRecorder.endPrompt(SID, "completed");
    const traceIds = new Set(spans().map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });

  it("clears the trace id on endPrompt", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID);
    expect(tracingRecorder.getRootTraceId(SID)).toBeDefined();
    tracingRecorder.endPrompt(SID, "completed");
    expect(tracingRecorder.getRootTraceId(SID)).toBeUndefined();
  });

  it("generates an id-only trace when tracing is on but no attachment exists", () => {
    // no attach() → startPrompt takes the id-only branch
    tracingRecorder.startPrompt(SID);
    expect(tracingRecorder.getRootTraceId(SID)).toMatch(/^[0-9a-f]{32}$/);
    expect(byKind(SpanKind.AGENT).length).toBe(0); // no ROOT span without attachment
    tracingRecorder.endPrompt(SID, "completed");
    expect(tracingRecorder.getRootTraceId(SID)).toBeUndefined();
  });

  it("adopts a supplied traceId as the root trace id (sub-agent inherits parent T1)", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID, undefined, undefined, "0123456789abcdef0123456789abcdef");
    expect(tracingRecorder.getRootTraceId(SID)).toBe("0123456789abcdef0123456789abcdef");
    tracingRecorder.endPrompt(SID, "completed");
    expect(root().spanContext().traceId).toBe("0123456789abcdef0123456789abcdef");
  });

  it("falls back to a genuine random root when the supplied traceId is invalid", () => {
    const brain = makeBrain();
    tracingRecorder.attach(SID, brain, {});
    tracingRecorder.startPrompt(SID, undefined, undefined, "not-a-valid-trace-id");
    tracingRecorder.endPrompt(SID, "completed");
    const tid = root().spanContext().traceId;
    expect(tid).toMatch(/^[0-9a-f]{32}$/);
    expect(tid).not.toBe("not-a-valid-trace-id");
  });
});
