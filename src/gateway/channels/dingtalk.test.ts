import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDingTalkHandler,
  handleDingTalkMessage,
  replyToDingTalk,
  ackDingTalkCallback,
  resetConversationSessionsForTest,
} from "./dingtalk.js";
import { sessionRegistry } from "../session-registry.js";

// ── Mocks ──────────────────────────────────────────────────────────

// Stub AgentBoxClient so tests don't open real HTTPS sockets.
const promptMock = vi.fn();
const streamEventsMock = vi.fn();
const closeSessionMock = vi.fn();

vi.mock("../agentbox/client.js", () => ({
  AgentBoxClient: class {
    prompt = promptMock;
    streamEvents = streamEventsMock;
    closeSession = closeSessionMock;
  },
}));

// Stub channel-manager RPCs so we don't hit frontend-ws in unit tests.
const resolveBindingMock = vi.fn();
const handlePairingCodeMock = vi.fn();

vi.mock("../channel-manager.js", () => ({
  resolveBinding: (...args: unknown[]) => resolveBindingMock(...args),
  handlePairingCode: (...args: unknown[]) => handlePairingCodeMock(...args),
}));

// ── Helpers ─────────────────────────────────────────────────────────

const WEBHOOK = "https://oapi.dingtalk.com/robot/sendBySession?session=tok";

function makeAgentBoxManager(agentId = "agent-7") {
  return {
    getOrCreate: vi.fn().mockResolvedValue({
      boxId: `agentbox-${agentId}`,
      endpoint: "https://stub",
      agentId,
    }),
  };
}

