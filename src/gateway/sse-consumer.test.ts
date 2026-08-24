import { describe, it, expect, beforeEach, vi } from "vitest";
import { consumeAgentSse } from "./sse-consumer.js";
import { AgentBoxClient } from "./agentbox/client.js";

// ── Mock chat-repo ──────────────────────────────────────
// Replace the module-scoped appendMessage/incrementMessageCount so tests run
// without initializing the FrontendWsClient-backed chat-repo.

const appendCalls: any[] = [];
const updateCalls: any[] = [];
let appendCounter = 0;
/** Make the NEXT updateMessage throw — exercises the peek-then-shift contract. */
let updateShouldThrowOnce = false;

vi.mock("./chat-repo.js", () => ({
  appendMessage: vi.fn(async (msg: any) => {
    appendCalls.push(msg);
    return `msg-${++appendCounter}`;
  }),
  updateMessage: vi.fn(async (msg: any) => {
    if (updateShouldThrowOnce) {
      updateShouldThrowOnce = false;
      throw new Error("update failed");
    }
    updateCalls.push(msg);
  }),
  incrementMessageCount: vi.fn(async () => {}),
  ensureChatSession: vi.fn(async () => {}),
  initChatRepo: vi.fn(),
}));

// ── Fake AgentBoxClient that yields scripted events ─────

class FakeAgentBoxClient {
  events: unknown[] = [];
  /** Called just before each event is handed to the consumer — lets a test see what
   *  had already been written to the DB at that point in the stream. */
  onBeforeEvent?: (event: unknown) => void;
  async *streamEvents(_sessionId: string): AsyncIterable<unknown> {
    for (const e of this.events) { this.onBeforeEvent?.(e); yield e; }
  }
}

function mkClient(events: unknown[], onBeforeEvent?: (event: unknown) => void): AgentBoxClient {
  const c = new FakeAgentBoxClient();
  c.events = events;
  c.onBeforeEvent = onBeforeEvent;
  return c as unknown as AgentBoxClient;
}

/** A client that yields events and then THROWS — the transport-fault exit path. */
function mkThrowingClient(events: unknown[], err: Error): AgentBoxClient {
  return {
    async *streamEvents(_sessionId: string) {
      for (const e of events) yield e;
      throw err;
    },
  } as unknown as AgentBoxClient;
}

beforeEach(() => {
  appendCalls.length = 0;
  updateCalls.length = 0;
  appendCounter = 0;
  updateShouldThrowOnce = false;
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
  it("appends registered knowledge sources to the final answer event and result", async () => {
    const events = [
      { type: "knowledge_sources", sources: [{ title: "GPU Runbook", url: "https://docs.feishu.cn/wiki/a" }] },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "结论" }] } },
    ];
    const seen: any[] = [];
    const result = await consumeAgentSse({
      client: mkClient(events), sessionId: "s", userId: "u", onEvent: (event) => seen.push(event),
    });
    expect(result.resultText).toContain("### 参考原文");
    expect(result.resultText).toContain("https://docs.feishu.cn/wiki/a");
    expect((seen[1].message.content[0].text as string)).toBe(result.resultText);
  });

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

  it("stamps opts.traceId onto every persisted row (message-level trace filtering)", async () => {
    const events = [
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } },
    ];
    await consumeAgentSse({
      client: mkClient(events),
      sessionId: "sid",
      userId: "u",
      persistMessages: true,
      traceId: "0123456789abcdef0123456789abcdef",
    });
    const assistantRow = appendCalls.find((r) => r.role === "assistant");
    expect(assistantRow.traceId).toBe("0123456789abcdef0123456789abcdef");
  });

  it("merges the agent_end context-usage snapshot onto the last assistant row's metadata", async () => {
    // Lets the frontend restore the context meter on session reopen/refresh.
    const cu = { tokens: 24144, contextWindow: 100000, percent: 24.1, inputTokens: 24118, outputTokens: 26 };
    const events = [
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } },
      { type: "agent_end", contextUsage: cu },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true });
    const upd = updateCalls.find((u) => u.metadata?.context_usage);
    expect(upd).toBeDefined();
    expect(upd.metadata.context_usage).toEqual(cu);
    expect(upd.messageId).toBe("msg-1"); // the assistant row's id
    expect(upd.content).toBe("Hi"); // original content re-sent (handler does content ?? "" → must not wipe)
  });

  it("does not update on agent_end when no contextUsage is present", async () => {
    const events = [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } },
      { type: "agent_end" },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true });
    expect(updateCalls.find((u) => u.metadata?.context_usage)).toBeUndefined();
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

