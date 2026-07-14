import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import {
  buildChannelTurnPrompt,
  createLarkHandler,
  handleLarkMessage,
  handleLarkCardAction,
  collectResponse,
  collectChannelResponse,
  extractInbound,
  resetLarkBindingQueuesForTest,
} from "./lark.js";
import {
  clearBackgroundChannelDelivery,
  deliverBackgroundChannelMessage,
  deliverChannelVisibleMessage,
} from "./background-delivery.js";
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
const resetBindingSessionMock = vi.fn();
const resolvePersonalBindingMock = vi.fn();
const handlePersonalPairingCodeMock = vi.fn();
const resetPersonalSessionMock = vi.fn();
const updateBindingMetaMock = vi.fn();
const setChannelContextModeMock = vi.fn();

vi.mock("../channel-manager.js", () => ({
  resolveBinding: (...args: unknown[]) => resolveBindingMock(...args),
  handlePairingCode: (...args: unknown[]) => handlePairingCodeMock(...args),
  resetBindingSession: (...args: unknown[]) => resetBindingSessionMock(...args),
  resolvePersonalBinding: (...args: unknown[]) => resolvePersonalBindingMock(...args),
  handlePersonalPairingCode: (...args: unknown[]) => handlePersonalPairingCodeMock(...args),
  resetPersonalSession: (...args: unknown[]) => resetPersonalSessionMock(...args),
  updateBindingMeta: (...args: unknown[]) => updateBindingMetaMock(...args),
  setChannelContextMode: (...args: unknown[]) => setChannelContextModeMock(...args),
  isChannelAccessDenied: (v: unknown) =>
    v !== null && typeof v === "object" && (v as { walled?: unknown }).walled === true,
}));

const resolveAgentModelBindingMock = vi.fn();

vi.mock("../agent-model-binding.js", () => ({
  resolveAgentModelBinding: (...args: unknown[]) => resolveAgentModelBindingMock(...args),
}));

const ensureChatSessionMock = vi.fn();
const appendMessageMock = vi.fn();

const recordChannelFeedbackMock = vi.fn();

