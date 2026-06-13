import { describe, it, expect, beforeEach, vi } from "vitest";
import { consumeAgentSse } from "./sse-consumer.js";
import { AgentBoxClient } from "./agentbox/client.js";

// ── Mock chat-repo ──────────────────────────────────────
// Replace the module-scoped appendMessage/incrementMessageCount so tests run
// without initializing the FrontendWsClient-backed chat-repo.

const appendCalls: any[] = [];
const updateCalls: any[] = [];
let appendCounter = 0;

vi.mock("./chat-repo.js", () => ({
  appendMessage: vi.fn(async (msg: any) => {
    appendCalls.push(msg);
    return `msg-${++appendCounter}`;
  }),
  updateMessage: vi.fn(async (msg: any) => {
    updateCalls.push(msg);
  }),
  incrementMessageCount: vi.fn(async () => {}),
  ensureChatSession: vi.fn(async () => {}),
  initChatRepo: vi.fn(),
}));

// ── Fake AgentBoxClient that yields scripted events ─────

class FakeAgentBoxClient {
  events: unknown[] = [];
  async *streamEvents(_sessionId: string): AsyncIterable<unknown> {
    for (const e of this.events) yield e;
  }
}

function mkClient(events: unknown[]): AgentBoxClient {
  const c = new FakeAgentBoxClient();
  c.events = events;
  return c as unknown as AgentBoxClient;
}

beforeEach(() => {
  appendCalls.length = 0;
  updateCalls.length = 0;
  appendCounter = 0;
});

// ── Tests ──────────────────────────────────────────────

describe("consumeAgentSse — empty stream", () => {
  it("returns zero eventCount and empty strings", async () => {
    const result = await consumeAgentSse({ client: mkClient([]), sessionId: "s", userId: "u" });
    expect(result.eventCount).toBe(0);
    expect(result.resultText).toBe("");
    expect(result.taskReportText).toBe("");
    expect(result.errorMessage).toBe("");
  });
});

