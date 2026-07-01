import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleDingTalkMessage,
  replyToDingTalk,
  ackDingTalkCallback,
  resetConversationSessionsForTest,
} from "./dingtalk.js";
import { sessionRegistry } from "../session-registry.js";
import { buildMarkdownMessage, DINGTALK_TITLE, sanitizeMarkdownForDingTalk } from "./dingtalk-card.js";

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
  isChannelAccessDenied: (v: unknown) =>
    v !== null && typeof v === "object" && (v as { walled?: unknown }).walled === true,
}));

// chat-repo: DingTalk now persists the session + user message + (via the shared
// collectResponse) assistant/tool rows for audit. Mock it to assert the writes.
const ensureChatSessionMock = vi.fn();
const appendMessageMock = vi.fn();
vi.mock("../chat-repo.js", () => ({
  ensureChatSession: (...args: unknown[]) => ensureChatSessionMock(...args),
  appendMessage: (...args: unknown[]) => appendMessageMock(...args),
  incrementMessageCount: () => Promise.resolve(),
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
  ensureChatSessionMock.mockReset();
  ensureChatSessionMock.mockResolvedValue(undefined);
  appendMessageMock.mockReset();
  appendMessageMock.mockResolvedValue("msg-db-1");
  resetConversationSessionsForTest();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── start()/stop() lifecycle + SDK-missing fallback ─────────────────
//
// These tests must stay HERMETIC: `dingtalk-stream-sdk-nodejs` is an installed
// optionalDependency, so without mocking, `start()` reaches `DWClient.connect()`
// — a real WSS call to the DingTalk gateway that hangs to the test timeout on a
// network-restricted runner (CI/offline). We mock the SDK per-test via
// `vi.doMock` + `vi.resetModules()` and a fresh dynamic import of the handler so
// no socket is ever opened.

describe("createDingTalkHandler — start/stop lifecycle (hermetic, no network)", () => {
  afterEach(() => {
    vi.doUnmock("dingtalk-stream-sdk-nodejs");
    vi.resetModules();
  });

  /** Load the handler module with the SDK mocked so connect() never networks. */
  async function loadWithSdkMock() {
    vi.resetModules();
    const disconnect = vi.fn();
    const connect = vi.fn().mockResolvedValue(undefined);
    vi.doMock("dingtalk-stream-sdk-nodejs", () => ({
      DWClient: class {
        registerCallbackListener() { return this; }
        connect = connect;
        disconnect = disconnect;
        send() {}
      },
    }));
    const mod = await import("./dingtalk.js");
    return { createDingTalkHandler: mod.createDingTalkHandler, connect, disconnect };
  }

  it("start() connects and stop() disconnects without opening a socket", async () => {
    const { createDingTalkHandler: create, connect, disconnect } = await loadWithSdkMock();
    const handler = create(
      { id: "c1", config: { client_id: "x", client_secret: "y" } },
      {} as any,
    );
    await expect(handler.start()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(handler.stop()).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("accepts channel.config as a JSON string", async () => {
    const { createDingTalkHandler: create, connect } = await loadWithSdkMock();
    const handler = create(
      { id: "c2", config: JSON.stringify({ client_id: "a", client_secret: "b" }) },
      {} as any,
    );
    await expect(handler.start()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(handler.stop()).resolves.toBeUndefined();
  });

  it("start() falls back gracefully when the SDK is not installed", async () => {
    vi.resetModules();
    vi.doMock("dingtalk-stream-sdk-nodejs", () => {
      throw new Error("Cannot find package 'dingtalk-stream-sdk-nodejs'");
    });
    const mod = await import("./dingtalk.js");
    const handler = mod.createDingTalkHandler(
      { id: "c3", config: { client_id: "x", client_secret: "y" } },
      {} as any,
    );
    // The import throws → start() swallows it and returns; stop() is a no-op.
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

  it("audits the session: persists origin=channel + user/assistant/tool rows when the binding has an owner", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "agent-7", bindingId: "b1", createdBy: "owner-1" });
    promptMock.mockResolvedValue({ sessionId: "remote-7" });
    streamEventsMock.mockImplementation(async function* () {
      yield { type: "tool_execution_start", toolName: "bash", args: { command: "kubectl get pods" } };
      yield { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "pods ok" }], details: {} } };
      yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done." }] } };
    });

    await handleDingTalkMessage(makeDownstream("查一下 pod", { senderStaffId: "staff-1" }), "ch", makeAgentBoxManager("agent-7") as any, undefined, {} as any);

    // Session row created with origin="channel" (6th arg), owner as user_id.
    expect(ensureChatSessionMock).toHaveBeenCalledTimes(1);
    const ecArgs = ensureChatSessionMock.mock.calls[0];
    expect(ecArgs[1]).toBe("agent-7");     // agentId
    expect(ecArgs[2]).toBe("owner-1");     // user_id = binding owner (ownership)
    expect(ecArgs[5]).toBe("channel");     // origin
    // The channel sender is the raw staff id, the channel is "ch", stamped on the
    // session. NEVER the owner. siclaw has no SiCore-user concept.
    expect(ecArgs[7]).toMatchObject({ senderExternalId: "staff-1", channelId: "ch" });

    const rows = appendMessageMock.mock.calls.map((c) => c[0] as any);
    expect(rows.find((m) => m.role === "user")?.content).toBe("查一下 pod");
    expect(rows.find((m) => m.role === "user")?.metadata?.source).toBe("dingtalk");
    expect(rows.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(rows.find((m) => m.role === "tool")).toMatchObject({ toolName: "bash", outcome: "success" });
    expect(rows.find((m) => m.role === "assistant")?.content).toBe("done.");
  });

  it("does NOT persist when the binding has no owner (no false user_id)", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "agent-7", bindingId: "b1" }); // no createdBy
    promptMock.mockResolvedValue({ sessionId: "remote-7" });
    streamEventsMock.mockImplementation(async function* () {
      yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
    });

    await handleDingTalkMessage(makeDownstream("hi"), "ch", makeAgentBoxManager("agent-7") as any, undefined, {} as any);

    expect(ensureChatSessionMock).not.toHaveBeenCalled();
    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  it("passes the agent's custom system prompt (config.getAgent) into the prompt payload", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "agent-sp", bindingId: "b1" });
    promptMock.mockResolvedValue({ sessionId: "s-sp" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    const frontend = { request: vi.fn().mockResolvedValue({ system_prompt: "你是一个 SRE 专家。" }) };

    await handleDingTalkMessage(makeDownstream("hi"), "ch", makeAgentBoxManager("agent-sp") as any, undefined, frontend as any);

    expect(frontend.request).toHaveBeenCalledWith("config.getAgent", { agentId: "agent-sp" });
    const promptArg = promptMock.mock.calls[0][0] as any;
    expect(promptArg.systemPromptTemplate).toBe("你是一个 SRE 专家。");
    sessionRegistry.forget(promptArg.sessionId);
  });

  it("omits the system prompt when the config.getAgent RPC fails (best-effort)", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "agent-sp", bindingId: "b1" });
    promptMock.mockResolvedValue({ sessionId: "s-sp" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    const frontend = { request: vi.fn().mockRejectedValue(new Error("portal down")) };

    await handleDingTalkMessage(makeDownstream("hi"), "ch", makeAgentBoxManager("agent-sp") as any, undefined, frontend as any);

    const promptArg = promptMock.mock.calls[0][0] as any;
    expect(promptArg.systemPromptTemplate).toBeUndefined();
    sessionRegistry.forget(promptArg.sessionId);
  });

  it("omits the system prompt when frontendClient has no request method", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "agent-sp", bindingId: "b1" });
    promptMock.mockResolvedValue({ sessionId: "s-sp" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleDingTalkMessage(makeDownstream("hi"), "ch", makeAgentBoxManager("agent-sp") as any, undefined, {} as any);

    const promptArg = promptMock.mock.calls[0][0] as any;
    expect(promptArg.systemPromptTemplate).toBeUndefined();
    sessionRegistry.forget(promptArg.sessionId);
  });

  it("passes the resolved agent model binding into the AgentBox prompt payload", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "agent-mb", bindingId: "b1" });
    promptMock.mockResolvedValue({ sessionId: "s-mb" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    const modelConfig = {
      name: "custom",
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-test",
      api: "openai-completions",
      authHeader: true,
      models: [{
        id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro", reasoning: true,
        input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 8192,
      }],
    };
    const modelRouting = { enabled: true, strategy: "ordered_fallback", candidates: [{ provider: "fallback", modelId: "backup" }] };
    // Method-aware mock: config.getModelBinding → full binding; config.getAgent → system prompt.
    const frontend = { request: vi.fn(async (method: string) => {
      if (method === "config.getModelBinding") {
        return { binding: { modelProvider: "sicore-custom-x", modelId: "deepseek-ai/DeepSeek-V4-Pro", modelConfig, modelRouting, systemPrompt: "p" } };
      }
      return { system_prompt: "p" };
    }) };

    await handleDingTalkMessage(makeDownstream("hi"), "ch", makeAgentBoxManager("agent-mb") as any, undefined, frontend as any);

    expect(frontend.request).toHaveBeenCalledWith("config.getModelBinding", { agentId: "agent-mb" });
    const promptArg = promptMock.mock.calls[0][0] as any;
    expect(promptArg.modelProvider).toBe("sicore-custom-x");
    expect(promptArg.modelId).toBe("deepseek-ai/DeepSeek-V4-Pro");
    expect(promptArg.modelConfig).toEqual(modelConfig);
    expect(promptArg.modelRouting).toEqual(modelRouting);
    sessionRegistry.forget(promptArg.sessionId);
  });

  it("does not pass userId into the AgentBox prompt payload", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "a", bindingId: "b" });
    promptMock.mockResolvedValue({ sessionId: "s" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    await handleDingTalkMessage(makeDownstream("ping"), "ch", makeAgentBoxManager("a") as any, undefined, {} as any);
    const promptArg = promptMock.mock.calls[0][0];
    expect(promptArg).not.toHaveProperty("userId");
  });

  it("replies with a generic notice (not raw error detail) when the agent throws", async () => {
    resolveBindingMock.mockResolvedValue({ agentId: "a1", bindingId: "b" });
    promptMock.mockRejectedValue(new Error("AgentBox unreachable at https://internal-host:8443"));
    await handleDingTalkMessage(makeDownstream("hello"), "ch", makeAgentBoxManager("a1") as any, undefined, {} as any);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.msgtype).toBe("text");
    expect(body.text.content).toContain("\u274C");
    expect(body.text.content).toContain("处理失败");
    // The raw error (internal host) must NOT leak to the chat.
    expect(body.text.content).not.toContain("internal-host");
    expect(body.text.content).not.toContain("AgentBox unreachable");
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

  it("an unknown/missing conversationType defaults to ephemeral (group) routing", async () => {
    // No conversationType field at all → must NOT accumulate multi-turn context.
    await handleDingTalkMessage(
      makeDownstream("first", { conversationType: undefined, conversationId: "cidUNK" }),
      "ch", makeAgentBoxManager("a1") as any, undefined, {} as any,
    );
    await handleDingTalkMessage(
      makeDownstream("second", { conversationType: undefined, conversationId: "cidUNK" }),
      "ch", makeAgentBoxManager("a1") as any, undefined, {} as any,
    );
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

  it("refuses to POST to a non-dingtalk host (SSRF guard) and does not fetch", async () => {
    await replyToDingTalk("https://evil.example.com/exfil", { msgtype: "text" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a host that merely contains 'dingtalk.com' but is not a subdomain", async () => {
    await replyToDingTalk("https://oapi.dingtalk.com.evil.com/x", { msgtype: "text" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a non-https webhook", async () => {
    await replyToDingTalk("http://oapi.dingtalk.com/robot/send", { msgtype: "text" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed webhook URL", async () => {
    await replyToDingTalk("not a url", { msgtype: "text" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows api.dingtalk.com and *.dingtalk.com subdomains", async () => {
    await replyToDingTalk("https://api.dingtalk.com/v1.0/robot/send", { msgtype: "text" });
    await replyToDingTalk("https://anything.dingtalk.com/robot/send", { msgtype: "text" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── markdown title derivation (notification preview) ───────────────

describe("buildMarkdownMessage — title derived from body", () => {
  it("uses the first non-empty line, stripped of markdown decoration", () => {
    const body = buildMarkdownMessage("# 巡检报告 — hke-prod-a-sh01\n\n全部正常。") as any;
    expect(body.markdown.title).toBe("巡检报告 — hke-prod-a-sh01");
  });

  it("strips bold/inline-code markers and list bullets", () => {
    const body = buildMarkdownMessage("- **节点**：`273` 个全部 Ready") as any;
    expect(body.markdown.title).toBe("节点：273 个全部 Ready");
  });

  it("truncates long first lines with an ellipsis", () => {
    const long = "A".repeat(80);
    const body = buildMarkdownMessage(long) as any;
    expect(body.markdown.title.length).toBeLessThanOrEqual(61);
    expect(body.markdown.title.endsWith("…")).toBe(true);
  });

  it("falls back to the static title for empty/whitespace bodies", () => {
    const body = buildMarkdownMessage("   \n  ") as any;
    expect(body.markdown.title).toBe(DINGTALK_TITLE);
  });

  it("an explicit title overrides derivation", () => {
    const body = buildMarkdownMessage("内容", "自定义标题") as any;
    expect(body.markdown.title).toBe("自定义标题");
  });
});

// ── sanitizeMarkdownForDingTalk — image neutralisation (exfil guard) ─

describe("sanitizeMarkdownForDingTalk — strips images", () => {
  it("replaces an image with its alt text so no auto-fetch fires", () => {
    const out = sanitizeMarkdownForDingTalk("before ![diagram](https://evil.example/x.png) after");
    expect(out).toBe("before diagram after");
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("![");
  });

  it("removes an image with empty alt text entirely", () => {
    const out = sanitizeMarkdownForDingTalk("a ![](http://tracker/p.gif) b");
    expect(out).toBe("a  b");
    expect(out).not.toContain("tracker");
  });

  it("leaves image-like syntax inside fenced code blocks untouched", () => {
    const src = "```md\n![x](http://example/y.png)\n```";
    expect(sanitizeMarkdownForDingTalk(src)).toBe(src);
  });

  it("keeps ordinary links clickable (only images are neutralised)", () => {
    const out = sanitizeMarkdownForDingTalk("[docs](https://oapi.dingtalk.com/help)");
    expect(out).toBe("[docs](https://oapi.dingtalk.com/help)");
  });
});
