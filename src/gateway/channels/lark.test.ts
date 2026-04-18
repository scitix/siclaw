import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLarkHandler, handleLarkMessage, collectResponse } from "./lark.js";
import { sessionRegistry } from "../session-registry.js";

// ── Mocks ──────────────────────────────────────────────────────────

// Stub AgentBoxClient so tests don't open real HTTPS sockets.
const promptMock = vi.fn();
const streamEventsMock = vi.fn();

vi.mock("../agentbox/client.js", () => ({
  AgentBoxClient: class {
    prompt = promptMock;
    streamEvents = streamEventsMock;
  },
}));

// Stub channel-manager RPCs so we don't hit upstream-ws in unit tests.
const resolveBindingMock = vi.fn();
const handlePairingCodeMock = vi.fn();

vi.mock("../channel-manager.js", () => ({
  resolveBinding: (...args: unknown[]) => resolveBindingMock(...args),
  handlePairingCode: (...args: unknown[]) => handlePairingCodeMock(...args),
}));

// ── Existing behaviour: degraded boot when SDK missing (kept from old suite) ─

describe("createLarkHandler — fallback when SDK is missing", () => {
  it("start() resolves and does not throw when SDK import fails", async () => {
    const handler = createLarkHandler(
      { id: "c1", config: { app_id: "x", app_secret: "y" } },
      {} as any,
    );
    await expect(handler.start()).resolves.toBeUndefined();
    await expect(handler.stop()).resolves.toBeUndefined();
  });

  it("accepts channel.config as a JSON string", async () => {
    const handler = createLarkHandler(
      { id: "c2", config: JSON.stringify({ app_id: "a", app_secret: "b" }) },
      {} as any,
    );
    await expect(handler.start()).resolves.toBeUndefined();
    await expect(handler.stop()).resolves.toBeUndefined();
  });
});

// ── handleLarkMessage ─────────────────────────────────────────────

/**
 * `@larksuiteoapi/node-sdk`'s EventDispatcher flattens the event envelope
 * before calling handlers: the outer `event` wrapper disappears and its
 * fields (message, sender) land on the top level. These tests cover the
 * bail paths and the PAIR / routing paths — crucially, the regression
 * guard that `data.event.message` (nested) MUST NOT be treated as a valid
 * message, otherwise the original "Feishu silent drop" bug comes back.
 */