describe("consumeAgentSse — type-less extra events", () => {
  it("does not throw on a tool-pushed event with no `type` (e.g. task_event has `kind`), and keeps processing the stream", async () => {
    // Regression: a bare `eventType.includes("error")` on undefined used to throw
    // and kill the whole SSE stream (STREAM_INTERRUPTED) whenever a task_event
    // (which carries `kind`, not `type`) was streamed.
    const events = [
      { type: "message_start" },
      { kind: "task_event", taskListId: "tl", action: "upsert", task: { id: "1", subject: "x", status: "pending" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];
    const result = await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u" });
    expect(result.eventCount).toBe(4);
    expect(result.resultText).toBe("ok");
    expect(result.errorMessage).toBe("");
  });
});

describe("consumeAgentSse — assistant message flow", () => {
  it("accumulates text deltas across message_update events and returns the concatenated result", async () => {
    const events = [
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] } },
    ];
    const result = await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u" });
    expect(result.resultText).toBe("Hello world");
    expect(result.eventCount).toBe(4);
  });

  it("persists assistant message when persistMessages=true", async () => {
    const events = [
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true });
    const assistantRow = appendCalls.find((r) => r.role === "assistant");
    expect(assistantRow).toBeDefined();
    expect(assistantRow.content).toBe("Hi");
    expect(assistantRow.sessionId).toBe("sid");
  });

  it("skips assistant persistence when cleaned text is empty (pi-agent diagnostic)", async () => {
    const events = [
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "(Empty response: {\"foo\":1})" } },
      { type: "message_end", message: { role: "assistant", content: [] } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    const assistantRow = appendCalls.find((r) => r.role === "assistant");
    expect(assistantRow).toBeUndefined();
  });

  it("captures errorMessage when message has stopReason=error", async () => {
    const events = [
      { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "API 429", content: [] } },
    ];
    const result = await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u" });
    expect(result.errorMessage).toBe("API 429");
  });

  it("persists a synthetic error row (metadata.kind=error_response) so a failed turn survives reload", async () => {
    // The motivating case: model-routing exhausts during setup and emits an
    // error message_end with EMPTY content. The assistantContent persist path
    // skips it (no text), so without the error row nothing about the failure
    // reaches the DB and a refresh shows only the user message.
    const events = [
      { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Context preflight failed: invalid context window", content: [] } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true });
    const errorRow = appendCalls.find((r) => r.metadata?.kind === "error_response");
    expect(errorRow).toBeDefined();
    expect(errorRow.role).toBe("assistant");
    expect(errorRow.sessionId).toBe("sid");
    expect(errorRow.content).toContain("Context preflight failed");
    expect(errorRow.metadata.retriable).toBe(true);
  });

  it("persists the error row only once even when retries emit several error message_ends", async () => {
    const events = [
      { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "API 429", content: [] } },
      { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "API 429", content: [] } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true });
    expect(appendCalls.filter((r) => r.metadata?.kind === "error_response")).toHaveLength(1);
  });

  it("does not persist an error row when persistMessages is unset", async () => {
    const events = [
      { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "API 429", content: [] } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u" });
    expect(appendCalls.find((r) => r.metadata?.kind === "error_response")).toBeUndefined();
  });

  it("falls back to currentMsgText when no message_end provides content", async () => {
    const events = [
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } },
    ];
    const result = await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u" });
    expect(result.resultText).toBe("partial");
  });

  it("persists model-route switch notices and annotates fallback assistant rows", async () => {
    const seen: any[] = [];
    const events = [
      {
        type: "model_route_start",
        strategy: "ordered_fallback",
        candidateCount: 2,
        primaryCandidateKey: "openai/gpt-4",
        primaryProvider: "openai",
        primaryModelId: "gpt-4",
      },
      {
        type: "model_route_switch",
        attempt: 1,
        fromCandidateKey: "openai/gpt-4",
        fromProvider: "openai",
        fromModelId: "gpt-4",
        toCandidateKey: "anthropic/claude",
        toProvider: "anthropic",
        toModelId: "claude",
        failureKind: "rate_limit",
        errorMessage: "429 too many requests",
        cooldownUntil: 123456,
      },
      {
        type: "model_route_success",
        attempt: 2,
        candidateKey: "anthropic/claude",
        provider: "anthropic",
        modelId: "claude",
        isFallback: true,
        primaryCandidateKey: "openai/gpt-4",
      },
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];

    await consumeAgentSse({
      client: mkClient(events),
      sessionId: "sid",
      userId: "u",
      persistMessages: true,
      onEvent: (evt) => seen.push(evt),
    });

    const noticeRow = appendCalls.find((r) => r.metadata?.kind === "model_route_notice");
    expect(noticeRow).toBeDefined();
    expect(noticeRow.content).toContain("Switched to fallback model anthropic/claude");
    expect(noticeRow.metadata).toMatchObject({
      event_type: "model_route.switch",
      from_provider: "openai",
      to_provider: "anthropic",
      failure_kind: "rate_limit",
    });

    const assistantRow = appendCalls.find((r) => r.role === "assistant" && r.content === "ok");
    expect(assistantRow.metadata.model_route).toMatchObject({
      provider: "anthropic",
      model_id: "claude",
      is_fallback: true,
      switched_from_provider: "openai",
      failure_kind: "rate_limit",
    });
    const liveEnd = seen.find((evt) => evt.type === "message_end");
    expect(liveEnd.modelRoute).toMatchObject({ provider: "anthropic", is_fallback: true });
  });

  it("persists model-route recovery notices without marking primary replies as fallback", async () => {
    const events = [
      {
        type: "model_route_start",
        strategy: "ordered_fallback",
        candidateCount: 2,
        activeCandidateKey: "anthropic/claude",
        primaryCandidateKey: "openai/gpt-4",
        primaryProvider: "openai",
        primaryModelId: "gpt-4",
      },
      {
        type: "model_route_success",
        attempt: 1,
        candidateKey: "openai/gpt-4",
        provider: "openai",
        modelId: "gpt-4",
        isFallback: false,
        primaryCandidateKey: "openai/gpt-4",
        recoveredFromCandidateKey: "anthropic/claude",
        recoveredFromProvider: "anthropic",
        recoveredFromModelId: "claude",
      },
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "primary ok" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "primary ok" }] } },
    ];

    await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true });

    const noticeRow = appendCalls.find((r) => r.metadata?.event_type === "model_route.recovered");
    expect(noticeRow).toBeDefined();
    expect(noticeRow.content).toContain("Recovered to primary model openai/gpt-4");

    const assistantRow = appendCalls.find((r) => r.role === "assistant" && r.content === "primary ok");
    expect(assistantRow.metadata.model_route).toMatchObject({
      provider: "openai",
      model_id: "gpt-4",
      is_fallback: false,
      recovered_from_provider: "anthropic",
    });
  });

  it("annotates routed tool-only turns with model-route metadata", async () => {
    const events = [
      {
        type: "model_route_start",
        strategy: "ordered_fallback",
        candidateCount: 2,
        primaryCandidateKey: "openai/gpt-4",
        primaryProvider: "openai",
        primaryModelId: "gpt-4",
      },
      {
        type: "model_route_switch",
        attempt: 1,
        fromCandidateKey: "openai/gpt-4",
        fromProvider: "openai",
        fromModelId: "gpt-4",
        toCandidateKey: "anthropic/claude",
        toProvider: "anthropic",
        toModelId: "claude",
        failureKind: "rate_limit",
        errorMessage: "429 too many requests",
        cooldownUntil: 123456,
      },
      {
        type: "model_route_success",
        attempt: 2,
        candidateKey: "anthropic/claude",
        provider: "anthropic",
        modelId: "claude",
        isFallback: true,
        primaryCandidateKey: "openai/gpt-4",
      },
      { type: "tool_execution_start", toolName: "kubectl", args: { cmd: "get pods" } },
      {
        type: "tool_execution_end",
        toolName: "kubectl",
        result: { content: [{ type: "text", text: "pod-a Running" }] },
      },
    ];

    await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true });

    const toolStartRow = appendCalls.find((r) => r.role === "tool" && r.toolName === "kubectl");
    expect(toolStartRow.metadata.model_route).toMatchObject({
      provider: "anthropic",
      model_id: "claude",
      is_fallback: true,
      switched_from_provider: "openai",
      failure_kind: "rate_limit",
    });
    expect(updateCalls[0].metadata.model_route).toMatchObject({
      provider: "anthropic",
      model_id: "claude",
      is_fallback: true,
      switched_from_provider: "openai",
      failure_kind: "rate_limit",
    });
  });
});