// ── Routed-turn commit gating (deferred persistence) ────

describe("consumeAgentSse — routed turn commit gating", () => {
  it("defers the primary candidate's assistant row until model_route_success commits it", async () => {
    const events = [
      { type: "model_route_start", candidateCount: 2 },
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" } },
      { type: "model_route_success", attempt: 1, candidateKey: "openai/gpt-4", provider: "openai", modelId: "gpt-4", isFallback: false, primaryCandidateKey: "openai/gpt-4" },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true });
    expect(appendCalls.filter((r) => r.role === "assistant" && r.content === "hello")).toHaveLength(1);
  });

  it("does NOT defer when the turn has a single candidate, so replies keep their place in the conversation", async () => {
    // Every prompt runs through the routing entry now, so a turn with nothing to fall
    // back to emits these events too. Deferring there buys nothing — a rollback is only
    // ever emitted before a switch — and it costs ORDER. Steers are written by the RPC
    // handler the moment they arrive; if the replies all wait for the commit point, the
    // conversation reloads as every question followed by every answer, instead of the
    // alternation the user watched. Measured in a cluster: 14 assistant rows in 26ms.
    const events = [
      { type: "model_route_start", candidateCount: 1 },
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "spoken" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "spoken" }], stopReason: "stop" } },
      { type: "model_route_success", attempt: 1, candidateKey: "openai/gpt-4", provider: "openai", modelId: "gpt-4", isFallback: false, primaryCandidateKey: "openai/gpt-4" },
    ];
    let writtenBeforeCommit = 0;
    await consumeAgentSse({
      client: mkClient(events, (e) => {
        if ((e as { type: string }).type === "model_route_success") {
          writtenBeforeCommit = appendCalls.filter((r) => r.role === "assistant").length;
        }
      }),
      sessionId: "sid", userId: "u", persistMessages: true,
    });
    expect(writtenBeforeCommit).toBe(1); // written while the turn was still running
  });

  it("still defers when a fallback candidate exists, since that reply may yet be rolled back", async () => {
    const events = [
      { type: "model_route_start", candidateCount: 2 },
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "maybe" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "maybe" }], stopReason: "stop" } },
      { type: "model_route_success", attempt: 1, candidateKey: "openai/gpt-4", provider: "openai", modelId: "gpt-4", isFallback: false, primaryCandidateKey: "openai/gpt-4" },
    ];
    let writtenBeforeCommit = 0;
    await consumeAgentSse({
      client: mkClient(events, (e) => {
        if ((e as { type: string }).type === "model_route_success") {
          writtenBeforeCommit = appendCalls.filter((r) => r.role === "assistant").length;
        }
      }),
      sessionId: "sid", userId: "u", persistMessages: true,
    });
    expect(writtenBeforeCommit).toBe(0);
    expect(appendCalls.filter((r) => r.role === "assistant" && r.content === "maybe")).toHaveLength(1);
  });

  it("folds the context-usage snapshot into the deferred assistant row (agent_end precedes commit)", async () => {
    // Real ordering: agent_end fires BEFORE model_route_success, and the assistant
    // persist is deferred to the commit — so the snapshot must ride the append, not
    // a post-hoc updateMessage (the row doesn't exist yet at agent_end).
    const cu = { tokens: 24252, contextWindow: 100000, percent: 24.25, inputTokens: 24230, outputTokens: 22 };
    const events = [
      { type: "model_route_start", candidateCount: 2 },
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" } },
      { type: "agent_end", contextUsage: cu },
      { type: "model_route_success", attempt: 1, candidateKey: "openai/gpt-4", provider: "openai", modelId: "gpt-4", isFallback: false, primaryCandidateKey: "openai/gpt-4" },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true });
    const row = appendCalls.find((r) => r.role === "assistant" && r.content === "hi");
    expect(row).toBeDefined();
    expect(row.metadata.context_usage).toEqual(cu);
    // No post-hoc patch needed on the routed path.
    expect(updateCalls.find((u) => u.metadata?.context_usage)).toBeUndefined();
  });

  it("discards a failed primary's partial reply and error on rollback, persisting only the fallback's answer", async () => {
    const events = [
      { type: "model_route_start", candidateCount: 2 },
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "half from primary" } },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit" } },
      { type: "model_route_rollback", attempt: 1, candidateKey: "openai/gpt-4", failureKind: "rate_limit" },
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer from fallback" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer from fallback" }], stopReason: "stop" } },
      { type: "model_route_success", attempt: 2, candidateKey: "anthropic/claude", provider: "anthropic", modelId: "claude", isFallback: true, primaryCandidateKey: "openai/gpt-4" },
    ];
    const result = await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true });
    // The failed primary's partial text and its error row are both dropped.
    expect(appendCalls.some((r) => r.content === "half from primary")).toBe(false);
    expect(appendCalls.filter((r) => r.metadata?.kind === "error_response")).toHaveLength(0);
    // Only the winning fallback's answer is persisted.
    expect(appendCalls.some((r) => r.role === "assistant" && r.content === "answer from fallback")).toBe(true);
    // The run summary must not leak the rolled-back attempt's error.
    expect(result.errorMessage).toBe("");
  });

  it("discards a failed primary's knowledge sources before rendering the fallback answer", async () => {
    const events = [
      { type: "model_route_start", candidateCount: 2 },
      { type: "knowledge_sources", sources: [{ title: "Primary Runbook", url: "https://example.com/primary" }] },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit" } },
      { type: "model_route_rollback", attempt: 1, candidateKey: "openai/gpt-4", failureKind: "rate_limit" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer from fallback" }], stopReason: "stop" } },
      { type: "model_route_success", attempt: 2, candidateKey: "anthropic/claude", provider: "anthropic", modelId: "claude", isFallback: true, primaryCandidateKey: "openai/gpt-4" },
    ];
    const result = await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u" });
    expect(result.resultText).toBe("answer from fallback");
    expect(result.resultText).not.toContain("Primary Runbook");
  });

  it("persists the error row when a routed turn is exhausted (no fallback succeeded)", async () => {
    const events = [
      { type: "model_route_start", candidateCount: 2 },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "all candidates failed" } },
      { type: "model_route_exhausted", attempt: 1, failureKind: "rate_limit", errorMessage: "all candidates failed" },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true });
    const errorRows = appendCalls.filter((r) => r.metadata?.kind === "error_response");
    expect(errorRows).toHaveLength(1);
    expect(errorRows[0].content).toContain("all candidates failed");
  });

  it("surfaces only the final error of a both-failed turn, not the rolled-back one", async () => {
    const streamErrors: string[] = [];
    const events = [
      { type: "model_route_start", candidateCount: 2 },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "primary 429" } },
      { type: "model_route_rollback", attempt: 1, candidateKey: "openai/gpt-4", failureKind: "rate_limit" },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "fallback 503" } },
      { type: "model_route_exhausted", attempt: 2, failureKind: "server_error", errorMessage: "fallback 503" },
    ];
    await consumeAgentSse({
      client: mkClient(events),
      sessionId: "sid",
      userId: "u",
      persistMessages: true,
      onEvent: (evt, type) => {
        if (type === "stream_error") streamErrors.push(String((evt as any).error?.message))
      },
    });
    // One bubble, carrying the failure that actually ended the turn. The
    // primary's 429 belongs to a candidate that was rolled back — emitting it
    // and relying on the frontend to drop it again put the burden in the wrong
    // place, and the same eagerness is what showed operators a transport
    // timeout instead of the provider's "unsupported_protocol" verdict.
    expect(streamErrors).toEqual(["fallback 503"]);
    // Still exactly one persisted error row — the final, exhausted failure.
    const errorRows = appendCalls.filter((r) => r.metadata?.kind === "error_response");
    expect(errorRows).toHaveLength(1);
    expect(errorRows[0].content).toContain("fallback 503");
  });

  // The reported case: claude-sonnet-5 on an OpenAI-protocol gateway. pi-agent's
  // first attempt gave up on the transport ("Request timed out."), the retry
  // came back with the gateway's actual verdict, and the operator was shown the
  // timeout — sending them to look at the network instead of at the protocol
  // dropdown that was the whole problem.
  it("shows the last error of an internal retry chain, not the first", async () => {
    const streamErrors: string[] = [];
    const events = [
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Request timed out." } },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: '400: {"code":"unsupported_protocol"}' } },
    ];
    await consumeAgentSse({
      client: mkClient(events),
      sessionId: "sid",
      userId: "u",
      persistMessages: true,
      onEvent: (evt, type) => {
        if (type === "stream_error") streamErrors.push(String((evt as any).error?.message));
      },
    });
    expect(streamErrors).toEqual(['400: {"code":"unsupported_protocol"}']);
    // The reload must agree with the bubble the operator was just looking at.
    const errorRows = appendCalls.filter((r) => r.metadata?.kind === "error_response");
    expect(errorRows).toHaveLength(1);
    expect(errorRows[0].content).toContain("unsupported_protocol");
  });

  it("still surfaces and persists the error when the stream dies mid-turn", async () => {
    // The buffered error is the operator's only explanation of the failure. A
    // pod recycle or dropped transport must not take it with it — before the
    // buffering this row was written on sight, so losing it would be a straight
    // regression for exactly the reload the buffering promises to fix.
    const streamErrors: string[] = [];
    const client = {
      async *streamEvents() {
        yield { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "400 unsupported_protocol" } };
        throw new Error("socket hang up");
      },
    } as unknown as AgentBoxClient;

    await expect(consumeAgentSse({
      client,
      sessionId: "sid",
      userId: "u",
      persistMessages: true,
      onEvent: (evt, type) => {
        if (type === "stream_error") streamErrors.push(String((evt as any).error?.message));
      },
    })).rejects.toThrow("socket hang up");

    expect(streamErrors).toEqual(["400 unsupported_protocol"]);
    expect(appendCalls.filter((r) => r.metadata?.kind === "error_response")).toHaveLength(1);
  });

  // A non-error stopReason is not the same as a recovered turn: pi surfaces an
  // empty 200 as `stop` with zero content blocks — the case its own retry loop
  // exists for — and a Stop as `aborted`. Clearing on those would erase the
  // provider's verdict and report the turn as a success, which delegation and
  // cron both read as ok with empty text.
  it.each([
    ["an empty 200", { role: "assistant", content: [], stopReason: "stop" }],
    ["an aborted turn", { role: "assistant", content: [], stopReason: "aborted" }],
  ])("does not treat %s as recovery", async (_label, second) => {
    const streamErrors: string[] = [];
    const events = [
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider verdict" } },
      { type: "message_end", message: second },
    ];
    const result = await consumeAgentSse({
      client: mkClient(events),
      sessionId: "sid",
      userId: "u",
      persistMessages: true,
      onEvent: (evt, type) => {
        if (type === "stream_error") streamErrors.push(String((evt as any).error?.message));
      },
    });
    expect(streamErrors).toEqual(["provider verdict"]);
    expect(result.errorMessage).toBe("provider verdict");
    expect(appendCalls.filter((r) => r.metadata?.kind === "error_response")).toHaveLength(1);
  });

  // Reported from production: three steers in one request, the first two failing
  // and the third succeeding. Every failure was suppressed, because the
  // "an internal retry recovered it" rule was scoped to the whole REQUEST rather
  // than to a turn. The live page drew red boxes the frontend had made itself;
  // a reload read the database and found questions with no answers.
  it("keeps each steered turn's error, and only suppresses within a turn", async () => {
    const streamErrors: string[] = [];
    const userMsg = (text: string) => ({
      type: "message_start", message: { role: "user", content: [{ type: "text", text }] },
    });
    const failed = (why: string) => ({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: why },
    });
    const answered = (text: string) => ({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
    });

    const result = await consumeAgentSse({
      client: mkClient([
        userMsg("1"), failed("boom 1"),
        userMsg("2"), failed("boom 2"),
        // Third turn retries internally: that failure IS recovered, in-turn, and
        // must still leave nothing behind.
        userMsg("3"), failed("transient"), answered("hello"),
      ]),
      sessionId: "sid",
      userId: "u",
      persistMessages: true,
      onEvent: (evt, type) => {
        if (type === "stream_error") streamErrors.push(String((evt as any).error?.message));
      },
    });

    expect(streamErrors).toEqual(["boom 1", "boom 2"]);
    const errorRows = appendCalls.filter((r) => r.metadata?.kind === "error_response");
    expect(errorRows.map((r) => r.content)).toEqual(["boom 1", "boom 2"]);
    // The run as a whole produced an answer, so the caller is not told it failed.
    expect(result.errorMessage).toBe("");
    expect(result.resultText).toBe("hello");
  });

  it("leaves nothing behind when a retry recovers the turn", async () => {
    // Previously a transient failure left a red bubble sitting above the answer
    // that followed it, and an error row that outlived the reload.
    const streamErrors: string[] = [];
    const events = [
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Request timed out." } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" } },
    ];
    const result = await consumeAgentSse({
      client: mkClient(events),
      sessionId: "sid",
      userId: "u",
      persistMessages: true,
      onEvent: (evt, type) => {
        if (type === "stream_error") streamErrors.push(String((evt as any).error?.message));
      },
    });
    expect(streamErrors).toEqual([]);
    expect(appendCalls.filter((r) => r.metadata?.kind === "error_response")).toHaveLength(0);
    // And the recovered turn must not report itself as failed to callers that
    // quote errorMessage (cron notifications, channel replies).
    expect(result.errorMessage).toBe("");
    expect(result.resultText).toBe("hello");
  });

  it("does not leak a rolled-back attempt's error into the run summary on a transport drop", async () => {
    const events = [
      { type: "model_route_start", candidateCount: 2 },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "primary 429" } },
      { type: "model_route_rollback", attempt: 1, candidateKey: "openai/gpt-4", failureKind: "rate_limit" },
      // stream ends here without a fallback outcome (transport drop)
    ];
    const result = await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true });
    expect(result.errorMessage).toBe("");
    expect(appendCalls.filter((r) => r.metadata?.kind === "error_response")).toHaveLength(0);
  });

  it("emits ttft_ms on only the first assistant row across two message_ends before commit", async () => {
    const events = [
      { type: "model_route_start", candidateCount: 2 },
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" } },
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "second" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second" }], stopReason: "stop" } },
      { type: "model_route_success", attempt: 1, candidateKey: "openai/gpt-4", provider: "openai", modelId: "gpt-4", isFallback: false, primaryCandidateKey: "openai/gpt-4" },
    ];
    // Anchor the turn start in the past so ttft is a positive, recorded value.
    await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true, turnStartTime: Date.now() - 5000 });
    const rows = appendCalls.filter((r) => r.role === "assistant" && (r.content === "first" || r.content === "second"));
    expect(rows).toHaveLength(2);
    const withTtft = rows.filter((r) => r.metadata?.timing?.ttft_ms !== undefined);
    expect(withTtft).toHaveLength(1);
    expect(withTtft[0].content).toBe("first");
  });

  it("keeps ttft_ms on the fallback reply when the primary streamed text then failed", async () => {
    // Regression: the primary's enqueued assistant op flips firstAssistantPersisted;
    // rollback discards that op, so without re-arming the flag the surviving
    // fallback reply (the turn's real first assistant) loses its ttft anchor.
    const events = [
      { type: "model_route_start", candidateCount: 2 },
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "primary text" } },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "primary 429" } },
      { type: "model_route_rollback", attempt: 1, candidateKey: "openai/gpt-4", failureKind: "rate_limit" },
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fallback answer" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fallback answer" }], stopReason: "stop" } },
      { type: "model_route_success", attempt: 2, candidateKey: "anthropic/claude", provider: "anthropic", modelId: "claude", isFallback: true, primaryCandidateKey: "openai/gpt-4" },
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "sid", userId: "u", persistMessages: true, turnStartTime: Date.now() - 5000 });
    const fallbackRow = appendCalls.find((r) => r.role === "assistant" && r.content === "fallback answer");
    expect(fallbackRow).toBeDefined();
    expect(fallbackRow.metadata?.timing?.ttft_ms).toBeDefined();
    // The rolled-back primary text never persists.
    expect(appendCalls.some((r) => r.content === "primary text")).toBe(false);
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
    // The stream ended without a tool_execution_end, so the terminal finalizer closes the row.
    // (It used to assert updateCalls was empty — that was the pre-fix behaviour, where the row
    // stayed `running` in the DB permanently.)
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].metadata.status).toBe("abandoned");
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

  it("supports parallel tool calls via the per-toolName FIFO fallback when events lack a toolCallId", async () => {
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

  it("pairs same-name parallel calls by toolCallId when ends arrive out of start order", async () => {
    // pi-agent executes a same-turn tool batch in parallel: all starts fire in
    // call order, each end fires on ITS OWN completion. Name-FIFO pairing wrote
    // the first-completed result into the first-STARTED row — the audit/live
    // card then showed one command with another call's output.
    const events = [
      { type: "tool_execution_start", toolCallId: "c1", toolName: "navix", args: { cmd: "nodes" } },
      { type: "tool_execution_start", toolCallId: "c2", toolName: "navix", args: { cmd: "workloads" } },
      { type: "tool_execution_start", toolCallId: "c3", toolName: "navix", args: { cmd: "diagnoses" } },
      // Completion order ≠ start order.
      { type: "tool_execution_end", toolCallId: "c3", toolName: "navix",
        result: { content: [{ type: "text", text: "diagnoses output" }] } },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "navix",
        result: { content: [{ type: "text", text: "nodes output" }] } },
      { type: "tool_execution_end", toolCallId: "c2", toolName: "navix",
        result: { content: [{ type: "text", text: "workloads output" }] } },
    ];
    const relayedEndRowIds: Array<string | undefined> = [];
    await consumeAgentSse({
      client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true,
      onEvent: (_evt, eventType, extra) => {
        if (eventType === "tool_execution_end") relayedEndRowIds.push(extra?.dbMessageId);
      },
    });
    // Placeholder rows were appended in start order: msg-1=c1, msg-2=c2, msg-3=c3.
    // Each result must land in its own row.
    expect(updateCalls).toHaveLength(3);
    const byRow = Object.fromEntries(updateCalls.map((u) => [u.messageId, u]));
    expect(byRow["msg-1"].toolInput).toContain("nodes");
    expect(byRow["msg-1"].content).toBe("nodes output");
    expect(byRow["msg-2"].toolInput).toContain("workloads");
    expect(byRow["msg-2"].content).toBe("workloads output");
    expect(byRow["msg-3"].toolInput).toContain("diagnoses");
    expect(byRow["msg-3"].content).toBe("diagnoses output");
    // The relayed live event must carry the row its result was written to, so the
    // frontend (which prefers dbMessageId) attaches it to the right card.
    expect(relayedEndRowIds).toEqual(["msg-3", "msg-1", "msg-2"]);
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

  // ⚠️ This test previously asserted the OPPOSITE — "does NOT finalize tool rows on a normal
  // (non-abort) stream end" — and it was a deliberate decision, not a gap. It is inverted here
  // because leaving the row `running` forever corrupts the audit record: production sampling found
  // a peer still executing in 58/58 such cases, so the work happened and only the record was lost.
  //
  // Note WHY the old assertion would still have passed: it looked for status === "stopped", and this
  // path writes "abandoned". A test kept as-is would have gone green for the wrong reason — which is
  // exactly the false-pass this suite must not accumulate.
  it("finalizes an unfinished tool row on a normal (non-abort) stream end, as abandoned", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "node_exec", args: { command: "x" } },
      // stream ends without a tool_execution_end, but the turn was NOT aborted
    ];
    await consumeAgentSse({ client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true });
    const finalized = updateCalls.find((u) => u.metadata?.status === "abandoned");
    expect(finalized).toBeDefined();
    // outcome stays NULL: "error" would be a false claim about work that most likely succeeded, and
    // would put these rows in the failure set that feeds the nightly analyzer.
    expect(finalized.outcome).toBeNull();
    expect(finalized.metadata.reason).toBe("stream_ended");
    expect(typeof finalized.metadata.duration_ms).toBe("number");
    // updateMessage REPLACES columns, so the row's identity must be re-sent or the card loses it.
    expect(finalized.toolName).toBe("node_exec");
    expect(finalized.toolInput).toContain("x");
    // "abandoned" is NOT "stopped": the second names a deliberate user act with a known actor.
    expect(updateCalls.find((u) => u.metadata?.status === "stopped")).toBeUndefined();
  });

  it("still marks a user Stop as stopped, not abandoned", async () => {
    const controller = new AbortController();
    // Abort mid-stream, not before: a pre-aborted signal stops the loop before the start event is
    // processed, so there would be no pending row to finalize at all.
    const client = {
      async *streamEvents() {
        yield { type: "tool_execution_start", toolName: "node_exec", args: { command: "x" } };
        controller.abort();
        yield { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "(unprocessed)" } };
      },
    } as unknown as AgentBoxClient;
    await consumeAgentSse({
      client, sessionId: "s", userId: "u", persistMessages: true, signal: controller.signal,
    });
    const finalized = updateCalls.find((u) => u.metadata?.status === "stopped");
    expect(finalized).toBeDefined();
    expect(finalized.metadata.reason).toBe("user_stop");
    expect(updateCalls.find((u) => u.metadata?.status === "abandoned")).toBeUndefined();
  });

  it("finalizes when the event loop THROWS — the finalizer is inside the finally", async () => {
    // The old block sat AFTER the try/finally, so an exception propagated straight past it and the
    // row was stranded. This is the one exit that cannot be covered by moving the condition alone.
    const client = mkThrowingClient(
      [{ type: "tool_execution_start", toolName: "node_exec", args: { command: "x" } }],
      new Error("transport blew up"),
    );
    await expect(consumeAgentSse({
      client, sessionId: "s", userId: "u", persistMessages: true,
    })).rejects.toThrow("transport blew up");
    const finalized = updateCalls.find((u) => u.metadata?.status === "abandoned");
    expect(finalized).toBeDefined();
    expect(finalized.metadata.reason).toBe("stream_error");
  });

  it("a failed tool_execution_end write leaves the row reachable by the finalizer", async () => {
    // tool_execution_end peeks and only shifts after the write succeeds. Shifting first meant a
    // throwing persist erased the entry, so the row stayed `running` and the finalizer could no
    // longer see it — the case that most needs finalizing was the one it could not reach.
    updateShouldThrowOnce = true;
    const events = [
      { type: "tool_execution_start", toolName: "node_exec", args: { command: "x" } },
      { type: "tool_execution_end", toolName: "node_exec", result: { content: [{ type: "text", text: "ok" }] } },
    ];
    await expect(consumeAgentSse({
      client: mkClient(events), sessionId: "s", userId: "u", persistMessages: true,
    })).rejects.toThrow("update failed");
    // The first update threw; the finalizer then wrote the row as abandoned rather than losing it.
    expect(updateCalls.find((u) => u.metadata?.status === "abandoned")).toBeDefined();
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
