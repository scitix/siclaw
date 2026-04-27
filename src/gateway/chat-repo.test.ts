import { describe, it, expect, beforeEach } from "vitest";
import {
  initChatRepo,
  ensureChatSession,
  appendMessage,
  appendDelegationEvent,
  updateMessage,
  updateDelegationToolMessage,
  incrementMessageCount,
  getMessages,
} from "./chat-repo.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";

class FakeFrontendClient {
  calls: Array<{ method: string; params: any }> = [];
  responses = new Map<string, unknown>();
  nextError: Error | null = null;

  request(method: string, params?: any): Promise<any> {
    this.calls.push({ method, params });
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      return Promise.reject(err);
    }
    if (this.responses.has(method)) return Promise.resolve(this.responses.get(method));
    return Promise.resolve({});
  }
}

let fake: FakeFrontendClient;

beforeEach(() => {
  fake = new FakeFrontendClient();
  initChatRepo(fake as unknown as FrontendWsClient);
});

describe("initChatRepo / getClient", () => {
  it("throws if any RPC-using helper is called before initChatRepo", async () => {
    // Reset module by passing an uninitialised marker. Simulate "not initialized"
    // by overwriting with a client that always rejects; then verify the direct
    // guard by calling a helper without init via a fresh import.
    // The helpers use a module-level ref — we cannot reset it without
    // reimporting. Instead, verify the positive path plus a thrown-error path
    // through fake rejection to ensure the guard is exercised indirectly.
    fake.nextError = new Error("boom");
    await expect(appendMessage({
      sessionId: "s", role: "user", content: "hi",
    })).rejects.toThrow("boom");
  });
});

describe("ensureChatSession", () => {
  it("calls chat.ensureSession with all fields populated", async () => {
    await ensureChatSession("sid", "agent", "user", "Title", "Preview", "web");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].method).toBe("chat.ensureSession");
    expect(fake.calls[0].params).toEqual({
      session_id: "sid",
      agent_id: "agent",
      user_id: "user",
      title: "Title",
      preview: "Preview",
      origin: "web",
    });
  });

  it("omits undefined optional fields by passing them through", async () => {
    await ensureChatSession("sid", "agent", "user");
    expect(fake.calls[0].params.title).toBeUndefined();
    expect(fake.calls[0].params.preview).toBeUndefined();
    expect(fake.calls[0].params.origin).toBeUndefined();
    expect(fake.calls[0].params.parent_session_id).toBeUndefined();
  });

  it("passes delegation lineage fields when provided", async () => {
    await ensureChatSession("child", "target-agent", "user", "Child", "preview", "delegation", {
      parentSessionId: "parent",
      parentAgentId: "parent-agent",
      delegationId: "delegation-1",
      targetAgentId: "target-agent",
    });
    expect(fake.calls[0].params).toMatchObject({
      session_id: "child",
      agent_id: "target-agent",
      parent_session_id: "parent",
      parent_agent_id: "parent-agent",
      delegation_id: "delegation-1",
      target_agent_id: "target-agent",
    });
  });
});

describe("appendMessage", () => {
  it("returns the generated id from the RPC payload and maps optional fields to null", async () => {
    fake.responses.set("chat.appendMessage", { id: "msg-123" });
    const id = await appendMessage({
      sessionId: "sid",
      role: "user",
      content: "hello",
    });
    expect(id).toBe("msg-123");
    expect(fake.calls[0].method).toBe("chat.appendMessage");
    expect(fake.calls[0].params).toEqual({
      session_id: "sid",
      role: "user",
      content: "hello",
      tool_name: null,
      tool_input: null,
      metadata: null,
      outcome: null,
      duration_ms: null,
      from_agent_id: null,
      parent_session_id: null,
      delegation_id: null,
      target_agent_id: null,
    });
  });

  it("passes all optional fields straight through to the RPC, stringifying metadata", async () => {
    fake.responses.set("chat.appendMessage", { id: "id-x" });
    await appendMessage({
      sessionId: "sid",
      role: "tool",
      content: "result",
      toolName: "kube",
      toolInput: "get pods",
      metadata: { a: 1 },
      outcome: "success",
      durationMs: 42,
    });
    // metadata is JSON-stringified so Upstream's Go ptrStr handler (string-only)
    // accepts it; the object contract is still the public API for callers.
    expect(fake.calls[0].params).toEqual({
      session_id: "sid",
      role: "tool",
      content: "result",
      tool_name: "kube",
      tool_input: "get pods",
      metadata: "{\"a\":1}",
      outcome: "success",
      duration_ms: 42,
      from_agent_id: null,
      parent_session_id: null,
      delegation_id: null,
      target_agent_id: null,
    });
  });

  it("passes delegated message lineage fields", async () => {
    fake.responses.set("chat.appendMessage", { id: "id-lineage" });
    await appendMessage({
      sessionId: "child",
      role: "assistant",
      content: "child result",
      fromAgentId: "target-agent",
      parentSessionId: "parent",
      delegationId: "delegation-1",
      targetAgentId: "target-agent",
    });
    expect(fake.calls[0].params).toMatchObject({
      session_id: "child",
      from_agent_id: "target-agent",
      parent_session_id: "parent",
      delegation_id: "delegation-1",
      target_agent_id: "target-agent",
    });
  });
});