vi.mock("../chat-repo.js", () => ({
  ensureChatSession: (...args: unknown[]) => ensureChatSessionMock(...args),
  appendMessage: (...args: unknown[]) => appendMessageMock(...args),
  recordChannelFeedback: (...args: unknown[]) => recordChannelFeedbackMock(...args),
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

function makeTextEvent(text: string, overrides: Record<string, unknown> = {}, senderOpenId = "ou_user_1") {
  return {
    // EventDispatcher has already spread event.* onto the top level here.
    sender: {
      sender_id: {
        open_id: senderOpenId,
      },
    },
    message: {
      message_id: "mid-1",
      chat_id: "oc_abc123",
      message_type: "text",
      content: JSON.stringify({ text }),
      ...overrides,
    },
  };
}

function makeBinding(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "a1",
    bindingId: "b",
    sessionId: "session-fixed",
    // Server-authoritative per-sender session key (open group → open_id:<sender>);
    // the Runtime uses this for queueing + /new, not the local default.
    sessionKey: "open_id:ou_user_1",
    createdBy: "user-1",
    routeType: "group",
    ...overrides,
  };
}

function makePersonalConfig(
  accessMode: "open" | "sicore_authorized" = "open",
  overrides: Record<string, unknown> = {},
) {
  return {
    app_id: "cli_personal",
    app_secret: "secret",
    personal_bot: {
      agent_id: "a1",
      access_mode: accessMode,
      owner_user_id: "owner-1",
      ...overrides,
    },
  };
}

async function waitForExpect(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 30; i += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

beforeEach(() => {
  promptMock.mockReset();
  streamEventsMock.mockReset();
  closeSessionMock.mockReset();
  resolveBindingMock.mockReset();
  handlePairingCodeMock.mockReset();
  resetBindingSessionMock.mockReset();
  resolvePersonalBindingMock.mockReset();
  handlePersonalPairingCodeMock.mockReset();
  resetPersonalSessionMock.mockReset();
  resolveAgentModelBindingMock.mockReset();
  ensureChatSessionMock.mockReset();
  appendMessageMock.mockReset();
  resolveAgentModelBindingMock.mockResolvedValue(null);
  ensureChatSessionMock.mockResolvedValue(undefined);
  appendMessageMock.mockResolvedValue("msg-db-1");
  resetLarkBindingQueuesForTest();
  clearBackgroundChannelDelivery("session-fixed");
  clearBackgroundChannelDelivery("session-agent-7");
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

  it("bails on unsupported message types (audio, file, sticker, …)", async () => {
    const larkClient = makeLarkClient();
    const data = makeTextEvent("irrelevant", { message_type: "audio" });
    await handleLarkMessage(data, larkClient, "lark", makeAgentBoxManager() as any);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("bails on an image message that carries no image_key", async () => {
    const larkClient = makeLarkClient();
    const data = { message: { message_id: "m", chat_id: "oc_x", message_type: "image", content: "{}" } };
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

    expect(handlePairingCodeMock).toHaveBeenCalledWith("ABC123", "lark", "oc_abc123", "group", expect.anything(), undefined);
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

  it("uses group_channel_id for group PAIR when the same handler also has a personal bot", async () => {
    handlePairingCodeMock.mockResolvedValue({ success: true, agentName: "SRE Bot" });
    await handleLarkMessage(
      makeTextEvent("PAIR ABC123"),
      makeLarkClient(),
      "lark-runtime",
      makeAgentBoxManager() as any,
      undefined,
      {} as any,
      "zh-CN",
      {
        app_id: "cli_shared",
        app_secret: "secret",
        group_channel_id: "lark",
        personal_bot: {
          channel_id: "pb-1",
          agent_id: "a1",
          access_mode: "open",
          owner_user_id: "owner-1",
        },
      },
    );

    expect(handlePairingCodeMock).toHaveBeenCalledWith("ABC123", "lark", "oc_abc123", "group", expect.anything(), undefined);
    expect(handlePersonalPairingCodeMock).not.toHaveBeenCalled();
  });

  it("seeds the binding display name from the fetched group title", async () => {
    handlePairingCodeMock.mockResolvedValue({ success: true, agentName: "SRE Bot" });
    const larkClient = makeLarkClient() as any;
    larkClient.request = vi.fn().mockResolvedValue({ data: { name: " 运维告警群 " } });

    await handleLarkMessage(makeTextEvent("PAIR ABC123"), larkClient, "lark", makeAgentBoxManager() as any, undefined, {} as any);

    expect(larkClient.request).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining("/open-apis/im/v1/chats/oc_abc123"),
    }));
    expect(handlePairingCodeMock).toHaveBeenCalledWith("ABC123", "lark", "oc_abc123", "group", expect.anything(), "运维告警群");
  });

  it("PAIR success reply is Chinese for zh-CN (feishu domain)", async () => {
    handlePairingCodeMock.mockResolvedValue({ success: true, agentName: "SRE Bot" });
    const lark = makeLarkClient();
    await handleLarkMessage(
      makeTextEvent("PAIR ABC123"),
      lark,
      "lark",
      makeAgentBoxManager() as any,
      undefined,
      {} as any,
      "zh-CN",
    );
    const replyArg = lark.im.message.reply.mock.calls[0][0];
    expect(replyArg.data.content).toContain("绑定成功");
    expect(replyArg.data.content).toContain("SRE Bot");
  });

  it("PAIR success reply is English for en-US (lark domain)", async () => {
    handlePairingCodeMock.mockResolvedValue({ success: true, agentName: "SRE Bot" });
    const lark = makeLarkClient();
    await handleLarkMessage(
      makeTextEvent("PAIR ABC123"),
      lark,
      "lark",
      makeAgentBoxManager() as any,
      undefined,
      {} as any,
      "en-US",
    );
    const replyArg = lark.im.message.reply.mock.calls[0][0];
    expect(replyArg.data.content).toContain("Paired!");
  });

  it("codes shorter or longer than 6 chars are not matched", async () => {
    const data5 = makeTextEvent("PAIR AB12E");      // 5 chars
    const data7 = makeTextEvent("PAIR AB12EF3");    // 7 chars
    await handleLarkMessage(data5, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, {} as any);
    await handleLarkMessage(data7, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, {} as any);
    expect(handlePairingCodeMock).not.toHaveBeenCalled();
  });
});

describe("handleLarkMessage — personal bot p2p", () => {
  it("uses personal_bot.channel_id for p2p binding inside a shared Feishu app handler", async () => {
    resolvePersonalBindingMock.mockResolvedValue(makeBinding({
      bindingId: "pb-1",
      sessionId: "session-open-ou1",
      sessionKey: "open_id:ou_user_1",
      routeType: "user",
      createdBy: "owner-1",
    }));
    promptMock.mockResolvedValue({ sessionId: "session-open-ou1" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(
      makeTextEvent("hello personal", { chat_type: "p2p" }),
      makeLarkClient(),
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      {
        app_id: "cli_shared",
        app_secret: "secret",
        group_channel_id: "lark",
        personal_bot: {
          channel_id: "pb-1",
          agent_id: "a1",
          access_mode: "open",
          owner_user_id: "owner-1",
        },
      },
    );

    expect(resolvePersonalBindingMock.mock.calls.map((call) => call[0])).toEqual(["pb-1", "pb-1"]);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("open mode resolves a p2p sender and uses the returned per-openid session", async () => {
    resolvePersonalBindingMock.mockResolvedValue(makeBinding({
      bindingId: "personal-bot-1",
      sessionId: "session-open-ou1",
      sessionKey: "open_id:ou_user_1",
      routeType: "user",
      createdBy: "owner-1",
    }));
    promptMock.mockResolvedValue({ sessionId: "session-open-ou1" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(
      makeTextEvent("hello personal", { chat_type: "p2p" }),
      makeLarkClient(),
      "personal-bot-1",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      makePersonalConfig("open"),
    );

    expect(resolvePersonalBindingMock).toHaveBeenCalledWith("personal-bot-1", "ou_user_1", expect.anything());
    expect(resolveBindingMock).not.toHaveBeenCalled();
    expect(ensureChatSessionMock).toHaveBeenCalledWith(
      "session-open-ou1",
      "a1",
      "owner-1",
      "hello personal",
      "hello personal",
      "channel",
      undefined,
      expect.objectContaining({ senderExternalId: "ou_user_1" }),
    );
    expect(promptMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-open-ou1",
      agentId: "a1",
      mode: "channel",
    }));
  });

  it("authorized mode prompts for Sicore OAuth authorization when the open_id is not bound", async () => {
    resolvePersonalBindingMock.mockResolvedValue(null);
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("查一下集群", { chat_type: "p2p" }),
      lark,
      "personal-bot-1",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      makePersonalConfig("sicore_authorized", { authorize_url: "https://sicore.example/siclaw/a1?tab=channels" }),
    );

    expect(promptMock).not.toHaveBeenCalled();
    expect(lark.im.message.reply.mock.calls[0][0].data.content).toContain("授权飞书账号");
    expect(lark.im.message.reply.mock.calls[0][0].data.content).toContain("https://sicore.example/siclaw/a1?tab=channels");
  });

  it("authorized p2p PAIR consumes the personal pairing code instead of group binding", async () => {
    handlePersonalPairingCodeMock.mockResolvedValue({ success: true, agentName: "Secure Agent" });
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("PAIR abc123", { chat_type: "p2p" }),
      lark,
      "personal-bot-1",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      makePersonalConfig("sicore_authorized"),
    );

    expect(handlePersonalPairingCodeMock).toHaveBeenCalledWith("ABC123", "personal-bot-1", "ou_user_1", expect.anything());
    expect(handlePairingCodeMock).not.toHaveBeenCalled();
    expect(lark.im.message.reply.mock.calls[0][0].data.content).toContain("授权成功");
  });

  it("p2p /new resets only the current personal session", async () => {
    resolvePersonalBindingMock.mockResolvedValue(makeBinding({
      bindingId: "personal-bot-1",
      sessionId: "old-personal",
      sessionKey: "sicore_user:user-1",
      routeType: "user",
      createdBy: "user-1",
    }));
    resetPersonalSessionMock.mockResolvedValue({
      success: true,
      agentId: "a1",
      oldSessionId: "old-personal",
      sessionId: "new-personal",
    });
    const lark = makeLarkClient();
    const mgr = makeAgentBoxManager("a1");

    await handleLarkMessage(
      makeTextEvent("/new", { chat_type: "p2p" }),
      lark,
      "personal-bot-1",
      mgr as any,
      undefined,
      {} as any,
      "zh-CN",
      makePersonalConfig("sicore_authorized"),
    );

    expect(resetPersonalSessionMock).toHaveBeenCalledWith("personal-bot-1", "sicore_user:user-1", expect.anything());
    expect(resetBindingSessionMock).not.toHaveBeenCalled();
    expect(closeSessionMock).toHaveBeenCalledWith("old-personal");
    expect(lark.im.message.reply.mock.calls[0][0].data.content).toContain("已开启新会话");
  });

  it("ignores group messages received by a personal-only handler", async () => {
    await handleLarkMessage(
      makeTextEvent("PAIR ABC123"),
      makeLarkClient(),
      "lark:personal:pb-1",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      makePersonalConfig("open"),
    );

    expect(handlePairingCodeMock).not.toHaveBeenCalled();
    expect(resolveBindingMock).not.toHaveBeenCalled();
    expect(resolvePersonalBindingMock).not.toHaveBeenCalled();
  });
});

describe("handleLarkMessage — routing to AgentBox", () => {
  it("no binding → logs and returns without touching AgentBox", async () => {
    resolveBindingMock.mockResolvedValue(null);
    const mgr = makeAgentBoxManager();
    await handleLarkMessage(makeTextEvent("hello"), makeLarkClient(), "lark", mgr as any, undefined, {} as any);
    expect(resolveBindingMock).toHaveBeenCalledWith("lark", "oc_abc123", expect.anything(), "open_id:ou_user_1", "ou_user_1");
    expect(mgr.getOrCreate).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("uses group_channel_id for normal group messages in a shared Feishu app handler", async () => {
    resolveBindingMock.mockResolvedValue(null);
    await handleLarkMessage(
      makeTextEvent("hello"),
      makeLarkClient(),
      "lark-runtime",
      makeAgentBoxManager() as any,
      undefined,
      {} as any,
      "zh-CN",
      {
        app_id: "cli_shared",
        app_secret: "secret",
        group_channel_id: "lark",
        personal_bot: {
          channel_id: "pb-1",
          agent_id: "a1",
          access_mode: "open",
          owner_user_id: "owner-1",
        },
      },
    );

    expect(resolveBindingMock).toHaveBeenCalledWith("lark", "oc_abc123", expect.anything(), "open_id:ou_user_1", "ou_user_1");
    expect(resolvePersonalBindingMock).not.toHaveBeenCalled();
  });

  it("authorized group: a walled sender gets a hint and no agent runs", async () => {
    resolveBindingMock.mockResolvedValue({ walled: true, reason: "unbound", authorizeUrl: "https://sicore.example/auth" });
    const lark = makeLarkClient();
    const mgr = makeAgentBoxManager();
    await handleLarkMessage(
      makeTextEvent("hi"),
      lark,
      "lark-runtime",
      mgr as any,
      undefined,
      {} as any,
      "zh-CN",
      {
        app_id: "cli_x",
        app_secret: "secret",
        group_channel_id: "lark:personal:pb-1",
        personal_bot: { channel_id: "pb-1", agent_id: "a1", access_mode: "sicore_authorized", owner_user_id: "owner-1" },
      },
    );

    const replyArg = lark.im.message.reply.mock.calls[0][0];
    const text = JSON.parse(replyArg.data.content).text as string;
    expect(text).toContain("https://sicore.example/auth");
    expect(mgr.getOrCreate).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("backfills the binding display name once when the platform reports a new title", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ bindingId: "b-name-1", displayName: null }));
    promptMock.mockResolvedValue({ sessionId: "remote-1" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    updateBindingMetaMock.mockResolvedValue({ success: true });
    const larkClient = makeLarkClient() as any;
    larkClient.request = vi.fn().mockResolvedValue({ data: { name: "新群名" } });

    await handleLarkMessage(makeTextEvent("hello"), larkClient, "lark", makeAgentBoxManager() as any, undefined, {} as any);
    await new Promise((r) => setImmediate(r)); // detached backfill settles
    expect(updateBindingMetaMock).toHaveBeenCalledWith("lark", "oc_abc123", "新群名", expect.anything());

    // Once-per-process guard: a second message must not re-hit the platform API.
    larkClient.request.mockClear();
    updateBindingMetaMock.mockClear();
    await handleLarkMessage(makeTextEvent("again"), larkClient, "lark", makeAgentBoxManager() as any, undefined, {} as any);
    await new Promise((r) => setImmediate(r));
    expect(larkClient.request).not.toHaveBeenCalled();
    expect(updateBindingMetaMock).not.toHaveBeenCalled();
  });

  it("a transient name-fetch failure is retried on a later message (bounded)", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ bindingId: "b-name-retry", displayName: null }));
    promptMock.mockResolvedValue({ sessionId: "remote-1" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    updateBindingMetaMock.mockResolvedValue({ success: true });
    const larkClient = makeLarkClient() as any;
    larkClient.request = vi.fn().mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValue({ data: { name: "新群名" } });

    // First message: fetch fails transiently — no update, but the guard must
    // NOT be poisoned for the rest of the process lifetime.
    await handleLarkMessage(makeTextEvent("hello"), larkClient, "lark", makeAgentBoxManager() as any, undefined, {} as any);
    await new Promise((r) => setImmediate(r));
    expect(updateBindingMetaMock).not.toHaveBeenCalled();

    // Second message: retried and succeeds.
    await handleLarkMessage(makeTextEvent("again"), larkClient, "lark", makeAgentBoxManager() as any, undefined, {} as any);
    await new Promise((r) => setImmediate(r));
    expect(updateBindingMetaMock).toHaveBeenCalledWith("lark", "oc_abc123", "新群名", expect.anything());

    // Third message: success pinned the guard — no further API traffic.
    larkClient.request.mockClear();
    await handleLarkMessage(makeTextEvent("third"), larkClient, "lark", makeAgentBoxManager() as any, undefined, {} as any);
    await new Promise((r) => setImmediate(r));
    expect(larkClient.request).not.toHaveBeenCalled();
  });

  it("persistent name-fetch failures stop after the attempt cap", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ bindingId: "b-name-cap", displayName: null }));
    promptMock.mockResolvedValue({ sessionId: "remote-1" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    updateBindingMetaMock.mockClear(); // mocks persist across tests in this file
    const larkClient = makeLarkClient() as any;
    larkClient.request = vi.fn().mockRejectedValue(new Error("down"));

    for (let i = 0; i < 5; i++) {
      await handleLarkMessage(makeTextEvent(`msg-${i}`), larkClient, "lark", makeAgentBoxManager() as any, undefined, {} as any);
      await new Promise((r) => setImmediate(r));
    }
    // 3 attempts max, not one per message.
    expect(larkClient.request).toHaveBeenCalledTimes(3);
    expect(updateBindingMetaMock).not.toHaveBeenCalled();
  });

  it("with binding → getOrCreate uses agentId alone, and registers the durable channel session owner", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ agentId: "agent-7", bindingId: "b1", sessionId: "session-agent-7" }));
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
    const [sessionId, ownerUserId, agentId] = rememberSpy.mock.calls[0];
    expect(sessionId).toBe("session-agent-7");
    expect(ownerUserId).toBe("user-1");
    expect(agentId).toBe("agent-7");

    // Sanity — prompt receives the session id we just registered.
    expect(promptMock).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("hi there"),
      agentId: "agent-7",
      mode: "channel",
      sessionId: "session-agent-7",
    }));

    rememberSpy.mockRestore();
    sessionRegistry.forget("session-agent-7");
  });

  it("does not pass userId into the AgentBox prompt payload", async () => {
    // (keep this one near the bottom — it's the same shape as above)
    resolveBindingMock.mockResolvedValue(makeBinding({ agentId: "a" }));
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

  it("passes the resolved agent model binding into the AgentBox prompt payload", async () => {
    const modelConfig = {
      name: "custom",
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-test",
      api: "openai-completions",
      authHeader: true,
      models: [
        {
          id: "deepseek-ai/DeepSeek-V4-Pro",
          name: "DeepSeek V4 Pro",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    };
    const modelRouting = {
      enabled: true,
      strategy: "ordered_fallback",
      candidates: [{ provider: "fallback", modelId: "backup" }],
    };
    resolveBindingMock.mockResolvedValue(makeBinding());
    resolveAgentModelBindingMock.mockResolvedValue({
      modelProvider: "sicore-custom-254e68c4",
      modelId: "deepseek-ai/DeepSeek-V4-Pro",
      modelConfig,
      modelRouting,
      systemPrompt: "  custom prompt  ",
    });
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(
      makeTextEvent("ping"),
      makeLarkClient(),
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    expect(resolveAgentModelBindingMock).toHaveBeenCalledWith("a1", expect.anything());
    expect(promptMock).toHaveBeenCalledWith(expect.objectContaining({
      modelProvider: "sicore-custom-254e68c4",
      modelId: "deepseek-ai/DeepSeek-V4-Pro",
      modelConfig,
      modelRouting,
      systemPromptTemplate: "custom prompt",
    }));
  });

  it("persists channel sessions/messages before prompting and wraps the current request", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(
      makeTextEvent("检查当前集群"),
      makeLarkClient(),
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    // Record the raw open_id as the channel sender on the SESSION, NEVER the
    // binding owner. Session row user_id stays the owner ("user-1") for
    // ownership, but the channel audit actor is the sender_external_id.
    expect(ensureChatSessionMock).toHaveBeenCalledWith(
      "session-fixed",
      "a1",
      "user-1",
      "检查当前集群",
      "检查当前集群",
      "channel",
      undefined,
      expect.objectContaining({ senderExternalId: "ou_user_1", channelId: "lark" }),
    );
    expect(appendMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-fixed",
      role: "user",
      content: "检查当前集群",
      metadata: expect.objectContaining({
        source: "lark",
        channelId: "lark",
        chatId: "oc_abc123",
        messageId: "mid-1",
        bindingId: "b",
        senderOpenId: "ou_user_1",
        sessionKey: "open_id:ou_user_1",
      }),
    }));
    expect(promptMock.mock.calls[0][0]).toMatchObject({
      sessionId: "session-fixed",
      mode: "channel",
      agentId: "a1",
    });
    expect(promptMock.mock.calls[0][0].text).toContain("<channel-turn>");
    expect(promptMock.mock.calls[0][0].text).toContain("检查当前集群");
  });

  it("records the raw open_id as the channel sender even for a sicore_user session key", async () => {
    // siclaw has no SiCore-user concept: regardless of the server-issued session
    // key, the audit sender is always the raw open_id, stamped on the session.
    resolveBindingMock.mockResolvedValue(makeBinding({
      sessionKey: "sicore_user:sender-99",
      createdBy: "owner-1",
    }));
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(
      makeTextEvent("查一下"),
      makeLarkClient(),
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    // Session row still owned by createdBy; the channel sender is the open_id.
    expect(ensureChatSessionMock).toHaveBeenCalledWith(
      "session-fixed", "a1", "owner-1", "查一下", "查一下", "channel",
      undefined, expect.objectContaining({ senderExternalId: "ou_user_1" }),
    );
  });

  it("reuses the same durable session for multiple messages from the same sender in the same group", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ sessionId: "same-session" }));
    promptMock.mockResolvedValue({ sessionId: "same-session" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(makeTextEvent("第一条"), makeLarkClient(), "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);
    await handleLarkMessage(makeTextEvent("第二条"), makeLarkClient(), "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);

    expect(promptMock).toHaveBeenCalledTimes(2);
    expect(promptMock.mock.calls.map((call) => call[0].sessionId)).toEqual(["same-session", "same-session"]);
  });

  it("uses separate durable sessions for different senders in the same group", async () => {
    resolveBindingMock.mockImplementation((_channelId, _routeKey, _frontend, sessionKey) => {
      const suffix = sessionKey === "open_id:ou_user_2" ? "user-2" : "user-1";
      return Promise.resolve(makeBinding({ sessionId: `session-${suffix}`, sessionKey }));
    });
    promptMock.mockResolvedValue({ sessionId: "ignored" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(makeTextEvent("第一人"), makeLarkClient(), "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);
    await handleLarkMessage(makeTextEvent("第二人", { message_id: "mid-2" }, "ou_user_2"), makeLarkClient(), "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);

    expect(promptMock).toHaveBeenCalledTimes(2);
    expect(promptMock.mock.calls.map((call) => call[0].sessionId)).toEqual(["session-user-1", "session-user-2"]);
    expect(resolveBindingMock.mock.calls.map((call) => call[3])).toEqual([
      "open_id:ou_user_1",
      "open_id:ou_user_1",
      "open_id:ou_user_2",
      "open_id:ou_user_2",
    ]);
  });

  it("rejects legacy bindings without an owner instead of writing lark chat ids as users", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ createdBy: null }));
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    expect(ensureChatSessionMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
    const replyArg = lark.im.message.reply.mock.calls[0][0];
    expect(replyArg.data.content).toContain("重新生成 PAIR code");
  });

  it("/new resets the binding session and closes the old AgentBox session best-effort", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ sessionId: "old-session" }));
    resetBindingSessionMock.mockResolvedValue({ success: true, agentId: "a1", oldSessionId: "old-session", sessionId: "new-session" });
    const mgr = makeAgentBoxManager("a1");
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("/new"),
      lark,
      "lark",
      mgr as any,
      undefined,
      {} as any,
    );

    expect(resetBindingSessionMock).toHaveBeenCalledWith("lark", "oc_abc123", expect.anything(), "open_id:ou_user_1");
    expect(mgr.getOrCreate).toHaveBeenCalledWith("a1");
    expect(closeSessionMock).toHaveBeenCalledWith("old-session");
    expect(promptMock).not.toHaveBeenCalled();
    expect(lark.im.message.reply.mock.calls[0][0].data.content).toContain("已开启新会话");
  });

  it("/new resets the SERVER session key (authorized group → sicore_user:<id>), not the local open_id", async () => {
    // Contract: the Runtime must reset whatever session key the resolver
    // returned, so an authorized group resets the sender's sicore_user session
    // and an open group resets open_id:<sender> — never the local default.
    resolveBindingMock.mockResolvedValue(makeBinding({ sessionId: "old-session", sessionKey: "sicore_user:u42" }));
    resetBindingSessionMock.mockResolvedValue({ success: true, agentId: "a1", oldSessionId: "old-session", sessionId: "new-session" });
    const mgr = makeAgentBoxManager("a1");

    await handleLarkMessage(
      makeTextEvent("/new"),
      makeLarkClient(),
      "lark",
      mgr as any,
      undefined,
      {} as any,
    );

    expect(resetBindingSessionMock).toHaveBeenCalledWith("lark", "oc_abc123", expect.anything(), "sicore_user:u42");
  });

  it("/new in a SHARED group is rejected, not reset (one member can't wipe the group)", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ sessionId: "grp", sessionKey: "chat:oc_abc123", contextMode: "shared" }));
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("/new"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    expect(resetBindingSessionMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
    expect(lark.im.message.reply.mock.calls[0][0].data.content).toContain("不支持单人重置");
  });

  it("queues concurrent messages for the same sender instead of starting a second prompt", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ sessionId: "queued-session" }));
    let releaseFirst!: () => void;
    promptMock
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ sessionId: "queued-session" });
      }))
      .mockResolvedValueOnce({ sessionId: "queued-session" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    const mgr = makeAgentBoxManager("a1");

    const first = handleLarkMessage(makeTextEvent("first"), makeLarkClient(), "lark", mgr as any, undefined, {} as any);
    await waitForExpect(() => expect(promptMock).toHaveBeenCalledTimes(1));

    const second = handleLarkMessage(makeTextEvent("second"), makeLarkClient(), "lark", mgr as any, undefined, {} as any);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(promptMock).toHaveBeenCalledTimes(1);

    releaseFirst();
    await waitForExpect(() => expect(promptMock).toHaveBeenCalledTimes(2));
    await Promise.all([first, second]);
    expect(promptMock.mock.calls.map((call) => call[0].text)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ]);
  });

  it("does not queue different senders in the same group behind each other", async () => {
    resolveBindingMock.mockImplementation((_channelId, _routeKey, _frontend, sessionKey) => {
      const suffix = sessionKey === "open_id:ou_user_2" ? "user-2" : "user-1";
      return Promise.resolve(makeBinding({ sessionId: `session-${suffix}`, sessionKey }));
    });
    let releaseFirst!: () => void;
    promptMock
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ sessionId: "session-user-1" });
      }))
      .mockResolvedValueOnce({ sessionId: "session-user-2" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    const mgr = makeAgentBoxManager("a1");

    const first = handleLarkMessage(makeTextEvent("first"), makeLarkClient(), "lark", mgr as any, undefined, {} as any);
    await waitForExpect(() => expect(promptMock).toHaveBeenCalledTimes(1));

    const second = handleLarkMessage(makeTextEvent("second", { message_id: "mid-2" }, "ou_user_2"), makeLarkClient(), "lark", mgr as any, undefined, {} as any);
    await waitForExpect(() => expect(promptMock).toHaveBeenCalledTimes(2));

    expect(promptMock.mock.calls.map((call) => call[0].sessionId)).toEqual(["session-user-1", "session-user-2"]);
    releaseFirst();
    await Promise.all([first, second]);
  });

  it("replies with a queue-full notice when one binding already has 20 pending messages", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ sessionId: "full-session" }));
    let releaseFirst!: () => void;
    promptMock
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ sessionId: "full-session" });
      }))
      .mockResolvedValue({ sessionId: "full-session" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    const lark = makeLarkClient();
    const mgr = makeAgentBoxManager("a1");

    const first = handleLarkMessage(makeTextEvent("first"), lark, "lark", mgr as any, undefined, {} as any);
    await waitForExpect(() => expect(promptMock).toHaveBeenCalledTimes(1));

    const queued = Array.from({ length: 21 }, (_, i) =>
      handleLarkMessage(makeTextEvent(`queued-${i}`), lark, "lark", mgr as any, undefined, {} as any),
    );
    await waitForExpect(() => {
      expect(lark.im.message.reply).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ content: expect.stringContaining("排队") }),
      }));
    });

    releaseFirst();
    await Promise.all([first, ...queued]);
    expect(promptMock).toHaveBeenCalledTimes(21);
  });
});