// ── Tool calls ──────────────────────────────────────────

describe("consumeAgentSse — tool execution", () => {
  it("records tool_execution_end with toolInput/toolName/outcome when persistMessages=true", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "kubectl", args: { cmd: "get pods" } },
      { type: "tool_execution_end", toolName: "kubectl",
        result: { content: [{ type: "text", text: "pod-a  Running" }] } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    const toolRow = updateCalls[0];
    expect(toolRow).toBeDefined();
    expect(toolRow.messageId).toBe("msg-1");
    expect(toolRow.toolName).toBe("kubectl");
    expect(toolRow.toolInput).toContain("get pods");
    expect(toolRow.content).toContain("pod-a");
    expect(toolRow.outcome).toBe("success");
    expect(typeof toolRow.durationMs).toBe("number");
  });

  it("persists a running placeholder on tool_execution_start", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "delegate_to_agent", args: { agent_id: "self", scope: "check pods" } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    const toolRow = appendCalls.find((r) => r.role === "tool");
    expect(toolRow).toMatchObject({
      sessionId: "s",
      role: "tool",
      content: "",
      toolName: "delegate_to_agent",
      outcome: null,
      durationMs: null,
    });
    expect(toolRow.toolInput).toContain("check pods");
    expect(toolRow.metadata.status).toBe("running");
    expect(updateCalls).toHaveLength(0);
  });

  it("marks outcome=blocked when details.blocked is true", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "dangerous", args: {} },
      { type: "tool_execution_end", toolName: "dangerous",
        result: { content: [{ type: "text", text: "blocked" }], details: { blocked: true } } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    expect(updateCalls[0].outcome).toBe("blocked");
  });

  it("marks outcome=error when details.error is true", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "t", args: {} },
      { type: "tool_execution_end", toolName: "t",
        result: { content: [{ type: "text", text: "oops" }], details: { error: true } } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    expect(updateCalls[0].outcome).toBe("error");
  });

  it("persists tool details as metadata (dropping blocked/error flags that are surfaced via outcome)", async () => {
    // Tools can attach a rich `details` object to their result; the UI
    // consumes it on history reload. Verify the structured payload survives
    // the sse-consumer → appendMessage boundary intact.
    const findings = [
      { id: "F1", label: "Missing secret", severity: "high" },
      { id: "F2", label: "DNS failure", severity: "low" },
    ];
    const events = [
      { type: "tool_execution_start", toolName: "bash", args: { command: "kubectl get pods" } },
      { type: "tool_execution_end", toolName: "bash",
        result: {
          content: [{ type: "text", text: "## Summary\n..." }],
          details: {
            summary: "concluding",
            totalChecks: 2,
            passedChecks: 1,
            findings,
          },
        } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    const toolRow = updateCalls[0];
    expect(toolRow.metadata).toBeDefined();
    expect(toolRow.metadata.findings).toEqual(findings);
    expect(toolRow.metadata.totalChecks).toBe(2);
    expect(toolRow.metadata.summary).toBe("concluding");
  });

  it("drops blocked/error from metadata (already captured by outcome) but keeps timing fields", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", args: {} },
      { type: "tool_execution_end", toolName: "bash",
        result: { content: [{ type: "text", text: "fail" }], details: { error: true } } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    const toolRow = updateCalls[0];
    // blocked/error stripped; pre_thinking_ms is the lone surviving field
    // (always persisted to support 💭 audit on every tool).
    expect(toolRow.metadata).toEqual({ pre_thinking_ms: expect.any(Number) });
    expect(toolRow.metadata.error).toBeUndefined();
  });

  it("metadata contains only pre_thinking_ms when details is absent", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "kubectl", args: {} },
      { type: "tool_execution_end", toolName: "kubectl", result: { content: [{ type: "text", text: "ok" }] } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    const toolRow = updateCalls[0];
    expect(toolRow.metadata).toEqual({ pre_thinking_ms: expect.any(Number) });
  });

  it("redacts secrets inside persisted metadata via JSON round-trip", async () => {
    const redactionConfig = { patterns: [/sk-[a-z0-9]+/g] };
    const events = [
      { type: "tool_execution_start", toolName: "bash", args: {} },
      { type: "tool_execution_end", toolName: "bash",
        result: {
          content: [{ type: "text", text: "ok" }],
          details: {
            evidence: [{ output: "saw token sk-abcdef in log" }],
          },
        } },
    ];
    await consumeAgentSse({
      client: mkClient(events),
      sessionId: "s", userId: "u",
      persistMessages: true,
      redactionConfig,
    });
    const toolRow = updateCalls[0];
    const evidence = (toolRow.metadata.evidence as Array<{ output: string }>)[0];
    expect(evidence.output).not.toContain("sk-abcdef");
    expect(evidence.output).toContain("[REDACTED]");
  });

  it("extracts task_report into taskReportText and prioritises it over resultText", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "task_report", args: { summary: "done" } },
      { type: "tool_execution_end", toolName: "task_report",
        result: { content: [{ type: "text", text: "Investigation complete." }] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "boilerplate" }] } },
    ];
    const result = await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u" });
    expect(result.taskReportText).toBe("Investigation complete.");
    expect(result.resultText).toBe("Investigation complete.");
  });

  it("supports parallel tool calls by keying pending state per toolName", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "a", args: { x: 1 } },
      { type: "tool_execution_start", toolName: "b", args: { y: 2 } },
      { type: "tool_execution_end", toolName: "a", result: { content: [{ type: "text", text: "A done" }] } },
      { type: "tool_execution_end", toolName: "b", result: { content: [{ type: "text", text: "B done" }] } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    const toolRows = updateCalls;
    expect(appendCalls.filter((r) => r.role === "tool")).toHaveLength(2);
    expect(toolRows).toHaveLength(2);
    const a = toolRows.find((r) => r.toolName === "a");
    const b = toolRows.find((r) => r.toolName === "b");
    expect(a.toolInput).toContain("\"x\":1");
    expect(b.toolInput).toContain("\"y\":2");
  });
});