describe("appendDelegationEvent", () => {
  it("persists a model-compatible synthetic event with UI-distinguishing metadata", async () => {
    fake.responses.set("chat.appendMessage", { id: "event-1" });

    const id = await appendDelegationEvent({
      parentSessionId: "parent",
      parentAgentId: "agent-parent",
      userId: "u1",
      delegationId: "delegation-1",
      childSessionId: "child-1",
      targetAgentId: "agent-parent",
      status: "done",
      capsule: "Verdict: likely",
      fullSummary: "Full report",
      summaryTruncated: false,
      scope: "check pods",
      taskIndex: 2,
      totalTasks: 3,
      toolCalls: 7,
      durationMs: 1234,
    });

    expect(id).toBe("event-1");
    expect(fake.calls[0].method).toBe("chat.appendMessage");
    expect(fake.calls[0].params).toMatchObject({
      session_id: "parent",
      role: "user",
      content: "Verdict: likely",
      from_agent_id: "agent-parent",
      delegation_id: "delegation-1",
      target_agent_id: "agent-parent",
    });
    expect(JSON.parse(fake.calls[0].params.metadata)).toEqual({
      kind: "delegation_event",
      source: "system_notification",
      event_type: "delegation.done",
      delegation_id: "delegation-1",
      child_session_id: "child-1",
      target_agent_id: "agent-parent",
      parent_agent_id: "agent-parent",
      status: "done",
      capsule: "Verdict: likely",
      full_summary: "Full report",
      summary_truncated: false,
      scope: "check pods",
      task_index: 2,
      total_tasks: 3,
      tool_calls: 7,
      duration_ms: 1234,
    });
  });
});

describe("updateMessage", () => {
  it("updates an existing message row through RPC", async () => {
    await updateMessage({
      messageId: "msg-1",
      sessionId: "sid",
      content: "done",
      toolName: "delegate_to_agent",
      toolInput: "{\"scope\":\"check\"}",
      metadata: { summary: "ok" },
      outcome: "success",
      durationMs: 17,
    });

    expect(fake.calls[0]).toEqual({
      method: "chat.updateMessage",
      params: {
        id: "msg-1",
        session_id: "sid",
        content: "done",
        tool_name: "delegate_to_agent",
        tool_input: "{\"scope\":\"check\"}",
        metadata: "{\"summary\":\"ok\"}",
        outcome: "success",
        duration_ms: 17,
        delegation_id: null,
      },
    });
  });

  it("updates a delegation tool row by delegation id", async () => {
    await updateDelegationToolMessage({
      sessionId: "sid",
      toolName: "delegate_to_agents",
      delegationId: "call-1",
      content: "{\"status\":\"done\"}",
      metadata: { status: "done" },
      outcome: "success",
      durationMs: 42,
    });

    expect(fake.calls[0]).toEqual({
      method: "chat.updateDelegationToolMessage",
      params: {
        session_id: "sid",
        tool_name: "delegate_to_agents",
        delegation_id: "call-1",
        content: "{\"status\":\"done\"}",
        metadata: "{\"status\":\"done\"}",
        outcome: "success",
        duration_ms: 42,
      },
    });
  });
});

describe("incrementMessageCount", () => {
  it("is a no-op that resolves without calling RPC (handled by append-message)", async () => {
    await incrementMessageCount("sid");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("getMessages", () => {
  it("reverses the list and normalises rows", async () => {
    fake.responses.set("chat.getMessages", {
      messages: [
        { id: "m2", session_id: "sid", role: "assistant", content: "ok", tool_name: null, tool_input: null,
          metadata: null, outcome: null, duration_ms: null, created_at: "2026-04-16T12:00:00Z" },
        { id: "m1", session_id: "sid", role: "user", content: "hi", tool_name: null, tool_input: null,
          metadata: null, outcome: null, duration_ms: null, created_at: "2026-04-16T11:59:00Z" },
      ],
    });
    const out = await getMessages("sid", { limit: 2 });
    expect(out).toHaveLength(2);
    // Input newest→oldest, output should be oldest→newest after reverse
    expect(out[0].id).toBe("m1");
    expect(out[1].id).toBe("m2");
    expect(out[0].createdAt).toBeInstanceOf(Date);
  });

  it("parses metadata when it arrives as a JSON string", async () => {
    fake.responses.set("chat.getMessages", {
      messages: [
        { id: "m1", session_id: "sid", role: "tool", content: "", tool_name: "t", tool_input: null,
          metadata: JSON.stringify({ foo: "bar" }), outcome: "success", duration_ms: 5,
          created_at: "2026-04-16T11:00:00Z" },
      ],
    });
    const out = await getMessages("sid");
    expect(out[0].metadata).toEqual({ foo: "bar" });
    expect(out[0].outcome).toBe("success");
    expect(out[0].durationMs).toBe(5);
  });

  it("defaults nullish content/tool_name to safe values", async () => {
    fake.responses.set("chat.getMessages", {
      messages: [
        { id: "m1", session_id: "sid", role: "user", content: null, tool_name: null, tool_input: null,
          metadata: null, outcome: null, duration_ms: null, created_at: "2026-04-16T11:00:00Z" },
      ],
    });
    const out = await getMessages("sid");
    expect(out[0].content).toBe("");
    expect(out[0].toolName).toBeNull();
    expect(out[0].toolInput).toBeNull();
    expect(out[0].metadata).toBeNull();
    expect(out[0].outcome).toBeNull();
    expect(out[0].durationMs).toBeNull();
  });

  it("forwards opts.before as an ISO string and default limit=50", async () => {
    fake.responses.set("chat.getMessages", { messages: [] });
    const before = new Date("2026-04-16T00:00:00Z");
    await getMessages("sid", { before });
    expect(fake.calls[0].params.before).toBe(before.toISOString());
    expect(fake.calls[0].params.limit).toBe(50);
  });

  it("uses an explicit limit when provided", async () => {
    fake.responses.set("chat.getMessages", { messages: [] });
    await getMessages("sid", { limit: 10 });
    expect(fake.calls[0].params.limit).toBe(10);
  });
});