describe("handleLarkCardAction — 👍/👎 feedback", () => {
  function makeCardAction(overrides: Record<string, unknown> = {}) {
    return {
      operator: { open_id: "ou_clicker" },
      action: {
        tag: "button",
        value: {
          kind: "siclaw_feedback",
          rating: "up",
          session_id: "sess-1",
          card_id: "CARD-1",
          channel_id: "lark",
          locale: "zh-CN",
        },
      },
      ...overrides,
    };
  }

  // Flush the detached persist/echo IIFE queued by the (synchronous) handler.
  const flush = () => new Promise((r) => setImmediate(r));

  it("returns the success toast synchronously and persists the vote detached", async () => {
    recordChannelFeedbackMock.mockResolvedValue({ success: true });
    // Synchronous return — the callback response must not await persistence.
    const result = handleLarkCardAction(makeCardAction(), makeLarkClient());
    expect(result).toEqual({ toast: { type: "success", content: expect.stringContaining("反馈") } });

    await flush();
    expect(recordChannelFeedbackMock).toHaveBeenCalledWith({
      sessionId: "sess-1",
      messageRef: "CARD-1",
      rating: "up",
      senderExternalId: "ou_clicker",
      channelId: "lark",
      source: "lark",
    });
  });

  it("ignores card actions that are not feedback buttons", async () => {
    recordChannelFeedbackMock.mockClear();
    const data = makeCardAction({ action: { tag: "button", value: { kind: "something_else" } } });
    const result = handleLarkCardAction(data, makeLarkClient());
    expect(result).toBeUndefined();
    await flush();
    expect(recordChannelFeedbackMock).not.toHaveBeenCalled();
  });

  it("accepts action.value delivered as a JSON string (some CardKit versions)", async () => {
    recordChannelFeedbackMock.mockClear();
    recordChannelFeedbackMock.mockResolvedValue({ success: true });
    const data = makeCardAction();
    (data.action as any).value = JSON.stringify((data.action as any).value);
    const result = handleLarkCardAction(data, makeLarkClient());
    expect(result).toEqual({ toast: { type: "success", content: expect.any(String) } });
    await flush();
    expect(recordChannelFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({ rating: "up", messageRef: "CARD-1" }));
  });

  it("missing operator open_id → error toast, nothing persisted", async () => {
    recordChannelFeedbackMock.mockClear();
    const data = makeCardAction({ operator: {} });
    const result = handleLarkCardAction(data, makeLarkClient());
    expect(result).toEqual({ toast: { type: "error", content: expect.any(String) } });
    await flush();
    expect(recordChannelFeedbackMock).not.toHaveBeenCalled();
  });

  it("a slow persist does NOT block the callback response (200671 fix)", async () => {
    // Persistence hangs; the handler must still return its toast synchronously
    // so Feishu gets a response well inside its ~3s budget.
    recordChannelFeedbackMock.mockImplementation(() => new Promise(() => { /* never settles */ }));
    const result = handleLarkCardAction(makeCardAction(), makeLarkClient());
    expect(result).toEqual({ toast: { type: "success", content: expect.any(String) } });
  });

  it("a persist failure is swallowed (optimistic toast already returned)", async () => {
    recordChannelFeedbackMock.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Still an optimistic success toast — the click did reach us; a rare
    // persist failure is logged, never shown as 200671 on a saved vote.
    const result = handleLarkCardAction(makeCardAction(), makeLarkClient());
    expect(result).toEqual({ toast: { type: "success", content: expect.any(String) } });
    await flush();
    expect(console.error).toHaveBeenCalled();
  });

  it("down votes and en-US locale flow through", async () => {
    recordChannelFeedbackMock.mockResolvedValue({ success: true });
    const data = makeCardAction();
    (data.action as any).value.rating = "down";
    (data.action as any).value.locale = "en-US";
    const result = handleLarkCardAction(data, makeLarkClient());
    expect(result).toEqual({ toast: { type: "success", content: expect.stringContaining("thanks") } });
    await flush();
    expect(recordChannelFeedbackMock).toHaveBeenLastCalledWith(expect.objectContaining({ rating: "down" }));
  });
});