describe("consumeAgentSse — abort finalization", () => {
  it("finalizes an in-flight tool row as stopped and persists partial assistant text on abort", async () => {
    const controller = new AbortController();
    const client = {
      async *streamEvents() {
        yield { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Let me run that" } };
        yield { type: "tool_execution_start", toolName: "node_exec", args: { command: "ib_write_bw -D 60" } };
        controller.abort(); // user clicks Stop while the tool is in flight
        yield { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "(never processed — loop breaks)" } };
      },
    } as unknown as AgentBoxClient;

    await consumeAgentSse({ client, sessionId: "s", userId: "u", persistMessages: true, signal: controller.signal });

    // The running tool row (msg-1) is finalized as stopped — outcome stays null, metadata.status="stopped"
    // (mirrors a background job's stopped representation) so the UI shows ⊘ instead of a forever-spinner.
    const stopped = updateCalls.find((u) => u.metadata?.status === "stopped");
    expect(stopped).toBeDefined();
    expect(stopped.messageId).toBe("msg-1");
    expect(stopped.outcome).toBeNull();
    // updateMessage REPLACES columns, so finalize must re-send toolName/toolInput or the stopped
    // card would render blank (no tool identity / no command) after a refetch.
    expect(stopped.toolName).toBe("node_exec");
    expect(stopped.toolInput).toContain("ib_write_bw -D 60");
    // The partial assistant text the model already streamed is persisted so it doesn't vanish on refetch.
    const partial = appendCalls.find((a) => a.role === "assistant");
    expect(partial).toBeDefined();
    expect(partial.content).toContain("Let me run that");
    expect(partial.metadata?.incomplete).toBe(true);
  });

  it("does NOT finalize tool rows on a normal (non-abort) stream end", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "node_exec", args: { command: "x" } },
      // stream ends without a tool_execution_end, but the turn was NOT aborted
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    expect(updateCalls.find((u) => u.metadata?.status === "stopped")).toBeUndefined();
  });
});