/** Build a raw DWClientDownStream whose `data` carries a robot message. */
function makeDownstream(text: string, overrides: Record<string, unknown> = {}) {
  const message = {
    msgtype: "text",
    text: { content: text },
    conversationId: "cidGROUP",
    conversationType: "2",
    sessionWebhook: WEBHOOK,
    msgId: "mid-1",
    ...overrides,
  };
  return { data: JSON.stringify(message) };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  promptMock.mockReset();
  streamEventsMock.mockReset();
  closeSessionMock.mockReset();
  closeSessionMock.mockResolvedValue(undefined);
  resolveBindingMock.mockReset();
  handlePairingCodeMock.mockReset();
  resetConversationSessionsForTest();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // The DingTalk SDK is an installed optionalDependency, so the "SDK missing"
  // fallback tests actually reach DWClient.connect(), which logs via
  // console.info/warn and attempts a (failing) network call. Silence the noise.
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Fallback when SDK missing / config parsing ──────────────────────

describe("createDingTalkHandler — fallback when SDK is missing", () => {
  it("start() resolves and does not throw when SDK import fails", async () => {
    const handler = createDingTalkHandler(
      { id: "c1", config: { client_id: "x", client_secret: "y" } },
      {} as any,
    );
    await expect(handler.start()).resolves.toBeUndefined();
    await expect(handler.stop()).resolves.toBeUndefined();
  });

  it("accepts channel.config as a JSON string", async () => {
    const handler = createDingTalkHandler(
      { id: "c2", config: JSON.stringify({ client_id: "a", client_secret: "b" }) },
      {} as any,
    );
    await expect(handler.start()).resolves.toBeUndefined();
    await expect(handler.stop()).resolves.toBeUndefined();
  });
});

// ── handleDingTalkMessage — payload shape guards ────────────────────

describe("handleDingTalkMessage — payload shape guards", () => {
  it("bails when downstream.data is undefined", async () => {
    await handleDingTalkMessage({}, "ch", makeAgentBoxManager() as any);
    expect(resolveBindingMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bails when data is not valid JSON", async () => {
    await handleDingTalkMessage({ data: "not-json" }, "ch", makeAgentBoxManager() as any);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("bails on non-text msgtype", async () => {
    const ds = makeDownstream("ignored", { msgtype: "image" });
    await handleDingTalkMessage(ds, "ch", makeAgentBoxManager() as any);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("bails when text content is empty/whitespace", async () => {
    const ds = makeDownstream("   ");
    await handleDingTalkMessage(ds, "ch", makeAgentBoxManager() as any);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("bails when sessionWebhook is missing", async () => {
    const ds = makeDownstream("hello", { sessionWebhook: "" });
    await handleDingTalkMessage(ds, "ch", makeAgentBoxManager() as any);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });
});

// ── handleDingTalkMessage — PAIR command ────────────────────────────

describe("handleDingTalkMessage — PAIR command", () => {
  it("routes a group PAIR to handlePairingCode with route_type=group and replies success", async () => {
    handlePairingCodeMock.mockResolvedValue({ success: true, agentName: "SRE Bot" });
    const ds = makeDownstream("PAIR ABC123");

    await handleDingTalkMessage(ds, "ch", makeAgentBoxManager() as any, undefined, {} as any);

    expect(handlePairingCodeMock).toHaveBeenCalledWith("ABC123", "ch", "cidGROUP", "group", expect.anything());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    const body = JSON.parse((init as any).body);
    expect(body.msgtype).toBe("text");
    expect(body.text.content).toContain("SRE Bot");
    expect(body.text.content).toContain("绑定成功");
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("uses route_type=user for a 1:1 conversation", async () => {
    handlePairingCodeMock.mockResolvedValue({ success: true, agentName: "n" });
    const ds = makeDownstream("PAIR ABC123", { conversationType: "1" });
    await handleDingTalkMessage(ds, "ch", makeAgentBoxManager() as any, undefined, {} as any);
    expect(handlePairingCodeMock.mock.calls[0][3]).toBe("user");
  });

  it("upper-cases the pair code (case-insensitive regex)", async () => {
    handlePairingCodeMock.mockResolvedValue({ success: true, agentName: "n" });
    const ds = makeDownstream("pair abc123");
    await handleDingTalkMessage(ds, "ch", makeAgentBoxManager() as any, undefined, {} as any);
    expect(handlePairingCodeMock.mock.calls[0][0]).toBe("ABC123");
  });

  it("replies with the error message when pairing fails", async () => {
    handlePairingCodeMock.mockResolvedValue({ success: false, error: "Invalid or expired code" });
    const ds = makeDownstream("PAIR DEADBE");
    await handleDingTalkMessage(ds, "ch", makeAgentBoxManager() as any, undefined, {} as any);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.text.content).toContain("Invalid or expired code");
  });

  it("codes shorter or longer than 6 chars are not matched", async () => {
    await handleDingTalkMessage(makeDownstream("PAIR AB12E"), "ch", makeAgentBoxManager() as any, undefined, {} as any);
    await handleDingTalkMessage(makeDownstream("PAIR AB12EF3"), "ch", makeAgentBoxManager() as any, undefined, {} as any);
    expect(handlePairingCodeMock).not.toHaveBeenCalled();
  });
});

// ── handleDingTalkMessage — routing to AgentBox ─────────────────────

describe("handleDingTalkMessage — routing to AgentBox", () => {
  it("no binding → logs and returns without touching AgentBox", async () => {
    resolveBindingMock.mockResolvedValue(null);
    const mgr = makeAgentBoxManager();
    await handleDingTalkMessage(makeDownstream("hello"), "ch", mgr as any, undefined, {} as any);
    expect(resolveBindingMock).toHaveBeenCalledWith("ch", "cidGROUP", expect.anything());
    expect(mgr.getOrCreate).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with binding → getOrCreate(agentId), registers session, prompts, replies markdown", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "agent-7", bindingId: "b1" });
    promptMock.mockResolvedValue({ sessionId: "remote-session-42" });
    streamEventsMock.mockImplementation(async function* () {
      yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "最终答复 **加粗**" }] } };
    });
    const mgr = makeAgentBoxManager("agent-7");
    const rememberSpy = vi.spyOn(sessionRegistry, "remember");

    await handleDingTalkMessage(makeDownstream("hi there"), "ch", mgr as any, undefined, {} as any);

    expect(mgr.getOrCreate).toHaveBeenCalledWith("agent-7");
    expect(mgr.getOrCreate.mock.calls[0]).toHaveLength(1);

    expect(rememberSpy).toHaveBeenCalledTimes(1);
    const [sessionId, conversationKey, agentId] = rememberSpy.mock.calls[0];
    expect(typeof sessionId).toBe("string");
    expect(conversationKey).toBe("dingtalk:cidGROUP");
    expect(agentId).toBe("agent-7");

    expect(promptMock).toHaveBeenCalledWith(expect.objectContaining({
      text: "hi there",
      agentId: "agent-7",
      mode: "channel",
      sessionId,
    }));

    // Final markdown reply via sessionWebhook
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.msgtype).toBe("markdown");
    expect(body.markdown.text).toContain("最终答复");

    rememberSpy.mockRestore();
    sessionRegistry.forget(sessionId as string);
  });

  it("does not pass userId into the AgentBox prompt payload", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "a", bindingId: "b" });
    promptMock.mockResolvedValue({ sessionId: "s" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    await handleDingTalkMessage(makeDownstream("ping"), "ch", makeAgentBoxManager("a") as any, undefined, {} as any);
    const promptArg = promptMock.mock.calls[0][0];
    expect(promptArg).not.toHaveProperty("userId");
  });

  it("replies with a plain-text error when the agent throws", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "a1", bindingId: "b" });
    promptMock.mockRejectedValue(new Error("AgentBox unreachable"));
    await handleDingTalkMessage(makeDownstream("hello"), "ch", makeAgentBoxManager("a1") as any, undefined, {} as any);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.msgtype).toBe("text");
    expect(body.text.content).toContain("\u274C");
    expect(body.text.content).toContain("AgentBox unreachable");
  });

  it("replies with the empty-result notice when the agent returns no text", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "a1", bindingId: "b" });
    promptMock.mockResolvedValue({ sessionId: "s-empty" });
    streamEventsMock.mockImplementation(async function* () { /* no assistant text */ });
    await handleDingTalkMessage(makeDownstream("hello"), "ch", makeAgentBoxManager("a1") as any, undefined, {} as any);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.msgtype).toBe("text");
    expect(body.text.content).toContain("\u26A0");
  });
});