describe("handleLarkCardAction — /mode context switch", () => {
  function modeClient() {
    return { im: { message: { create: vi.fn().mockResolvedValue({}) } } };
  }
  function modeAction(mode: string, overrides: Record<string, unknown> = {}) {
    return {
      operator: { open_id: "ou_switcher" },
      action: {
        tag: "button",
        value: { kind: "siclaw_ctx_mode", channel_id: "ch1", route_key: "oc_group1", mode, locale: "zh-CN" },
      },
      ...overrides,
    };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it("returns a success toast synchronously and persists + announces detached", async () => {
    setChannelContextModeMock.mockResolvedValue({ success: true, mode: "per_user" });
    const client = modeClient();
    const result = handleLarkCardAction(modeAction("per_user"), client, { request: vi.fn() } as any);
    expect(result).toEqual({ toast: { type: "success", content: expect.stringContaining("个人模式") } });

    await flush();
    expect(setChannelContextModeMock).toHaveBeenCalledWith("ch1", "oc_group1", "per_user", expect.anything());
    expect(client.im.message.create).toHaveBeenCalledWith(expect.objectContaining({
      params: { receive_id_type: "chat_id" },
      data: expect.objectContaining({ receive_id: "oc_group1", msg_type: "text" }),
    }));
  });

  it("rejects an unknown mode with an error toast and no persist", async () => {
    setChannelContextModeMock.mockClear();
    const result = handleLarkCardAction(modeAction("bogus"), modeClient(), { request: vi.fn() } as any);
    expect(result).toEqual({ toast: { type: "error", content: expect.any(String) } });
    await flush();
    expect(setChannelContextModeMock).not.toHaveBeenCalled();
  });

  it("a slow persist does NOT block the callback toast (200671 discipline)", () => {
    setChannelContextModeMock.mockImplementation(() => new Promise(() => { /* never settles */ }));
    const result = handleLarkCardAction(modeAction("shared"), modeClient(), { request: vi.fn() } as any);
    expect(result).toEqual({ toast: { type: "success", content: expect.stringContaining("团队模式") } });
  });
});

describe("handleLarkMessage — group @-mention gating (@所有人 bug)", () => {
  const BOT = "ou_bot_self";

  // A realistic group event carries chat_type:"group" + a mentions[] array.
  function groupEvent(text: string, mentions: any[]) {
    return makeTextEvent(text, { chat_type: "group", mentions });
  }

  it("routes when THIS bot is individually @-mentioned (open_id match)", async () => {
    resolveBindingMock.mockResolvedValue(null);
    const data = groupEvent("@_user_1 查一下集群", [
      { key: "@_user_1", id: { open_id: BOT } },
    ]);
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);
    expect(resolveBindingMock).toHaveBeenCalled();
  });

  it("IGNORES @所有人 announcements (key @_all, not the bot's open_id)", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    const data = groupEvent("@_all 基础功能都搞过来了", [
      { key: "@_all", id: {} },
    ]);
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("IGNORES a message that @-mentions someone else (not the bot)", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    const data = groupEvent("@_user_2 你看下", [
      { key: "@_user_2", id: { open_id: "ou_someone_else" } },
    ]);
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("IGNORES a plain group message with no mention at all", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    const data = groupEvent("随便聊两句", []);
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("degraded (botOpenId unknown): still drops @所有人 by its @_all key", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    const data = groupEvent("@_all 通知一下", [{ key: "@_all", id: {} }]);
    // No botOpenId passed (bot-info fetch failed at start).
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("degraded (botOpenId unknown): a non-@_all mention still routes", async () => {
    resolveBindingMock.mockResolvedValue(null);
    const data = groupEvent("@_user_1 帮我查", [{ key: "@_user_1", id: { open_id: "ou_whoever" } }]);
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any);
    expect(resolveBindingMock).toHaveBeenCalled();
  });

  it("does NOT gate p2p messages — DMs never carry an @bot mention", async () => {
    // p2p path is personal-bot only; with no personal_bot config it bails
    // *before* resolveBinding, but it must NOT be dropped by the group gate.
    const data = makeTextEvent("私聊问个问题", { chat_type: "p2p" });
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);
    // group resolveBinding is never reached on the p2p branch
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });
});

describe("buildChannelTurnPrompt", () => {
  it("wraps the current channel message with context-focus instructions", () => {
    const prompt = buildChannelTurnPrompt("画一个新集群的报告");
    expect(prompt).toContain("<channel-turn>");
    expect(prompt).toContain("current user request");
    expect(prompt).toContain("Do not force the previous case");
    expect(prompt).toContain("画一个新集群的报告");
  });

  it("no shared context: no group-discussion block or asker attribution", () => {
    const prompt = buildChannelTurnPrompt("hello");
    expect(prompt).not.toContain("<group-discussion");
    expect(prompt).not.toContain("is now asking");
    expect(prompt).not.toContain("SHARED group");
  });

  it("shared: injects an attributed discussion transcript before the asker's request", () => {
    const prompt = buildChannelTurnPrompt("what's the root cause?", {
      discussion: [
        { sender: "…abc123", text: "node-5 is NotReady" },
        { sender: "…def456", text: "kubelet keeps crashing" },
      ],
      truncated: false,
      asker: "…ghi789",
    });
    expect(prompt).toContain("SHARED group");
    expect(prompt).toContain("<group-discussion>");
    expect(prompt).toContain("[…abc123] node-5 is NotReady");
    expect(prompt).toContain("[…def456] kubelet keeps crashing");
    expect(prompt).toContain("[…ghi789] is now asking:");
    // The discussion block precedes the current request.
    expect(prompt.indexOf("<group-discussion>")).toBeLessThan(prompt.indexOf("is now asking"));
    expect(prompt.indexOf("kubelet keeps crashing")).toBeLessThan(prompt.indexOf("what's the root cause?"));
  });

  it("shared with no buffered chatter: attributes the asker, no discussion block", () => {
    const prompt = buildChannelTurnPrompt("hi", { discussion: [], truncated: false, asker: "…xyz" });
    expect(prompt).not.toContain("<group-discussion");
    expect(prompt).toContain("[…xyz] is now asking:");
  });

  it("shared truncated: notes older messages were dropped", () => {
    const prompt = buildChannelTurnPrompt("go", {
      discussion: [{ sender: "…a", text: "m" }],
      truncated: true,
      asker: "…b",
    });
    expect(prompt).toContain("older messages were dropped");
  });
});

// ── collectResponse ────────────────────────────────────────────────

// ── handleLarkMessage × streaming card integration ────────────────

describe("handleLarkMessage — streaming card flow", () => {
  function makeCardAwareLarkClient() {
    return {
      im: {
        image: { create: vi.fn().mockResolvedValue({ image_key: "img-chart-1" }) },
        message: { reply: vi.fn().mockResolvedValue({}) },
      },
      cardkit: {
        v1: {
          card: {
            create: vi.fn().mockResolvedValue({ data: { card_id: "CARD-99" } }),
            settings: vi.fn().mockResolvedValue({ code: 0 }),
          },
          cardElement: {
            content: vi.fn().mockResolvedValue({ code: 0 }),
          },
        },
      },
    };
  }

  it("opens typing card before agent runs, then finalizes with the final assistant text", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-int" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "最终答复 **加粗**" }],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    // Card opened BEFORE reply (typing indicator path)
    expect(lark.cardkit.v1.card.create).toHaveBeenCalledTimes(1);
    expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
    const replyArg = lark.im.message.reply.mock.calls[0][0];
    expect(replyArg.data.msg_type).toBe("interactive");
    expect(JSON.parse(replyArg.data.content)).toMatchObject({
      type: "card",
      data: { card_id: "CARD-99" },
    });

    // Card finalized with the assistant text + streaming mode disabled
    expect(lark.cardkit.v1.cardElement.content).toHaveBeenCalledTimes(1);
    expect(lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content).toContain("最终答复");
    expect(lark.cardkit.v1.card.settings).toHaveBeenCalledTimes(1);
    const settingsPayload = JSON.parse(lark.cardkit.v1.card.settings.mock.calls[0][0].data.settings);
    expect(settingsPayload.config.streaming_mode).toBe(false);
    expect(lark.im.image.create).not.toHaveBeenCalled();
  });

  it("updates the Lark card when a background channel report arrives after the first SSE turn", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-background" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已经启动检查，完成后汇总。" }],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );
    const sessionId = promptMock.mock.calls[0][0].sessionId;

    const finalReport = [
      "# 集群节点健康报告",
      "",
      "所有节点 Ready，但 nodepool-061 存在 GPFS 访问 Warning，需要排查存储挂载。",
      "",
      "| 节点 | 状态 | 结论 |",
      "| --- | --- | --- |",
      "| nodepool-061 | Ready | 有 GPFS Warning |",
    ].join("\n");
    await deliverBackgroundChannelMessage({
      sessionId,
      role: "assistant",
      content: finalReport,
    });
    await deliverBackgroundChannelMessage({
      sessionId,
      role: "assistant",
      content: "Worker 子代理没有新发现，无需补充。",
    });

    const contentCalls = lark.cardkit.v1.cardElement.content.mock.calls;
    expect(contentCalls.at(-1)[0].data.content).toContain("集群节点健康报告");
    expect(contentCalls.at(-1)[0].data.content).toContain("GPFS");
    expect(contentCalls).toHaveLength(2);
    clearBackgroundChannelDelivery(sessionId);
  });

  it("surfaces foreground sub-agent progress (tool_execution_update) as a live card step", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-fg-progress" });
    streamEventsMock.mockImplementation(async function* () {
      // Group progress carries structured details.items; the card localizes it (tool text is
      // hard-coded English, so we render N/M from items in the channel locale).
      yield {
        type: "tool_execution_update",
        toolCallId: "t1",
        partialResult: {
          content: [{ type: "text", text: "Running sub-agents… 2/3 done" }],
          details: { phase: "map", items: [{ status: "done" }, { status: "done" }, { status: "running" }] },
        },
      };
      yield {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "统一结论：GPFS 抖动。" }] },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(makeTextEvent("排查"), lark, "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);

    const contentCalls = lark.cardkit.v1.cardElement.content.mock.calls.map((c: any) => c[0].data.content as string);
    // Localized (zh-CN default) progress step, computed from items (2 done / 3 total).
    expect(contentCalls.some((c) => c.includes("子任务执行中") && c.includes("2/3") && c.includes("⏳"))).toBe(true);
    // Not the raw English activity text.
    expect(contentCalls.some((c) => c.includes("Running sub-agents"))).toBe(false);
    expect(contentCalls.at(-1)).toContain("统一结论");
  });

  it("shows only the latest step on the card and replaces it with the conclusion on finalize", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-explicit-channel" });
    let releaseStream: () => void = () => {};
    const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
    streamEventsMock.mockImplementation(async function* () {
      await streamGate;
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "最终结论：检查完成。" }],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    const handlePromise = handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    await waitForExpect(() => expect(promptMock).toHaveBeenCalledTimes(1));
    const sessionId = promptMock.mock.calls[0][0].sessionId;

    try {
      await expect(deliverChannelVisibleMessage({
        sessionId,
        kind: "milestone",
        text: "里程碑 1：已拿到节点列表。",
      })).resolves.toBe(true);
      await expect(deliverChannelVisibleMessage({
        sessionId,
        kind: "artifact",
        text: "产物提示：已生成诊断草稿。",
      })).resolves.toBe(true);
      await expect(deliverChannelVisibleMessage({
        sessionId,
        kind: "milestone",
        text: "这条应该被 Gateway 策略压掉。",
      })).resolves.toBe(true);

      const inFlightContentCalls = lark.cardkit.v1.cardElement.content.mock.calls;
      // The card shows ONLY the single latest step — no accumulating checklist.
      // Each delivery replaces the previous step in place.
      expect(inFlightContentCalls).toHaveLength(3);
      const latest = inFlightContentCalls[2][0].data.content as string;
      expect(latest).toContain("压掉"); // only the latest step is shown
      expect(latest).toContain("⏳"); // marked in progress
      expect(latest).not.toContain("里程碑 1"); // earlier steps are gone
      expect(latest).not.toContain("产物提示");
      expect(latest).not.toContain("✅"); // no done-checklist
      expect(lark.cardkit.v1.card.settings).not.toHaveBeenCalled();
      expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
      expect(lark.im.message.reply.mock.calls[0][0].data.msg_type).toBe("interactive");
    } finally {
      releaseStream();
      await handlePromise;
      clearBackgroundChannelDelivery(sessionId);
    }

    const contentCalls = lark.cardkit.v1.cardElement.content.mock.calls;
    // 3 step updates + 1 final = 4 content writes.
    expect(contentCalls).toHaveLength(4);
    const finalContent = contentCalls.at(-1)[0].data.content as string;
    // The final card is JUST the conclusion — the step trail is gone.
    expect(finalContent).toContain("最终结论");
    expect(finalContent).not.toContain("里程碑 1");
    expect(finalContent).not.toContain("压掉");
    expect(finalContent).not.toContain("⏳");
    expect(lark.cardkit.v1.card.settings).toHaveBeenCalledTimes(1);
  });

  it("keeps numeric tables in markdown and does not synthesize chart images", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-chart" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: [
              "统计如下：",
              "",
              "| Region | Count |",
              "|---|---:|",
              "| East | 12 |",
              "| West | 7 |",
            ].join("\n"),
          }],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    expect(lark.cardkit.v1.cardElement.content).toHaveBeenCalledTimes(1);
    const cardContent = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(cardContent).toContain("| Region | Count |");
    expect(lark.im.image.create).not.toHaveBeenCalled();
    expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
    expect(lark.im.message.reply.mock.calls[0][0].data.msg_type).toBe("interactive");
  });

  it("keeps fenced chart JSON visible when no PNG artifact is available", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-chart-json" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: [
              "结论：P1 事件最多。",
              "",
              "```chart",
              "{\"title\":\"Incidents\",\"labels\":[\"P0\",\"P1\"],\"values\":[1,4]}",
              "```",
            ].join("\n"),
          }],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const cardContent = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(cardContent).toContain("结论：P1 事件最多。");
    expect(cardContent).toContain("```chart");
    expect(cardContent).toContain("\"labels\"");
    expect(lark.im.image.create).not.toHaveBeenCalled();
    expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
  });

  it("keeps MCP bar chart specs visible when no PNG artifact is available", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-mcp-chart" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: [
              "统计结论：P1 集中在 East。",
              "",
              "```chart",
              JSON.stringify({
                type: "bar",
                title: "Incidents by Region",
                data: {
                  categories: ["East", "West"],
                  series: [{ name: "P1", values: [4, 2] }],
                },
              }),
              "```",
            ].join("\n"),
          }],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const cardContent = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(cardContent).toContain("统计结论");
    expect(cardContent).toContain("```chart");
    expect(cardContent).toContain("\"type\":\"bar\"");
    expect(lark.im.image.create).not.toHaveBeenCalled();
  });

  it("keeps Chart.js-style bar chart specs visible when no PNG artifact is available", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-chartjs-chart" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: [
              "```chart",
              JSON.stringify({
                type: "bar",
                data: {
                  labels: ["1月", "2月", "3月"],
                  datasets: [{ label: "销售额", data: [120, 190, 150] }],
                },
                options: {
                  plugins: {
                    title: { display: true, text: "2026 上半年销售额" },
                  },
                },
              }),
              "```",
            ].join("\n"),
          }],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const cardContent = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(cardContent).toContain("```chart");
    expect(cardContent).toContain("datasets");
    expect(lark.im.image.create).not.toHaveBeenCalled();
    expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
  });

  it("keeps unsupported chart JSON visible and does not reply with an image", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-unsupported-chart" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: [
              "```chart",
              JSON.stringify({
                type: "line",
                data: {
                  labels: ["1月", "2月"],
                  datasets: [{ label: "销售额", data: [120, 190] }],
                },
              }),
              "```",
            ].join("\n"),
          }],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const cardContent = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(cardContent).toContain("```chart");
    expect(cardContent).toContain("\"type\":\"line\"");
    expect(lark.im.image.create).not.toHaveBeenCalled();
    expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
  });

  it("keeps Mermaid flowcharts as markdown when no PNG artifact is available", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-mermaid" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: [
              "排查路径如下：",
              "",
              "```mermaid",
              "flowchart TD",
              "  A[Check pod] --> B{Ready?}",
              "  B -->|No| C[Inspect events]",
              "```",
            ].join("\n"),
          }],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const cardContent = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(cardContent).toContain("排查路径如下");
    expect(cardContent).toContain("```mermaid");
    expect(cardContent).toContain("flowchart TD");
    expect(lark.im.image.create).not.toHaveBeenCalled();
    expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
  });

  it("strips markdown data URI payloads from cards without treating them as sendable attachments", async () => {
    const onePixelPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-card-image" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: [
              "结论卡片如下：",
              "",
              `![card](${onePixelPng})`,
            ].join("\n"),
          }],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const cardContent = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(cardContent).toContain("结论卡片如下");
    expect(cardContent).not.toContain("data:image/png");
    expect(lark.im.image.create).not.toHaveBeenCalled();
  });

  it("forwards assistant image content blocks as Feishu images", async () => {
    const onePixelBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-assistant-image" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "图片如下：" },
            { type: "image", data: onePixelBase64, mimeType: "image/png" },
          ],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const cardContent = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(cardContent).toContain("图片如下");
    expect(cardContent).not.toContain("data:image/png");
    expect(lark.im.image.create).toHaveBeenCalledTimes(1);
    expect([...lark.im.image.create.mock.calls[0][0].data.image.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("forwards tool image artifacts and hides paired visual source blocks from the card", async () => {
    const onePixelBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-tool-image" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "tool_execution_end",
        toolName: "render_mermaid",
        result: {
          content: [{ type: "image", data: onePixelBase64, mimeType: "image/png" }],
        },
      };
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: [
              "流程图如下：",
              "",
              "```mermaid",
              "flowchart TD",
              "A[Start] --> B[Done]",
              "```",
            ].join("\n"),
          }],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const cardContent = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(cardContent).toContain("流程图如下");
    expect(cardContent).not.toContain("```mermaid");
    expect(cardContent).not.toContain("data:image/png");
    expect(lark.im.image.create).toHaveBeenCalledTimes(1);
    expect(lark.im.message.reply).toHaveBeenCalledTimes(2);
  });

  it("keeps Sicore visual-card source as markdown when no PNG artifact is available", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-visual-card" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: [
              "结论：api pods 正在因配置变更反复重启。",
              "",
              "```visual-card",
              JSON.stringify({
                type: "report",
                title: "CrashLoopBackOff in prod",
                tone: "danger",
                conclusion: "api pods are restarting after the latest config rollout.",
                items: [{ label: "Affected pods", status: "danger", value: "3", note: "namespace prod" }],
                sections: [{ type: "notes", title: "Evidence", items: ["ConfigMap changed before the first restart"] }],
              }),
              "```",
            ].join("\n"),
          }],
        },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const cardContent = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(cardContent).toContain("api pods");
    expect(cardContent).toContain("```visual-card");
    expect(cardContent).toContain("CrashLoopBackOff in prod");
    expect(lark.im.image.create).not.toHaveBeenCalled();
    expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
  });

  it("does not reply with an image when the final answer has no image artifact", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-no-chart" });
    streamEventsMock.mockImplementation(async function* () {
      yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "只是普通文本答复" }] } };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    expect(lark.cardkit.v1.cardElement.content).toHaveBeenCalledTimes(1);
    expect(lark.im.image.create).not.toHaveBeenCalled();
    expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
  });

  it("keeps the markdown card successful when image upload returns no key", async () => {
    const onePixelBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-image-fail" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "图片如下：" },
            { type: "image", data: onePixelBase64, mimeType: "image/png" },
          ],
        },
      };
    });
    const lark = makeCardAwareLarkClient();
    lark.im.image.create.mockResolvedValueOnce({});

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    expect(lark.cardkit.v1.cardElement.content).toHaveBeenCalledTimes(1);
    expect(lark.im.image.create).toHaveBeenCalledTimes(1);
    expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
    expect(lark.im.message.reply.mock.calls[0][0].data.msg_type).toBe("interactive");
  });

  it("falls back to plain text reply when card.create fails (preserves the pre-card UX)", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-fb" });
    streamEventsMock.mockImplementation(async function* () {
      yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "答复" }] } };
    });
    const lark = makeCardAwareLarkClient();
    lark.cardkit.v1.card.create.mockRejectedValueOnce(new Error("403 cardkit forbidden"));

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    // No card finalize attempted
    expect(lark.cardkit.v1.cardElement.content).not.toHaveBeenCalled();
    expect(lark.cardkit.v1.card.settings).not.toHaveBeenCalled();
    // Plain text reply instead
    expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
    const replyArg = lark.im.message.reply.mock.calls[0][0];
    expect(replyArg.data.msg_type).toBe("text");
    expect(JSON.parse(replyArg.data.content).text).toBe("答复");
  });

  it("shows a sanitized error notice (never the raw error) when the agent throws", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockRejectedValue(new Error("AgentBox unreachable https://agentbox-internal:8443"));
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    expect(lark.cardkit.v1.cardElement.content).toHaveBeenCalledTimes(1);
    const contentText = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(contentText).toContain("\u5904\u7406\u65F6\u51FA\u9519\u4E86");
    // Raw error / internal endpoint must NOT leak to the chat.
    expect(contentText).not.toContain("AgentBox unreachable");
    expect(contentText).not.toContain("agentbox-internal");
  });

  it("retries a 409 then succeeds \u2014 never surfaces the raw 409", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    const busy = Object.assign(new Error('AgentBox request failed: 409 {"error":"Session is already running."}'), { status: 409 });
    promptMock.mockRejectedValueOnce(busy).mockResolvedValueOnce({ sessionId: "s-retry" });
    streamEventsMock.mockImplementation(async function* () {
      yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "\u7ED3\u8BBA\u597D\u4E86" }] } };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(makeTextEvent("\u7ED3\u8BBA\u662F\u5565"), lark, "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);

    expect(promptMock).toHaveBeenCalledTimes(2); // one 409, one success
    const last = lark.cardkit.v1.cardElement.content.mock.calls.at(-1)?.[0].data.content ?? "";
    expect(last).toContain("\u7ED3\u8BBA\u597D\u4E86");
    expect(last).not.toContain("409");
  });

  it("shows a friendly busy notice when 409 persists past the retry window", async () => {
    vi.useFakeTimers();
    try {
      resolveBindingMock.mockResolvedValue(makeBinding());
      const busy = Object.assign(new Error('AgentBox request failed: 409 {"error":"Session is already running."}'), { status: 409 });
      promptMock.mockRejectedValue(busy); // always busy \u2192 retry window elapses
      const lark = makeCardAwareLarkClient();

      const p = handleLarkMessage(makeTextEvent("\u7ED3\u8BBA\u662F\u5565"), lark, "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);
      await vi.runAllTimersAsync(); // fast-forward the backoff until the retry cap is hit
      await p;

      const contentText = lark.cardkit.v1.cardElement.content.mock.calls.at(-1)?.[0].data.content ?? "";
      expect(contentText).toContain("\u8FD8\u5728\u5904\u7406\u4E0A\u4E00\u6761");
      expect(contentText).not.toContain("409");
      expect(contentText).not.toContain("already running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still sends the busy notice via text reply when CardKit creation fails + 409 persists", async () => {
    vi.useFakeTimers();
    try {
      resolveBindingMock.mockResolvedValue(makeBinding());
      const busy = Object.assign(new Error('AgentBox request failed: 409 {"error":"Session is already running."}'), { status: 409 });
      promptMock.mockRejectedValue(busy);
      // CardKit create returns no card_id \u2192 openTypingCard yields null cardSession \u2192 the reply
      // must fall through to a plain-text busy notice (regression: sessionBusy was missing from
      // the fallback condition, so nothing was sent).
      const lark = {
        im: { image: { create: vi.fn() }, message: { reply: vi.fn().mockResolvedValue({}) } },
        cardkit: {
          v1: {
            card: { create: vi.fn().mockResolvedValue({ data: {} }), settings: vi.fn().mockResolvedValue({ code: 0 }) },
            cardElement: { content: vi.fn().mockResolvedValue({ code: 0 }) },
          },
        },
      };

      const p = handleLarkMessage(makeTextEvent("\u7ED3\u8BBA\u662F\u5565"), lark as any, "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);
      await vi.runAllTimersAsync();
      await p;

      expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
      const replyText = JSON.parse(lark.im.message.reply.mock.calls[0][0].data.content).text as string;
      expect(replyText).toContain("\u8FD8\u5728\u5904\u7406\u4E0A\u4E00\u6761");
      expect(replyText).not.toContain("409");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders English placeholder when the channel domain is 'lark' (global)", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-en" });
    streamEventsMock.mockImplementation(async function* () {
      yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hi"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "en-US",
    );

    const createArg = lark.cardkit.v1.card.create.mock.calls[0][0];
    const cardJson = JSON.parse(createArg.data.data);
    expect(cardJson.body.elements[0].content).toContain("Thinking");
  });

  it("renders English empty-result notice when agent returns nothing and locale is en-US", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-en-empty" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hi"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "en-US",
    );

    const contentText = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(contentText).toMatch(/agent|response/i);
  });

  it("shows the empty-result notice when the agent returns no text", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-empty" });
    streamEventsMock.mockImplementation(async function* () { /* no assistant messages */ });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const contentText = lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content;
    expect(contentText).toContain("\u26A0");  // warning emoji in EMPTY_RESULT_NOTICE
  });
});

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

  it("surfaces intermediate assistant turns as milestones (first line), keeping the last as the answer", async () => {
    const events = [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "## 先看 node 状态\n详细…" }] } },
      { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "{...}" }] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "node 正常,继续查 `sichek`" }] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "结论:GPU#3 fatal,建议换卡。" }] } },
    ];
    const milestones: string[] = [];
    const collected = await collectChannelResponse(fakeClient(events), "s-ms", "lark", {
      onMilestone: (m) => milestones.push(m),
    });
    // Only the two NON-final assistant turns become milestones; heading marker
    // stripped, first line only, inline code kept.
    expect(milestones).toEqual(["先看 node 状态", "node 正常,继续查 `sichek`"]);
    // The final turn is the answer, not a milestone.
    expect(collected.text).toBe("结论:GPU#3 fatal,建议换卡。");
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

  it("captures assistant image blocks as structured attachments when requested", async () => {
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Generated image:" },
            { type: "image", data: "aW1n", mimeType: "image/png" },
          ],
        },
      },
    ];
    const collected = await collectChannelResponse(fakeClient(events), "s6", "lark", { includeImages: true });
    expect(collected.text).toBe("Generated image:");
    expect(collected.images).toHaveLength(1);
    expect(collected.images[0].mimeType).toBe("image/png");
    expect(collected.images[0].image.toString("base64")).toBe("aW1n");
  });

  it("collects tool image artifacts separately from the final assistant text", async () => {
    const events = [
      {
        type: "tool_execution_end",
        result: {
          content: [
            { type: "text", text: "rendered" },
            { type: "image", data: "aW1n", mimeType: "image/png" },
          ],
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is the chart." }],
        },
      },
    ];
    const collected = await collectChannelResponse(fakeClient(events), "s7", "lark", { includeImages: true });
    expect(collected.text).toBe("Here is the chart.");
    expect(collected.images).toHaveLength(1);
    expect(collected.images[0].image.toString("base64")).toBe("aW1n");
  });

  it("captures toolResult message image blocks as structured attachments", async () => {
    const events = [
      {
        type: "message_end",
        message: {
          role: "toolResult",
          content: [
            { type: "text", text: "rendered" },
            { type: "image", data: "aW1n", mimeType: "image/png" },
          ],
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is the chart." }],
        },
      },
    ];
    const collected = await collectChannelResponse(fakeClient(events), "s8", "lark", { includeImages: true });
    expect(collected.text).toBe("Here is the chart.");
    expect(collected.images).toHaveLength(1);
    expect(collected.images[0].image.toString("base64")).toBe("aW1n");
  });

  it("does not expose image blocks to non-image channel collectors by default", async () => {
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Generated image:" },
            { type: "image", data: "aW1n", mimeType: "image/png" },
          ],
        },
      },
    ];
    const text = await collectResponse(fakeClient(events), "s9");
    expect(text).toBe("Generated image:");
  });
});