// ── Timing (TTFT / 💭 / ⚙️ / turn total) ──────────────

describe("consumeAgentSse — timing", () => {
  it("attributes pre-tool thinking only to the first tool of a one-thinking-many-tools batch", async () => {
    // Simulate: model thinks, emits assistant message with text + 3 tool_use
    // blocks. The runtime executes them serially. Only the FIRST tool should
    // see meaningful pre_thinking_ms; the next two should be ~0 because the
    // boundary advances on each tool_execution_end (no new model thinking
    // happened between them).
    const events = [
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "checking pods" } },
      { type: "tool_execution_start", toolName: "bash", args: { command: "kubectl get pods -A" } },
      { type: "tool_execution_end", toolName: "bash",
        result: { content: [{ type: "text", text: "pod1" }] } },
      { type: "tool_execution_start", toolName: "bash", args: { command: "kubectl get pods -n a" } },
      { type: "tool_execution_end", toolName: "bash",
        result: { content: [{ type: "text", text: "pod2" }] } },
      { type: "tool_execution_start", toolName: "bash", args: { command: "kubectl get pods -n b" } },
      { type: "tool_execution_end", toolName: "bash",
        result: { content: [{ type: "text", text: "pod3" }] } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    expect(updateCalls).toHaveLength(3);
    // Every tool row carries pre_thinking_ms — the badge is auditable on all of them.
    for (const row of updateCalls) {
      expect(row.metadata.pre_thinking_ms).toEqual(expect.any(Number));
      expect(row.metadata.pre_thinking_ms).toBeGreaterThanOrEqual(0);
    }
    // Crucially, no double-counting: tools 2 and 3 should be near-zero
    // because the boundary advanced on the previous tool_execution_end.
    expect(updateCalls[1].metadata.pre_thinking_ms).toBeLessThan(50);
    expect(updateCalls[2].metadata.pre_thinking_ms).toBeLessThan(50);
  });

  it("persists ttft_ms / output_ms / turn_total_ms on the first assistant message; thinking_ms suppressed because it equals ttft", async () => {
    const events = [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    const assistantRow = appendCalls.find((c) => c.role === "assistant");
    expect(assistantRow).toBeDefined();
    expect(assistantRow.metadata.timing.ttft_ms).toEqual(expect.any(Number));
    // thinking_ms intentionally absent on first message: ttft already covers
    // the same boundary→firstToken interval, so a naive sum would otherwise
    // double-count it.
    expect(assistantRow.metadata.timing.thinking_ms).toBeUndefined();
    expect(assistantRow.metadata.timing.output_ms).toEqual(expect.any(Number));
    expect(assistantRow.metadata.timing.turn_total_ms).toEqual(expect.any(Number));
  });

  it("uses caller-supplied turnStartTime when provided (portal POST anchor)", async () => {
    const earlyAnchor = Date.now() - 5000; // simulate portal stamp 5s ago
    const events = [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    ];
    await consumeAgentSse({
      client: mkClient(events), sessionId: "s", userId: "u",
      persistMessages: true, turnStartTime: earlyAnchor,
    });
    const assistantRow = appendCalls.find((c) => c.role === "assistant");
    // ttft must reflect the supplied anchor — at least the simulated 5s gap.
    expect(assistantRow.metadata.timing.ttft_ms).toBeGreaterThanOrEqual(5000);
  });

  it("emits ttft_ms only on the first assistant message of a turn (avoids double-counting)", async () => {
    const events = [
      // First assistant message
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
      // Second assistant message in same turn — same turnStart anchor, but
      // ttft would just repeat the same value, so it must be omitted.
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "more" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "more" }] } },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    const assistantRows = appendCalls.filter((c) => c.role === "assistant");
    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0].metadata.timing.ttft_ms).toEqual(expect.any(Number));
    expect(assistantRows[1].metadata.timing.ttft_ms).toBeUndefined();
    // Both messages still carry thinking_ms + output_ms (their per-message
    // intervals are independent and additive).
    expect(assistantRows[1].metadata.timing.thinking_ms).toEqual(expect.any(Number));
    expect(assistantRows[1].metadata.timing.output_ms).toEqual(expect.any(Number));
  });

  it("surfaces preThinkingMs and durationMs onto live events for frontend rendering", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "kubectl", args: {} },
      { type: "tool_execution_end", toolName: "kubectl", result: { content: [{ type: "text", text: "ok" }] } },
    ];
    const seen: any[] = [];
    await consumeAgentSse({
      client: mkClient(events), sessionId: "s", userId: "u",
      persistMessages: true,
      onEvent: (evt) => seen.push(evt),
    });
    const startEvt = seen.find((e) => e.type === "tool_execution_start");
    const endEvt = seen.find((e) => e.type === "tool_execution_end");
    expect(typeof startEvt.preThinkingMs).toBe("number");
    expect(typeof endEvt.preThinkingMs).toBe("number");
    expect(typeof endEvt.durationMs).toBe("number");
  });
});