// ── Conversation model: group ephemeral vs 1:1 multi-turn ──────────

describe("handleDingTalkMessage — conversation model", () => {
  beforeEach(() => {
    resolveBindingMock.mockResolvedValue({ agentId: "a1", bindingId: "b" });
    promptMock.mockResolvedValue({ sessionId: "x" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
  });

  function userMsg(text: string) {
    return makeDownstream(text, { conversationType: "1", conversationId: "cidUSER" });
  }

  it("1:1 chat reuses a stable sessionId across messages (multi-turn)", async () => {
    await handleDingTalkMessage(userMsg("first"), "ch", makeAgentBoxManager("a1") as any, undefined, {} as any);
    await handleDingTalkMessage(userMsg("second"), "ch", makeAgentBoxManager("a1") as any, undefined, {} as any);
    const s1 = (promptMock.mock.calls[0][0] as any).sessionId;
    const s2 = (promptMock.mock.calls[1][0] as any).sessionId;
    expect(s1).toBe(s2);
    sessionRegistry.forget(s1);
  });

  it("group chat uses a fresh sessionId per message (ephemeral)", async () => {
    await handleDingTalkMessage(makeDownstream("first"), "ch", makeAgentBoxManager("a1") as any, undefined, {} as any);
    await handleDingTalkMessage(makeDownstream("second"), "ch", makeAgentBoxManager("a1") as any, undefined, {} as any);
    const s1 = (promptMock.mock.calls[0][0] as any).sessionId;
    const s2 = (promptMock.mock.calls[1][0] as any).sessionId;
    expect(s1).not.toBe(s2);
    sessionRegistry.forget(s1);
    sessionRegistry.forget(s2);
  });

  it("replies a friendly busy notice when the session is already running (409)", async () => {
    promptMock.mockRejectedValue(new Error("AgentBox request failed: 409 Session is already running."));
    await handleDingTalkMessage(userMsg("hi"), "ch", makeAgentBoxManager("a1") as any, undefined, {} as any);
    const reply = JSON.parse((fetchMock.mock.calls.at(-1)![1] as any).body);
    expect(reply.msgtype).toBe("text");
    expect(reply.text.content).toContain("处理中");
  });
});

// ── /new command ────────────────────────────────────────────────────

describe("handleDingTalkMessage — /new command", () => {
  function userMsg(text: string) {
    return makeDownstream(text, { conversationType: "1", conversationId: "cidUSER" });
  }

  it("resets a 1:1 session, closes the old AgentBox session, and replies confirmation", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "a1", bindingId: "b" });
    promptMock.mockResolvedValue({ sessionId: "x" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    // Establish a stable session.
    await handleDingTalkMessage(userMsg("hello"), "ch", makeAgentBoxManager("a1") as any, undefined, {} as any);
    const firstSession = (promptMock.mock.calls[0][0] as any).sessionId;

    // /new resets it.
    await handleDingTalkMessage(userMsg("/new"), "ch", makeAgentBoxManager("a1") as any, undefined, {} as any);
    expect(closeSessionMock).toHaveBeenCalledWith(firstSession);
    const resetReply = JSON.parse((fetchMock.mock.calls.at(-1)![1] as any).body);
    expect(resetReply.text.content).toContain("已开启新会话");

    // The next message starts a brand-new session.
    await handleDingTalkMessage(userMsg("again"), "ch", makeAgentBoxManager("a1") as any, undefined, {} as any);
    const newSession = (promptMock.mock.calls.at(-1)![0] as any).sessionId;
    expect(newSession).not.toBe(firstSession);
    sessionRegistry.forget(newSession);
  });

  it("is a no-op hint in a group chat and closes nothing", async () => {
    await handleDingTalkMessage(makeDownstream("/new"), "ch", makeAgentBoxManager() as any, undefined, {} as any);
    const reply = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(reply.text.content).toContain("群聊");
    expect(closeSessionMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("matches /new case-insensitively", async () => {
    await handleDingTalkMessage(makeDownstream("/NEW"), "ch", makeAgentBoxManager() as any, undefined, {} as any);
    const reply = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(reply.text.content).toContain("群聊");
  });
});

// ── ackDingTalkCallback ─────────────────────────────────────────────

describe("ackDingTalkCallback", () => {
  it("ACKs with the messageId and a SUCCESS status (prevents redelivery)", () => {
    const send = vi.fn();
    ackDingTalkCallback({ send }, { headers: { messageId: "mid-42" } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("mid-42", { status: "SUCCESS" });
  });

  it("is a no-op when there is no messageId", () => {
    const send = vi.fn();
    ackDingTalkCallback({ send }, { headers: {} });
    ackDingTalkCallback({ send }, {});
    expect(send).not.toHaveBeenCalled();
  });

  it("never throws when send() fails", () => {
    const send = vi.fn(() => { throw new Error("socket closed"); });
    expect(() => ackDingTalkCallback({ send }, { headers: { messageId: "m" } })).not.toThrow();
  });
});

// ── replyToDingTalk ─────────────────────────────────────────────────

describe("replyToDingTalk", () => {
  it("POSTs JSON to the webhook and swallows non-ok responses", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(replyToDingTalk(WEBHOOK, { msgtype: "text", text: { content: "hi" } })).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect((init as any).method).toBe("POST");
    expect((init as any).headers["Content-Type"]).toBe("application/json");
  });

  it("never throws when fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(replyToDingTalk(WEBHOOK, { msgtype: "text" })).resolves.toBeUndefined();
  });
});