describe("collectChannelResponse — audit persistence", () => {
  function fakeClient(events: unknown[]) {
    return { streamEvents: async function* () { for (const e of events) yield e; } } as any;
  }

  it("persists every assistant turn + each tool call when persist is set", async () => {
    const events = [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Checking nodes" }] } },
      { type: "tool_execution_start", toolName: "bash", args: { command: "kubectl get nodes" } },
      { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "node ok" }], details: {} } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All healthy." }] } },
    ];
    const collected = await collectChannelResponse(fakeClient(events), "s-audit", "lark", { persist: { agentId: "a1" } });
    // Reply text is still the final assistant turn.
    expect(collected.text).toBe("All healthy.");

    const calls = appendMessageMock.mock.calls.map((c) => c[0] as any);
    expect(calls.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["Checking nodes", "All healthy."]);
    const toolRows = calls.filter((m) => m.role === "tool");
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]).toMatchObject({ sessionId: "s-audit", toolName: "bash", outcome: "success" });
    expect(toolRows[0].toolInput).toContain("kubectl get nodes");
    expect(toolRows[0].content).toBe("node ok");
  });

  it("does NOT persist anything when persist is omitted (reply-only path)", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", args: {} },
      { type: "tool_execution_end", toolName: "bash", result: { content: [], details: {} } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    ];
    await collectChannelResponse(fakeClient(events), "s-nop", "lark", {});
    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  it("derives tool outcome (error / blocked) from result.details", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", args: {} },
      { type: "tool_execution_end", toolName: "bash", result: { content: [], details: { error: "boom" } } },
      { type: "tool_execution_start", toolName: "pod_exec", args: {} },
      { type: "tool_execution_end", toolName: "pod_exec", result: { content: [], details: { blocked: true } } },
    ];
    await collectChannelResponse(fakeClient(events), "s-out", "lark", { persist: { agentId: "a1" } });
    const toolRows = appendMessageMock.mock.calls.map((c) => c[0] as any).filter((m) => m.role === "tool");
    expect(toolRows.map((m) => m.outcome)).toEqual(["error", "blocked"]);
  });

  it("a persist failure does not break the reply (best-effort)", async () => {
    appendMessageMock.mockRejectedValueOnce(new Error("db down"));
    const events = [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "still replies" }] } },
    ];
    const collected = await collectChannelResponse(fakeClient(events), "s-fail", "lark", { persist: { agentId: "a1" } });
    expect(collected.text).toBe("still replies");
  });
});