// ── Redaction + abort ──────────────────────────────────

describe("consumeAgentSse — redaction and abort", () => {
  it("redacts secrets from persisted content and the returned resultText", async () => {
    const redactionConfig = { patterns: [/sk-[a-z0-9]+/g] };
    const events = [
      { type: "tool_execution_start", toolName: "t", args: { key: "sk-abcdef" } },
      { type: "tool_execution_end", toolName: "t",
        result: { content: [{ type: "text", text: "leaked: sk-abcdef" }] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "api=sk-abcdef" }] } },
    ];
    const result = await consumeAgentSse({
      client: mkClient(events),
      sessionId: "s", userId: "u",
      persistMessages: true,
      redactionConfig,
    });
    // Returned text redacted
    expect(result.resultText).not.toContain("sk-abcdef");
    // Persisted tool row redacted
    const toolRow = updateCalls[0];
    expect(toolRow.content).not.toContain("sk-abcdef");
    expect(toolRow.toolInput).not.toContain("sk-abcdef");
  });

  it("exits the loop when the abort signal fires before next event", async () => {
    // The for-await checks `signal.aborted` after receiving each event.
    // Pre-aborted signal stops processing immediately.
    const ctrl = new AbortController();
    ctrl.abort();
    const events = [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "never seen" }] } },
    ];
    const result = await consumeAgentSse({
      client: mkClient(events),
      sessionId: "s", userId: "u",
      signal: ctrl.signal,
    });
    expect(result.resultText).toBe("");
  });
});

// ── onEvent callback ───────────────────────────────────

describe("consumeAgentSse — onEvent callback", () => {
  it("invokes onEvent for each event with the dbMessageId when one was inserted", async () => {
    const seen: Array<{ type: string; dbMessageId: string | undefined }> = [];
    const events = [
      { type: "tool_execution_start", toolName: "t", args: {} },
      { type: "tool_execution_end", toolName: "t",
        result: { content: [{ type: "text", text: "x" }] } },
    ];
    await consumeAgentSse({
      client: mkClient(events),
      sessionId: "s", userId: "u",
      persistMessages: true,
      onEvent: (evt, _type, extras) => seen.push({ type: (evt as any).type, dbMessageId: extras.dbMessageId }),
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].dbMessageId).toBeDefined();
    expect(seen[1].dbMessageId).toBe(seen[0].dbMessageId);
  });
});