function makeLarkClient() {
  return {
    im: {
      message: {
        reply: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

function makeAgentBoxManager(agentId = "agent-7") {
  return {
    getOrCreate: vi.fn().mockResolvedValue({
      boxId: `agentbox-${agentId}`,
      endpoint: "https://stub",
      agentId,
    }),
  };
}

function makeTextEvent(text: string, overrides: Record<string, unknown> = {}) {
  return {
    // EventDispatcher has already spread event.* onto the top level here.
    message: {
      message_id: "mid-1",
      chat_id: "oc_abc123",
      message_type: "text",
      content: JSON.stringify({ text }),
      ...overrides,
    },
  };
}

beforeEach(() => {
  promptMock.mockReset();
  streamEventsMock.mockReset();
  resolveBindingMock.mockReset();
  handlePairingCodeMock.mockReset();
  // Silence info logs that would otherwise clutter vitest output.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("handleLarkMessage — payload shape guards", () => {
  it("bails when data.message is undefined (empty event)", async () => {
    const larkClient = makeLarkClient();
    await handleLarkMessage({}, larkClient, "lark", makeAgentBoxManager() as any);
    expect(resolveBindingMock).not.toHaveBeenCalled();
    expect(larkClient.im.message.reply).not.toHaveBeenCalled();
  });

  it("REGRESSION: nested `data.event.message` (old SDK-shape assumption) must NOT route", async () => {
    // Historic bug: the handler read `data?.event?.message` and silently
    // dropped every event because the SDK already flattened it. Make sure
    // that shape no longer enters the routing branches.
    const larkClient = makeLarkClient();
    const nested = { event: { message: { message_id: "x", chat_id: "oc_y", message_type: "text", content: "{\"text\":\"hi\"}" } } };
    await handleLarkMessage(nested, larkClient, "lark", makeAgentBoxManager() as any);
    expect(resolveBindingMock).not.toHaveBeenCalled();
    expect(handlePairingCodeMock).not.toHaveBeenCalled();
    expect(larkClient.im.message.reply).not.toHaveBeenCalled();
  });

  it("bails on non-text message types (image, file, sticker, …)", async () => {
    const larkClient = makeLarkClient();
    const data = makeTextEvent("irrelevant", { message_type: "image" });
    await handleLarkMessage(data, larkClient, "lark", makeAgentBoxManager() as any);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("bails when content JSON cannot be parsed", async () => {
    const larkClient = makeLarkClient();
    const data = { message: { message_id: "m", chat_id: "oc_x", message_type: "text", content: "not-json" } };
    await handleLarkMessage(data, larkClient, "lark", makeAgentBoxManager() as any);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("bails after stripping @_user_N mentions leaves empty string", async () => {
    const larkClient = makeLarkClient();
    // Only @-mention chips, no actual text content
    const data = makeTextEvent("@_user_1 @_user_2   ");
    await handleLarkMessage(data, larkClient, "lark", makeAgentBoxManager() as any);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });
});

describe("handleLarkMessage — PAIR command", () => {
  it("matches /PAIR XXXXXX/ and routes to handlePairingCode; replies with success message", async () => {
    handlePairingCodeMock.mockResolvedValue({ success: true, agentName: "SRE Bot" });
    const larkClient = makeLarkClient();
    const data = makeTextEvent("PAIR ABC123");

    await handleLarkMessage(data, larkClient, "lark", makeAgentBoxManager() as any, undefined, {} as any);

    expect(handlePairingCodeMock).toHaveBeenCalledWith("ABC123", "lark", "oc_abc123", "group", expect.anything());
    expect(larkClient.im.message.reply).toHaveBeenCalledWith(expect.objectContaining({
      path: { message_id: "mid-1" },
      data: expect.objectContaining({
        content: expect.stringContaining("SRE Bot"),
      }),
    }));
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("replies with error when pairing fails", async () => {
    handlePairingCodeMock.mockResolvedValue({ success: false, error: "Invalid or expired code" });
    const larkClient = makeLarkClient();
    const data = makeTextEvent("PAIR DEADBE");

    await handleLarkMessage(data, larkClient, "lark", makeAgentBoxManager() as any, undefined, {} as any);

    const replyArg = larkClient.im.message.reply.mock.calls[0][0];
    expect(replyArg.data.content).toContain("Invalid or expired code");
  });

  it("upper-cases the pair code before sending — case-insensitive regex", async () => {
    handlePairingCodeMock.mockResolvedValue({ success: true, agentName: "n" });
    const data = makeTextEvent("pair abc123");
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, {} as any);
    expect(handlePairingCodeMock.mock.calls[0][0]).toBe("ABC123");
  });

  it("codes shorter or longer than 6 chars are not matched", async () => {
    const data5 = makeTextEvent("PAIR AB12E");      // 5 chars
    const data7 = makeTextEvent("PAIR AB12EF3");    // 7 chars
    await handleLarkMessage(data5, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, {} as any);
    await handleLarkMessage(data7, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, {} as any);
    expect(handlePairingCodeMock).not.toHaveBeenCalled();
  });
});

describe("handleLarkMessage — routing to AgentBox", () => {
  it("no binding → logs and returns without touching AgentBox", async () => {
    resolveBindingMock.mockResolvedValue(null);
    const mgr = makeAgentBoxManager();
    await handleLarkMessage(makeTextEvent("hello"), makeLarkClient(), "lark", mgr as any, undefined, {} as any);
    expect(resolveBindingMock).toHaveBeenCalledWith("lark", "oc_abc123", expect.anything());
    expect(mgr.getOrCreate).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("with binding → getOrCreate uses agentId alone, and registers (sessionId → conversationKey) in registry", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "agent-7", bindingId: "b1" });
    promptMock.mockResolvedValue({ sessionId: "remote-session-42" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    const mgr = makeAgentBoxManager("agent-7");

    // Capture what remember() gets so we can assert tenant key / agent binding.
    const rememberSpy = vi.spyOn(sessionRegistry, "remember");

    await handleLarkMessage(
      makeTextEvent("hi there"),
      makeLarkClient(),
      "lark",
      mgr as any,
      undefined,
      {} as any,
    );

    expect(mgr.getOrCreate).toHaveBeenCalledWith("agent-7");
    // One and only one argument — no userId leakage into AgentBox pod identity.
    expect(mgr.getOrCreate.mock.calls[0]).toHaveLength(1);

    expect(rememberSpy).toHaveBeenCalledTimes(1);
    const [sessionId, conversationKey, agentId] = rememberSpy.mock.calls[0];
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);
    expect(conversationKey).toBe("lark:oc_abc123");
    expect(agentId).toBe("agent-7");

    // Sanity — prompt receives the session id we just registered.
    expect(promptMock).toHaveBeenCalledWith(expect.objectContaining({
      text: "hi there",
      agentId: "agent-7",
      mode: "channel",
      sessionId,
    }));

    rememberSpy.mockRestore();
    sessionRegistry.forget(sessionId as string);
  });

  it("does not pass userId into the AgentBox prompt payload", async () => {
    // (keep this one near the bottom — it's the same shape as above)
    resolveBindingMock.mockResolvedValue({ agentId: "a", bindingId: "b" });
    promptMock.mockResolvedValue({ sessionId: "s" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(
      makeTextEvent("ping"),
      makeLarkClient(),
      "lark",
      makeAgentBoxManager("a") as any,
      undefined,
      {} as any,
    );

    const promptArg = promptMock.mock.calls[0][0];
    expect(promptArg).not.toHaveProperty("userId");
  });
});

// ── collectResponse ────────────────────────────────────────────────

describe("collectResponse — SSE event flattening", () => {
  function fakeClient(events: unknown[]) {
    return {
      streamEvents: async function* () { for (const e of events) yield e; },
    } as any;
  }

  it("captures the final assistant turn from a pi-agent-brain message_end event", async () => {
    const events = [
      { type: "turn_start" },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Hello! " },
            { type: "text", text: "How can I help?" },
          ],
        },
      },
      { type: "agent_end" },
    ];
    const text = await collectResponse(fakeClient(events), "s1");
    expect(text).toBe("Hello! How can I help?");
  });

  it("falls back to streamed content_block_delta when no message_end arrives", async () => {
    const events = [
      { type: "content_block_delta", delta: { text: "Hello" } },
      { type: "content_block_delta", delta: { text: " world" } },
    ];
    const text = await collectResponse(fakeClient(events), "s2");
    expect(text).toBe("Hello world");
  });

  it("prefers the final assistant turn over intermediate tool-use turns", async () => {
    // Intermediate tool-use turns emit message_end too; we should only
    // return the *last* assistant text, not an earlier one.
    const events = [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Let me check…" }] } },
      { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "{...}" }] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Here is your answer." }] } },
    ];
    const text = await collectResponse(fakeClient(events), "s3");
    expect(text).toBe("Here is your answer.");
  });

  it("returns empty string when the stream never produces assistant text", async () => {
    const events = [
      { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "{...}" }] } },
      { type: "agent_end" },
    ];
    const text = await collectResponse(fakeClient(events), "s4");
    expect(text).toBe("");
  });

  it("ignores non-text blocks (e.g. tool_use blocks) inside an assistant message", async () => {
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "list_clusters", input: {} },
            { type: "text", text: "Here's what I found." },
          ],
        },
      },
    ];
    const text = await collectResponse(fakeClient(events), "s5");
    expect(text).toBe("Here's what I found.");
  });
});