// ── Inbound images (text URLs + native lark) ───────────────────────────────

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const PNG_B64 = PNG_BYTES.toString("base64");

/** Lark client whose receive-side resource API returns a PNG stream. */
function makeLarkClientWithResource() {
  return {
    im: {
      message: { reply: vi.fn().mockResolvedValue({}) },
      messageResource: {
        get: vi.fn().mockResolvedValue({
          getReadableStream: () => Readable.from([PNG_BYTES]),
          writeFile: vi.fn(),
          headers: {},
        }),
      },
    },
  };
}

function makeImageEvent(imageKey: string, overrides: Record<string, unknown> = {}) {
  return {
    sender: { sender_id: { open_id: "ou_user_1" } },
    message: {
      message_id: "mid-img",
      chat_id: "oc_abc123",
      message_type: "image",
      content: JSON.stringify({ image_key: imageKey }),
      ...overrides,
    },
  };
}

function makePostEvent(text: string, imageKey: string) {
  return {
    sender: { sender_id: { open_id: "ou_user_1" } },
    message: {
      message_id: "mid-post",
      chat_id: "oc_abc123",
      message_type: "post",
      content: JSON.stringify({
        title: "",
        content: [[{ tag: "text", text }, { tag: "img", image_key: imageKey }]],
      }),
    },
  };
}

describe("handleLarkMessage — inbound images", () => {
  // Native images are vision-gated now; default the binding to a vision-capable model.
  const VISION_BINDING = {
    modelProvider: "openai",
    modelId: "gpt-4o",
    modelConfig: {
      name: "p", baseUrl: "", apiKey: "", api: "openai", authHeader: false,
      models: [{ id: "gpt-4o", name: "gpt-4o", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
    },
  };
  beforeEach(() => {
    resolveAgentModelBindingMock.mockResolvedValue(VISION_BINDING);
  });

  it("native image message → prompt carries images + placeholder text persisted", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ agentId: "a1", sessionId: "session-fixed" }));
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(
      makeImageEvent("img_k1"),
      makeLarkClientWithResource(),
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    expect(promptMock).toHaveBeenCalledWith(expect.objectContaining({
      images: [{ mimeType: "image/png", data: PNG_B64 }],
      mode: "channel",
    }));
    // image-only message → placeholder, not an empty user row
    expect(appendMessageMock).toHaveBeenCalledWith(expect.objectContaining({ role: "user", content: "[image]" }));
  });

  it("post with embedded image → prompt carries images AND the caption text", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ agentId: "a1", sessionId: "session-fixed" }));
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(
      makePostEvent("look at this error", "img_k2"),
      makeLarkClientWithResource(),
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const arg = promptMock.mock.calls[0][0];
    expect(arg.images).toEqual([{ mimeType: "image/png", data: PNG_B64 }]);
    expect(arg.text).toContain("look at this error");
  });

  it("native image + non-vision model → no images attached, placeholder still recorded", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ agentId: "a1", sessionId: "session-fixed" }));
    resolveAgentModelBindingMock.mockResolvedValue({
      modelProvider: "deepseek",
      modelId: "deepseek-chat",
      modelConfig: {
        name: "p", baseUrl: "", apiKey: "", api: "openai", authHeader: false,
        models: [{ id: "deepseek-chat", name: "deepseek-chat", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
      },
    });
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(
      makeImageEvent("img_k1"),
      makeLarkClientWithResource(),
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const arg = promptMock.mock.calls[0][0];
    // non-vision → native image not downloaded/attached (mirrors the text-URL path),
    // but the placeholder still records that the user sent an image
    expect(arg).not.toHaveProperty("images");
    expect(appendMessageMock).toHaveBeenCalledWith(expect.objectContaining({ role: "user", content: "[image]" }));
    // and the prompt tells the model an image was attached but can't be read
    expect(arg.text).toContain("cannot read images");
  });

  it("text image URL → left in prompt text for the unified layer (lark no longer resolves it)", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ agentId: "a1", sessionId: "session-fixed" }));
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(
      makeTextEvent("check this https://oss.siflow.cn/x.png"),
      makeLarkClient(),
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    // The channel hands the raw URL text to AgentBoxClient.prompt; URL→image
    // resolution (vision-gated) happens THERE, not in the channel. So no images
    // are attached here, and the URL survives in the prompt text.
    const arg = promptMock.mock.calls[0][0];
    expect(arg).not.toHaveProperty("images");
    expect(arg.text).toContain("https://oss.siflow.cn/x.png");
  });

  it("persists the user row with signed-URL credentials stripped (prompt keeps the full URL)", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ agentId: "a1", sessionId: "session-fixed" }));
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(
      makeTextEvent("look https://oss.siflow.cn/x.png?Signature=secret"),
      makeLarkClient(),
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const userRow = appendMessageMock.mock.calls.find((c) => c[0].role === "user")?.[0];
    expect(userRow.content).toContain("oss.siflow.cn/x.png");
    expect(userRow.content).not.toContain("Signature"); // creds stripped from the persisted row
    // the prompt forwarded to AgentBoxClient keeps the full signed URL (client.prompt fetches it)
    expect(promptMock.mock.calls[0][0].text).toContain("Signature=secret");
  });
});

describe("extractInbound — post receive shapes", () => {
  it("parses locale-nested post content instead of silently dropping it", () => {
    const message = {
      message_type: "post",
      content: JSON.stringify({
        zh_cn: { title: "Title", content: [[{ tag: "text", text: "hello" }, { tag: "img", image_key: "img_k9" }]] },
      }),
    };
    const { text, imageRefs } = extractInbound(message);
    expect(imageRefs).toEqual([{ imageKey: "img_k9" }]);
    expect(text).toContain("hello");
    expect(text).toContain("Title"); // title surfaced
  });

  it("parses the flat post shape and surfaces a hyperlink href + title", () => {
    const message = {
      message_type: "post",
      content: JSON.stringify({
        title: "Report",
        content: [[{ tag: "a", text: "see", href: "https://oss.siflow.cn/x.png" }]],
      }),
    };
    const { text } = extractInbound(message);
    expect(text).toContain("Report");
    expect(text).toContain("see");
    expect(text).toContain("https://oss.siflow.cn/x.png"); // href surfaced for the unified URL resolver
  });
});
