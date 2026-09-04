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
const issuePersonalApiKeyMock = vi.fn();
const getPersonalApiKeyStatusMock = vi.fn();
const issuePersonalWebChatLinkMock = vi.fn();

vi.mock("../channel-manager.js", () => ({
  resolveBinding: (...args: unknown[]) => resolveBindingMock(...args),
  handlePairingCode: (...args: unknown[]) => handlePairingCodeMock(...args),
  resetBindingSession: (...args: unknown[]) => resetBindingSessionMock(...args),
  resolvePersonalBinding: (...args: unknown[]) => resolvePersonalBindingMock(...args),
  handlePersonalPairingCode: (...args: unknown[]) => handlePersonalPairingCodeMock(...args),
  resetPersonalSession: (...args: unknown[]) => resetPersonalSessionMock(...args),
  issuePersonalApiKey: (...args: unknown[]) => issuePersonalApiKeyMock(...args),
  getPersonalApiKeyStatus: (...args: unknown[]) => getPersonalApiKeyStatusMock(...args),
  issuePersonalWebChatLink: (...args: unknown[]) => issuePersonalWebChatLinkMock(...args),
  updateBindingMeta: (...args: unknown[]) => updateBindingMetaMock(...args),
  setChannelContextMode: (...args: unknown[]) => setChannelContextModeMock(...args),
  isChannelAccessDenied: (v: unknown) =>
    v !== null && typeof v === "object" && (v as { walled?: unknown }).walled === true,
  // Pure tier normalization shared with the Portal adapter — use the real thing, not a stub, so a
  // divergence between the two layers would actually fail here.
  isOpenAccessTier: (mode: unknown) => {
    const m = typeof mode === "string" ? mode.trim().toLowerCase() : "";
    return m === "public" || m === "open";
  },
}));

const resolveAgentModelBindingMock = vi.fn();

vi.mock("../agent-model-binding.js", () => ({
  resolveAgentModelBinding: (...args: unknown[]) => resolveAgentModelBindingMock(...args),
}));

const ensureChatSessionMock = vi.fn();
const appendMessageMock = vi.fn();
const bindMessageTraceIdMock = vi.fn();

const recordChannelFeedbackMock = vi.fn();

vi.mock("../chat-repo.js", () => ({
  validTraceId: (v: unknown) => (typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? v : undefined),
  warnTraceBindFailure: vi.fn(),
  ensureChatSession: (...args: unknown[]) => ensureChatSessionMock(...args),
  appendMessage: (...args: unknown[]) => appendMessageMock(...args),
  bindMessageTraceId: (...args: unknown[]) => bindMessageTraceIdMock(...args),
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

function makeLarkClient(
  threadMessages?: any[],
  rootMessage?: any,
) {
  const client: any = {
    im: {
      message: {
        reply: vi.fn().mockResolvedValue({}),
        ...(rootMessage ? {
          get: vi.fn().mockResolvedValue({
            data: { items: [rootMessage] },
          }),
        } : {}),
        ...(threadMessages ? {
          list: vi.fn().mockResolvedValue({
            data: { items: threadMessages, has_more: false },
          }),
        } : {}),
      },
    },
  };
  return client;
}

function makeTopicLarkClient(
  humanIds: string[] = ["ou_user_1"],
  appIds: string[] = ["x"],
) {
  return makeLarkClient([
    ...humanIds.slice(1).map((id, index) => ({
      message_id: `mid-human-reply-${index}`,
      sender: { id, sender_type: "user" },
    })),
    ...appIds.map((id, index) => ({
      message_id: `mid-app-${index}`,
      sender: { id, sender_type: "app" },
    })),
  ], {
    message_id: "mid-root",
    sender: { id: humanIds[0], sender_type: "user" },
  });
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

function makeTextEvent(
  text: string,
  overrides: Record<string, unknown> = {},
  senderOpenId = "ou_user_1",
  senderType?: string,
) {
  return {
    // EventDispatcher has already spread event.* onto the top level here.
    sender: {
      sender_id: {
        open_id: senderOpenId,
      },
      ...(senderType ? { sender_type: senderType } : {}),
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

/** The personal wrapper returns {binding, denied}; group callers still get the bare binding. */
function wrapBinding(binding: unknown) {
  return { binding };
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
  accessMode: "open" | "platform_authorized" = "open",
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
  issuePersonalApiKeyMock.mockReset();
  getPersonalApiKeyStatusMock.mockReset();
  issuePersonalWebChatLinkMock.mockReset();
  resolveAgentModelBindingMock.mockReset();
  ensureChatSessionMock.mockReset();
  appendMessageMock.mockReset();
  bindMessageTraceIdMock.mockReset();
  bindMessageTraceIdMock.mockResolvedValue(undefined);
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
    resolvePersonalBindingMock.mockResolvedValue(wrapBinding(makeBinding({
      bindingId: "pb-1",
      sessionId: "session-open-ou1",
      sessionKey: "open_id:ou_user_1",
      routeType: "user",
      createdBy: "owner-1",
    })));
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
    resolvePersonalBindingMock.mockResolvedValue(wrapBinding(makeBinding({
      bindingId: "personal-bot-1",
      sessionId: "session-open-ou1",
      sessionKey: "open_id:ou_user_1",
      routeType: "user",
      createdBy: "owner-1",
    })));
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

    expect(resolvePersonalBindingMock).toHaveBeenCalledWith("personal-bot-1", "ou_user_1", expect.anything(), undefined);
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

  it("a gated tier with no refusal reason still answers, with the console URL when configured", async () => {
    resolvePersonalBindingMock.mockResolvedValue({ binding: null });
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("查一下集群", { chat_type: "p2p" }),
      lark,
      "personal-bot-1",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      makePersonalConfig("platform_authorized", { authorize_url: "https://control-plane.example/siclaw/a1?tab=channels" }),
    );

    expect(promptMock).not.toHaveBeenCalled();
    const reply = lark.im.message.reply.mock.calls[0][0].data.content as string;
    // Generic notice: what makes a refusal specific is the frontend's `denied`, not the tier name.
    // The copy no longer names the system that holds the authorization — the sender doesn't need it.
    expect(reply).toContain("需要先获得授权");
    expect(reply).toContain("?tab=channels");   // console URL from config still appended
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
      makePersonalConfig("platform_authorized"),
    );

    expect(handlePersonalPairingCodeMock).toHaveBeenCalledWith("ABC123", "personal-bot-1", "ou_user_1", expect.anything());
    expect(handlePairingCodeMock).not.toHaveBeenCalled();
    expect(lark.im.message.reply.mock.calls[0][0].data.content).toContain("授权成功");
  });

  it("forwards PAIR on any gated tier, not just the legacy spelling", async () => {
    // Keying this branch on `platform_authorized` alone told a gated bot's users "this bot is open,
    // no PAIR needed" and discarded their code — a gated bot described as public.
    for (const tier of ["identified", "granted", "some_future_tier"]) {
      handlePersonalPairingCodeMock.mockResolvedValue({ success: true, agentName: "Secure Agent" });
      const lark = makeLarkClient();
      await handleLarkMessage(
        makeTextEvent("PAIR abc123", { chat_type: "p2p" }),
        lark, "personal-bot-1", makeAgentBoxManager("a1") as any, undefined, {} as any,
        "zh-CN", makePersonalConfig(tier as any),
      );
      expect(handlePersonalPairingCodeMock, `tier=${tier}`).toHaveBeenCalled();
      expect(lark.im.message.reply.mock.calls[0][0].data.content, `tier=${tier}`).not.toContain("不需要 PAIR");
      handlePersonalPairingCodeMock.mockClear();
    }
  });

  it("still rejects PAIR on an open tier", async () => {
    const lark = makeLarkClient();
    await handleLarkMessage(
      makeTextEvent("PAIR abc123", { chat_type: "p2p" }),
      lark, "personal-bot-1", makeAgentBoxManager("a1") as any, undefined, {} as any,
      "zh-CN", makePersonalConfig("public" as any),
    );
    expect(handlePersonalPairingCodeMock).not.toHaveBeenCalled();
    expect(lark.im.message.reply.mock.calls[0][0].data.content).toContain("不需要 PAIR");
  });

  it("p2p /new resets only the current personal session", async () => {
    resolvePersonalBindingMock.mockResolvedValue(wrapBinding(makeBinding({
      bindingId: "personal-bot-1",
      sessionId: "old-personal",
      sessionKey: "platform_user:user-1",
      routeType: "user",
      createdBy: "user-1",
    })));
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
      makePersonalConfig("platform_authorized"),
    );

    expect(resetPersonalSessionMock).toHaveBeenCalledWith("personal-bot-1", "platform_user:user-1", expect.anything());
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
    expect(resolveBindingMock).toHaveBeenCalledWith(
      "lark",
      "oc_abc123",
      expect.anything(),
      "open_id:ou_user_1",
      "ou_user_1",
      undefined,
      false,
      undefined,   // sender_type — absent on a plain user event
    );
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

    expect(resolveBindingMock).toHaveBeenCalledWith(
      "lark",
      "oc_abc123",
      expect.anything(),
      "open_id:ou_user_1",
      "ou_user_1",
      undefined,
      false,
      undefined,   // sender_type — absent on a plain user event
    );
    expect(resolvePersonalBindingMock).not.toHaveBeenCalled();
  });

  it("authorized group: a walled sender gets a hint and no agent runs", async () => {
    resolveBindingMock.mockResolvedValue({ walled: true, reason: "unbound", authorizeUrl: "https://control-plane.example/auth" });
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
        personal_bot: { channel_id: "pb-1", agent_id: "a1", access_mode: "platform_authorized", owner_user_id: "owner-1" },
      },
    );

    const replyArg = lark.im.message.reply.mock.calls[0][0];
    const text = JSON.parse(replyArg.data.content).text as string;
    // Sent to the private chat, NOT handed a URL in front of the whole room: the group reply is
    // visible to everyone, and the real next step differs per sender (link vs request access) —
    // the DM resolves that and can deliver a single-use link, which must never be posted here.
    expect(text).toContain("私聊我");
    expect(text).not.toContain("http");   // no URL of any kind reaches the room
    expect(mgr.getOrCreate).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("group-only channel does NOT offer the linking page to an already-linked sender", async () => {
    // reason "denied" = linked but lacks agent access. Telling them to "complete authorization" on
    // the linking page points at something they already did — the same loop, different path.
    resolveBindingMock.mockResolvedValue({ walled: true, reason: "denied", authorizeUrl: "https://console.example/auth" });
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("hi"), lark, "lark-runtime", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN", { app_id: "cli_x", app_secret: "secret" },
    );

    const text = JSON.parse(lark.im.message.reply.mock.calls[0][0].data.content).text as string;
    expect(text).toContain("没有这个助手的使用权限");
    expect(text).toContain("管理员");
    expect(text).not.toContain("https://console.example/auth");
  });

  it("keeps the console URL when the personal bot is open — the DM could not help", async () => {
    // An `open` personal bot binds on first message and offers no authorization step, so "DM me"
    // would be a dead end while removing the only path the sender had.
    resolveBindingMock.mockResolvedValue({ walled: true, reason: "unbound", authorizeUrl: "https://console.example/auth" });
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("hi"), lark, "lark-runtime", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN",
      {
        app_id: "cli_x", app_secret: "secret", group_channel_id: "lark:personal:pb-1",
        personal_bot: { channel_id: "pb-1", agent_id: "a1", access_mode: "open", owner_user_id: "o1" },
      },
    );

    const text = JSON.parse(lark.im.message.reply.mock.calls[0][0].data.content).text as string;
    expect(text).not.toContain("私聊我");
    expect(text).toContain("https://console.example/auth");
  });

  it("group-only channel keeps the console URL — there is no DM that would answer", async () => {
    resolveBindingMock.mockResolvedValue({ walled: true, reason: "unbound", authorizeUrl: "https://console.example/auth" });
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("hi"), lark, "lark-runtime", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN",
      // No personal_bot: telling this sender to DM would send them somewhere that never replies.
      { app_id: "cli_x", app_secret: "secret" },
    );

    const text = JSON.parse(lark.im.message.reply.mock.calls[0][0].data.content).text as string;
    expect(text).not.toContain("私聊我");
    // The URL is the sender's OWN authorization page, so the copy tells them to open it rather
    // than sending them to an admin who cannot link their account for them.
    expect(text).toContain("请打开下面的链接");
    expect(text).not.toContain("管理员");
    expect(text).toContain("https://console.example/auth");
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

    // Pod IDENTITY is the agentId alone — no userId leakage. The third argument is the
    // SESSION id, which only chooses WHICH box of that agent serves this conversation;
    // it never becomes part of a pod's name or certificate.
    expect(mgr.getOrCreate).toHaveBeenCalledWith("agent-7", undefined, "session-agent-7");

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
      modelProvider: "control-plane-custom-254e68c4",
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
      modelProvider: "control-plane-custom-254e68c4",
      modelId: "deepseek-ai/DeepSeek-V4-Pro",
      modelConfig,
      modelRouting,
      systemPromptTemplate: "custom prompt",
    }));
  });

  it("persists channel sessions/messages before prompting and wraps the current request", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({
      sessionId: "session-fixed",
      traceId: "0123456789abcdef0123456789abcdef",
    });
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
    expect(bindMessageTraceIdMock).toHaveBeenCalledWith(
      "msg-db-1",
      "session-fixed",
      "0123456789abcdef0123456789abcdef",
    );
  });

  it("records the raw open_id as the channel sender even for a platform_user session key", async () => {
    // siclaw has no remote-user concept: regardless of the server-issued session
    // key, the audit sender is always the raw open_id, stamped on the session.
    resolveBindingMock.mockResolvedValue(makeBinding({
      sessionKey: "platform_user:sender-99",
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
    // The OLD session id is passed so closeSession reaches the box that actually holds
    // it — a pooled agent has more than one, and closing on the wrong box would leave the
    // real session resident forever (pooled boxes never idle out).
    expect(mgr.getOrCreate).toHaveBeenCalledWith("a1", undefined, "old-session");
    expect(closeSessionMock).toHaveBeenCalledWith("old-session");
    expect(promptMock).not.toHaveBeenCalled();
    expect(lark.im.message.reply.mock.calls[0][0].data.content).toContain("已开启新会话");
  });

  it("/new resets the SERVER session key (authorized group → platform_user:<id>), not the local open_id", async () => {
    // Contract: the Runtime must reset whatever session key the resolver
    // returned, so an authorized group resets the sender's platform_user session
    // and an open group resets open_id:<sender> — never the local default.
    resolveBindingMock.mockResolvedValue(makeBinding({ sessionId: "old-session", sessionKey: "platform_user:u42" }));
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

    expect(resetBindingSessionMock).toHaveBeenCalledWith("lark", "oc_abc123", expect.anything(), "platform_user:u42");
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

  it("/new in a per-user topic resets only that user's topic session", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({
      sessionId: "topic-old",
      sessionKey: "open_id:ou_user_1:lark_thread:mid-1",
      contextMode: "per_user",
    }));
    resetBindingSessionMock.mockResolvedValue({
      success: true,
      agentId: "a1",
      oldSessionId: "topic-old",
      sessionId: "topic-new",
    });
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("/new", {
        chat_type: "group",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_self" } }],
      }),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      { app_id: "x", app_secret: "y" },
      "ou_bot_self",
    );

    expect(resetBindingSessionMock).toHaveBeenCalledWith(
      "lark",
      "oc_abc123",
      expect.anything(),
      "open_id:ou_user_1:lark_thread:mid-1",
    );
    expect(lark.im.message.reply.mock.calls[0][0].data.reply_in_thread).toBe(true);
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

  it("queues different participants in the same Topic behind one shared session", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({
      sessionId: "shared-topic-session",
      sessionKey: "lark_thread:mid-topic-root",
      contextMode: "topic",
    }));
    let releaseFirst!: () => void;
    promptMock
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ sessionId: "shared-topic-session" });
      }))
      .mockResolvedValueOnce({ sessionId: "shared-topic-session" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    const mgr = makeAgentBoxManager("a1");
    const botOpenId = "ou_bot_self";
    const config = { app_id: "x", app_secret: "y" } as const;

    const first = handleLarkMessage(
      makeTextEvent("@_user_1 first", {
        message_id: "mid-topic-root",
        chat_type: "group",
        mentions: [{ key: "@_user_1", id: { open_id: botOpenId } }],
      }, "ou_user_1"),
      makeLarkClient(),
      "lark",
      mgr as any,
      undefined,
      {} as any,
      "zh-CN",
      config,
      botOpenId,
    );
    await waitForExpect(() => expect(promptMock).toHaveBeenCalledTimes(1));

    const second = handleLarkMessage(
      makeTextEvent("second", {
        message_id: "mid-topic-followup",
        chat_type: "group",
        root_id: "mid-topic-root",
        thread_id: "omt-topic-1",
        mentions: [{ key: "@_user_1", id: { open_id: botOpenId } }],
      }, "ou_user_2", "user"),
      makeLarkClient(),
      "lark",
      mgr as any,
      undefined,
      {} as any,
      "zh-CN",
      config,
      botOpenId,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(promptMock).toHaveBeenCalledTimes(1);

    releaseFirst();
    await waitForExpect(() => expect(promptMock).toHaveBeenCalledTimes(2));
    await Promise.all([first, second]);
    expect(promptMock.mock.calls.map((call) => call[0].sessionId)).toEqual([
      "shared-topic-session",
      "shared-topic-session",
    ]);
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
          message_id: "msg-assistant-1",
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
      messageId: "msg-assistant-1",
      rating: "up",
      senderExternalId: "ou_clicker",
      channelId: "lark",
      source: "lark",
    });
  });

  it("keeps legacy cards without message_id compatible", async () => {
    recordChannelFeedbackMock.mockResolvedValue({ success: true });
    const data = makeCardAction();
    delete (data.action as any).value.message_id;

    const result = handleLarkCardAction(data, makeLarkClient());
    expect(result).toEqual({ toast: { type: "success", content: expect.any(String) } });
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

  it("accepts Topic mode and announces the closed Topic behavior", async () => {
    setChannelContextModeMock.mockResolvedValue({ success: true, mode: "topic" });
    const client = modeClient();
    const result = handleLarkCardAction(modeAction("topic"), client, { request: vi.fn() } as any);
    expect(result).toEqual({ toast: { type: "success", content: expect.stringContaining("话题模式") } });

    await flush();
    expect(setChannelContextModeMock).toHaveBeenCalledWith("ch1", "oc_group1", "topic", expect.anything());
    const announce = JSON.parse(client.im.message.create.mock.calls[0][0].data.content).text;
    expect(announce).toContain("该话题");
    expect(announce).toContain("仅有一名真人");
    expect(announce).toContain("每次调用都需要 @");
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

  // ── @-ed BY ANOTHER BOT ────────────────────────────────────────────
  // An explicit @ mention does not use sender_type as an activation gate, so an
  // app-sent message takes the same route as a human's. What differs is the
  // SENDER IDENTITY: Feishu describes an app sender as sender_type:"app", and
  // when it carries no sender_id.open_id every downstream identity decision
  // sees an empty sender. These pin what we do in both payload shapes.

  /** App/bot sender WITHOUT sender_id.open_id — the shape that loses identity. */
  function botSenderEvent(text: string, mentions: any[]) {
    return {
      sender: { sender_type: "app", sender_id: {} },
      message: {
        message_id: "mid-bot-1",
        chat_id: "oc_abc123",
        message_type: "text",
        content: JSON.stringify({ text }),
        chat_type: "group",
        mentions,
      },
    };
  }

  it("a BOT @-mentioning us is NOT filtered — the @-gate passes on mention alone", async () => {
    resolveBindingMock.mockResolvedValue(null);
    const data = botSenderEvent("@_user_1 提工单:节点异常", [{ key: "@_user_1", id: { open_id: BOT } }]);
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);
    // It reached binding resolution: sender_type is never consulted.
    expect(resolveBindingMock).toHaveBeenCalled();
  });

  it("a BOT sender with no open_id resolves with NO sender identity and a chat-scoped key", async () => {
    resolveBindingMock.mockResolvedValue(null);
    const data = botSenderEvent("@_user_1 提工单", [{ key: "@_user_1", id: { open_id: BOT } }]);
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);

    const [, , , sessionKey, senderOpenId] = resolveBindingMock.mock.calls[0];
    // Upstream authorization keys off the sender; it gets nothing to key on.
    expect(senderOpenId).toBeUndefined();
    // And per-sender isolation degrades to one shared chat-scoped session.
    expect(sessionKey).toBe("oc_abc123".replace(/^/, "chat:"));
  });

  it("a BOT sender WITH an open_id is treated exactly like a user", async () => {
    resolveBindingMock.mockResolvedValue(null);
    const data = makeTextEvent("@_user_1 提工单", {
      chat_type: "group",
      mentions: [{ key: "@_user_1", id: { open_id: BOT } }],
    }, "ou_other_bot");
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);

    const [, , , sessionKey, senderOpenId] = resolveBindingMock.mock.calls[0];
    expect(senderOpenId).toBe("ou_other_bot");
    expect(sessionKey).toBe("open_id:ou_other_bot");
  });

  it("forwards sender_type upstream so the Portal can tell a bot from a person", async () => {
    // The Portal cannot make that distinction on its own: it used to receive only
    // an open_id, which an app sender may not even have — leaving "a bot wrote
    // this" and "we could not identify the writer" indistinguishable.
    resolveBindingMock.mockResolvedValue(null);
    const data = {
      sender: { sender_type: "app", sender_id: { open_id: "ou_other_bot" } },
      message: {
        message_id: "mid-st-1", chat_id: "oc_abc123", message_type: "text",
        content: JSON.stringify({ text: "@_user_1 提工单" }),
        chat_type: "group", mentions: [{ key: "@_user_1", id: { open_id: BOT } }],
      },
    };
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);
    expect(resolveBindingMock.mock.calls[0][7]).toBe("app");
  });

  it("passes no sender_type when the event carried none — absent must not become a user", async () => {
    resolveBindingMock.mockResolvedValue(null);
    const data = botSenderEvent("@_user_1 提工单", [{ key: "@_user_1", id: { open_id: BOT } }]);
    delete (data.sender as any).sender_type;
    await handleLarkMessage(data, makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);
    expect(resolveBindingMock.mock.calls[0][7]).toBeUndefined();
  });

  it("/mode without a mention is ignored — it reconfigures the whole group", async () => {
    // It used to be handled BEFORE the @-gate, so any group member, or any other
    // BOT in the room, could switch the group's context mode by typing two words
    // at nobody. Nothing downstream checks who the sender is.
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "per_user" }));
    await handleLarkMessage(botSenderEvent("/mode", []), makeLarkClient(), "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);
    expect(resolveBindingMock).not.toHaveBeenCalled();
  });

  it("/mode inside an established one-human/one-bot Topic works without a mention, and never reaches the model", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "topic" }));
    const data = makeTextEvent("/mode", {
      message_id: "mid-topic-mode",
      chat_type: "group",
      mentions: [],
      root_id: "mid-root",
      thread_id: "omt-1",
    }, "ou_user_1", "user");
    const lark = makeTopicLarkClient();
    await handleLarkMessage(
      data, lark, "lark", makeAgentBoxManager("a1") as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );
    expect(resolveBindingMock).toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();   // handled as a command, not a prompt
    expect(lark.im.message.reply.mock.calls[0][0].data.reply_in_thread).toBe(true);
  });

  it("/mode inside a two-human/one-bot Topic requires a mention", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "topic" }));
    const data = makeTextEvent("/mode", {
      message_id: "mid-topic-mode-large-group",
      chat_type: "group",
      mentions: [],
      root_id: "mid-root",
      thread_id: "omt-1",
    }, "ou_user_1", "user");
    const lark = makeTopicLarkClient(["ou_user_1", "ou_user_2"]);

    await handleLarkMessage(
      data, lark, "lark", makeAgentBoxManager("a1") as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );

    expect(resolveBindingMock).toHaveBeenCalledTimes(1);
    expect(lark.im.message.list).toHaveBeenCalledTimes(1);
    expect(lark.im.message.reply).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("/mode inside an unclaimed Topic stays silent and cannot claim it", async () => {
    resolveBindingMock.mockResolvedValue(null);
    const data = makeTextEvent("/mode", {
      message_id: "mid-unclaimed-mode",
      chat_type: "group",
      mentions: [],
      root_id: "mid-unclaimed-root",
      thread_id: "omt-unclaimed",
    }, "ou_user_1", "user");
    const lark = makeLarkClient();

    await handleLarkMessage(
      data, lark, "lark", makeAgentBoxManager("a1") as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );

    expect(resolveBindingMock).toHaveBeenCalledWith(
      "lark",
      "oc_abc123",
      expect.anything(),
      "open_id:ou_user_1",
      "ou_user_1",
      "lark_thread:mid-unclaimed-root",
      true,
      "user",
    );
    expect(lark.im.message.reply).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("/mode at the group root stays on the main-group path", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "per_user" }));
    const data = botSenderEvent("/mode", [{ key: "@_user_1", id: { open_id: BOT } }]);
    const lark = makeLarkClient();
    await handleLarkMessage(data, lark, "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);
    expect(resolveBindingMock).toHaveBeenCalled();
    expect(lark.im.message.reply.mock.calls[0][0].data.reply_in_thread).toBeUndefined();
  });

  it("/mode reports Topic mode as Topic instead of degrading it to Personal", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "topic" }));
    const data = botSenderEvent("/mode", [{ key: "@_user_1", id: { open_id: BOT } }]);
    const lark = makeLarkClient();
    await handleLarkMessage(data, lark, "lark", makeAgentBoxManager() as any, undefined, undefined, "zh-CN", {} as any, BOT);

    const replyText = JSON.parse(lark.im.message.reply.mock.calls[0][0].data.content).text;
    expect(replyText).toContain("话题模式");
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

  it("does not treat an unmentioned group root as a two-party Topic", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({
      contextMode: "topic",
      sessionKey: "lark_thread:mid-1",
    }));
    const lark = makeTopicLarkClient();

    await handleLarkMessage(
      makeTextEvent("你好", { chat_type: "group", mentions: [] }, "ou_user_1", "user"),
      lark, "lark", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );

    expect(resolveBindingMock).not.toHaveBeenCalled();
    expect(lark.im.message.list).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("routes a one-human/one-bot Topic follow-up even when the containing group has many members", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({
      contextMode: "topic",
      sessionKey: "lark_thread:mid-live-root",
    }));
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    // Live Feishu shape from the failing 12:15 Topic: the group roster is not
    // usable, while the Topic history contains exactly the asker and this app.
    const lark = makeLarkClient([
      { message_id: "mid-bot-card", sender: { id: "cli_siclaw", sender_type: "app" } },
      { message_id: "mid-live-followup", sender: { id: "ou_user_1", sender_type: "user" } },
    ], {
      message_id: "mid-live-root",
      sender: { id: "ou_user_1", sender_type: "user" },
    });

    await handleLarkMessage(
      makeTextEvent("你好", {
        message_id: "mid-live-followup",
        chat_type: "group",
        mentions: [],
        root_id: "mid-live-root",
        thread_id: "omt-live-topic",
      }, "ou_user_1", "user"),
      lark,
      "lark",
      makeAgentBoxManager() as any,
      undefined,
      {} as any,
      "zh-CN",
      { app_id: "cli_siclaw", app_secret: "secret" },
      BOT,
    );

    expect(lark.im.message.list).toHaveBeenCalledWith({
      params: expect.objectContaining({
        container_id_type: "thread",
        container_id: "omt-live-topic",
      }),
    });
    expect(lark.im.message.get).toHaveBeenCalledWith({
      path: { message_id: "mid-live-root" },
    });
    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  it("treats @all in a claimed one-human/one-bot Topic as an unmentioned human follow-up", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({
      contextMode: "topic",
      sessionKey: "lark_thread:mid-root",
    }));
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    const lark = makeTopicLarkClient();

    await handleLarkMessage(
      makeTextEvent("@_all 继续", {
        message_id: "mid-topic-at-all",
        chat_type: "group",
        mentions: [{ key: "@_all", id: {} }],
        root_id: "mid-root",
        thread_id: "omt-topic",
      }, "ou_user_1", "user"),
      lark, "lark", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );

    expect(lark.im.message.get).toHaveBeenCalledTimes(1);
    expect(lark.im.message.list).toHaveBeenCalledTimes(1);
    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  it("revalidates Topic participants before every unmentioned turn", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({
      contextMode: "topic",
      sessionKey: "lark_thread:mid-1",
    }));
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    const lark = makeTopicLarkClient();
    lark.im.message.list
      .mockResolvedValueOnce({ data: { items: [
        { sender: { id: "ou_user_1", sender_type: "user" } },
        { sender: { id: "x", sender_type: "app" } },
      ], has_more: false } })
      .mockResolvedValueOnce({ data: { items: [
        { sender: { id: "ou_user_1", sender_type: "user" } },
        { sender: { id: "ou_user_2", sender_type: "user" } },
        { sender: { id: "x", sender_type: "app" } },
      ], has_more: false } });

    await handleLarkMessage(
      makeTextEvent("第一条", {
        message_id: "mid-followup-1", chat_type: "group", mentions: [],
        root_id: "mid-1", thread_id: "omt-topic-1",
      }, "ou_user_1", "user"),
      lark, "lark", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );
    await handleLarkMessage(
      makeTextEvent("第二个人加入后的下一条", {
        message_id: "mid-followup-2", chat_type: "group", mentions: [],
        root_id: "mid-1", thread_id: "omt-topic-1",
      }, "ou_user_1", "user"),
      lark, "lark", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );

    expect(lark.im.message.list).toHaveBeenCalledTimes(2);
    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Topic history is unavailable", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "topic" }));
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("你好", {
        message_id: "mid-followup", chat_type: "group", mentions: [],
        root_id: "mid-root", thread_id: "omt-topic",
      }, "ou_user_1", "user"),
      lark, "lark", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );

    expect(resolveBindingMock).toHaveBeenCalledTimes(1);
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("keeps Personal mode mention-gated inside a one-human/one-bot Topic", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "per_user" }));
    const manager = makeAgentBoxManager();
    const data = makeTextEvent("你好", {
      message_id: "mid-followup",
      chat_type: "group",
      mentions: [],
      root_id: "mid-root",
      thread_id: "omt-topic",
    }, "ou_user_1", "user");
    const lark = makeTopicLarkClient();

    await handleLarkMessage(data, lark, "lark", manager as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT);

    expect(resolveBindingMock).toHaveBeenCalledTimes(1);
    expect(lark.im.message.list).not.toHaveBeenCalled();
    expect(manager.getOrCreate).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("keeps Team mode passive inside a one-human/one-bot Topic", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "shared" }));
    const manager = makeAgentBoxManager();
    const data = makeTextEvent("你好", {
      message_id: "mid-followup",
      chat_type: "group",
      mentions: [],
      root_id: "mid-root",
      thread_id: "omt-topic",
    }, "ou_user_1", "user");
    const lark = makeTopicLarkClient();

    await handleLarkMessage(data, lark, "lark", manager as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT);

    expect(resolveBindingMock).toHaveBeenCalledTimes(1);
    expect(lark.im.message.list).not.toHaveBeenCalled();
    expect(manager.getOrCreate).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("requires @ when Topic history contains two humans and this bot", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "topic" }));
    const data = makeTextEvent("继续", {
      message_id: "mid-topic-followup",
      chat_type: "group",
      root_id: "mid-root",
      thread_id: "omt-topic",
      mentions: [],
    }, "ou_user_1", "user");

    const lark = makeTopicLarkClient(["ou_user_1", "ou_user_2"]);
    await handleLarkMessage(data, lark, "lark", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT);

    expect(resolveBindingMock).toHaveBeenCalledTimes(1);
    expect(lark.im.message.list).toHaveBeenCalledTimes(1);
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("requires @ on the first reply from a second human even though thread history omits the root", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "topic" }));
    const lark = makeTopicLarkClient(["ou_user_1"]);

    await handleLarkMessage(
      makeTextEvent("我也问一句", {
        message_id: "mid-user-2", chat_type: "group", mentions: [],
        root_id: "mid-root", thread_id: "omt-topic",
      }, "ou_user_2", "user"),
      lark, "lark", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );

    expect(lark.im.message.get).toHaveBeenCalledTimes(1);
    // currentSenderOpenId + root sender already proves two humans, so no reply
    // page is needed to fail closed.
    expect(lark.im.message.list).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("requires @ when another app has participated in the Topic", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "topic" }));
    const lark = makeTopicLarkClient(["ou_user_1"], ["x", "cli_other_bot"]);

    await handleLarkMessage(
      makeTextEvent("继续", {
        message_id: "mid-followup", chat_type: "group", mentions: [],
        root_id: "mid-root", thread_id: "omt-topic",
      }, "ou_user_1", "user"),
      lark, "lark", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );

    expect(lark.im.message.list).toHaveBeenCalledTimes(1);
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("scans every Topic-history page before allowing a no-mention turn", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "topic" }));
    const lark = makeTopicLarkClient();
    lark.im.message.list
      .mockResolvedValueOnce({ data: {
        items: [{ sender: { id: "x", sender_type: "app" } }],
        has_more: true,
        page_token: "page-2",
      } })
      .mockResolvedValueOnce({ data: {
        items: [{ sender: { id: "ou_user_2", sender_type: "user" } }],
        has_more: false,
      } });

    await handleLarkMessage(
      makeTextEvent("继续", {
        message_id: "mid-followup", chat_type: "group", mentions: [],
        root_id: "mid-root", thread_id: "omt-topic",
      }, "ou_user_1", "user"),
      lark, "lark", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );

    expect(lark.im.message.list).toHaveBeenCalledTimes(2);
    expect(lark.im.message.list.mock.calls[1][0].params.page_token).toBe("page-2");
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("never lets an unmentioned app sender wake the Topic agent", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "topic" }));
    const lark = makeTopicLarkClient();

    await handleLarkMessage(
      makeTextEvent("bot chatter", {
        message_id: "mid-other-app", chat_type: "group", mentions: [],
        root_id: "mid-root", thread_id: "omt-topic",
      }, "ou_other_bot", "app"),
      lark, "lark", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );

    expect(resolveBindingMock).not.toHaveBeenCalled();
    expect(lark.im.message.get).not.toHaveBeenCalled();
    expect(lark.im.message.list).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("requires @ when an unmentioned Topic event omits sender_type", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ contextMode: "topic" }));
    const lark = makeTopicLarkClient();

    await handleLarkMessage(
      makeTextEvent("继续", {
        message_id: "mid-missing-sender-type",
        chat_type: "group",
        mentions: [],
        root_id: "mid-root",
        thread_id: "omt-topic",
      }, "ou_user_1"),
      lark, "lark", makeAgentBoxManager() as any, undefined, {} as any,
      "zh-CN", { app_id: "x", app_secret: "y" }, BOT,
    );

    expect(resolveBindingMock).not.toHaveBeenCalled();
    expect(lark.im.message.get).not.toHaveBeenCalled();
    expect(lark.im.message.list).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("/mode resolves only the group mode and does not allocate a topic session", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({
      sessionId: "shared-session",
      sessionKey: "chat:oc_abc123",
      contextMode: "shared",
    }));

    await handleLarkMessage(
      // /mode now requires the mention; this case is about topic sessions, not the gate.
      makeTextEvent("/mode", { chat_type: "group", mentions: [{ key: "@_user_1", id: { open_id: BOT } }] }),
      makeLarkClient(),
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      { app_id: "x", app_secret: "y" },
      BOT,
    );

    expect(resolveBindingMock).toHaveBeenCalledWith(
      "lark",
      "oc_abc123",
      expect.anything(),
      "open_id:ou_user_1",
      "ou_user_1",
      undefined,
      false,
      undefined,   // sender_type — absent on a plain user event
    );
  });

  it("Personal mode creates a Topic reply but still requires @ on follow-ups", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({
      sessionId: "thread-session",
      sessionKey: "open_id:ou_user_1:lark_thread:mid-1",
      contextMode: "per_user",
    }));
    promptMock.mockResolvedValue({ sessionId: "thread-session" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "thread answer" }] },
      };
    });
    const config = { app_id: "x", app_secret: "y" } as const;

    const rootClient = makeLarkClient();
    await handleLarkMessage(
      groupEvent("@_user_1 查一下集群", [{ key: "@_user_1", id: { open_id: BOT } }]),
      rootClient,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      config,
      BOT,
    );

    const followupClient = makeLarkClient();
    await handleLarkMessage(
      makeTextEvent("再看一下其他节点", {
        message_id: "mid-followup",
        chat_type: "group",
        root_id: "mid-1",
        thread_id: "omt-topic-1",
        mentions: [],
      }, "ou_user_1", "user"),
      followupClient,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      config,
      BOT,
    );

    expect(promptMock.mock.calls.map((call) => call[0].sessionId)).toEqual(["thread-session"]);
    expect(resolveBindingMock.mock.calls.map((call) => call[5])).toEqual([
      "lark_thread:mid-1",
      "lark_thread:mid-1",
      "lark_thread:mid-1",
    ]);
    expect(resolveBindingMock.mock.calls.map((call) => call[6])).toEqual([
      false,
      false,
      true,
    ]);
    expect(rootClient.im.message.reply.mock.calls[0][0].data.reply_in_thread).toBe(true);
    expect(followupClient.im.message.reply).not.toHaveBeenCalled();
    expect(appendMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        conversationKey: "lark_thread:mid-1",
        rootMessageId: "mid-1",
      }),
    }));
  });

  it("Topic mode shares one claimed Topic across participants and ignores another Topic", async () => {
    resolveBindingMock.mockImplementation(async (
      _channelId: string,
      _routeKey: string,
      _frontend: unknown,
      _sessionKey: string,
      _senderOpenId: string,
      conversationKey?: string,
      conversationExistingOnly?: boolean,
    ) => {
      if (conversationKey === "lark_thread:mid-other" && conversationExistingOnly) return null;
      return makeBinding({
        sessionId: "shared-topic-session",
        sessionKey: "lark_thread:mid-1",
        contextMode: "topic",
      });
    });
    promptMock.mockResolvedValue({ sessionId: "shared-topic-session" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "topic answer" }] },
      };
    });
    const config = { app_id: "x", app_secret: "y" } as const;

    const rootClient = makeLarkClient();
    await handleLarkMessage(
      groupEvent("@_user_1 查一下集群", [{ key: "@_user_1", id: { open_id: BOT } }]),
      rootClient,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      config,
      BOT,
    );

    const followupClient = makeLarkClient();
    await handleLarkMessage(
      makeTextEvent("再看一下其他节点", {
        message_id: "mid-followup",
        chat_type: "group",
        root_id: "mid-1",
        thread_id: "omt-topic-1",
        mentions: [{ key: "@_user_1", id: { open_id: BOT } }],
      }, "ou_user_2", "user"),
      followupClient,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      config,
      BOT,
    );

    const unrelatedClient = makeLarkClient();
    await handleLarkMessage(
      makeTextEvent("这个话题也问一下", {
        message_id: "mid-unrelated-followup",
        chat_type: "group",
        root_id: "mid-other",
        thread_id: "omt-topic-other",
        mentions: [],
      }, "ou_user_2", "user"),
      unrelatedClient,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      config,
      BOT,
    );

    expect(promptMock.mock.calls.map((call) => call[0].sessionId)).toEqual([
      "shared-topic-session",
      "shared-topic-session",
    ]);
    expect(resolveBindingMock).toHaveBeenCalledWith(
      "lark",
      "oc_abc123",
      expect.anything(),
      "open_id:ou_user_2",
      "ou_user_2",
      "lark_thread:mid-1",
      false,
      "user",
    );
    expect(resolveBindingMock).toHaveBeenCalledWith(
      "lark",
      "oc_abc123",
      expect.anything(),
      "open_id:ou_user_2",
      "ou_user_2",
      "lark_thread:mid-other",
      true,
      "user",
    );
    expect(rootClient.im.message.reply.mock.calls[0][0].data.reply_in_thread).toBe(true);
    expect(followupClient.im.message.reply.mock.calls[0][0].data.reply_in_thread).toBe(true);
    expect(unrelatedClient.im.message.reply).not.toHaveBeenCalled();
  });

  it("never enables Topic delivery for an unknown chat type", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({
      sessionId: "unknown-chat-session",
      sessionKey: "open_id:ou_user_1",
      contextMode: "per_user",
    }));
    promptMock.mockResolvedValue({ sessionId: "unknown-chat-session" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "plain answer" }] },
      };
    });
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("future chat type", { chat_type: "future" }),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      { app_id: "x", app_secret: "y" },
      BOT,
    );

    expect(resolveBindingMock.mock.calls.map((call) => call[5])).toEqual([undefined, undefined]);
    expect(appendMessageMock.mock.calls[0][0].metadata).not.toHaveProperty("conversationKey");
    expect(lark.im.message.reply.mock.calls[0][0].data.reply_in_thread).toBeUndefined();
  });

  it("starts an explicitly mentioned quoted message as a new topic rooted at the current message", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({
      sessionId: "quoted-topic-session",
      sessionKey: "open_id:ou_user_1:lark_thread:mid-quoted-at",
      contextMode: "per_user",
    }));
    promptMock.mockResolvedValue({ sessionId: "quoted-topic-session" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "quoted answer" }] },
      };
    });
    const client = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("@_user_1 分析这条引用", {
        message_id: "mid-quoted-at",
        chat_type: "group",
        root_id: "mid-older-message",
        mentions: [{ key: "@_user_1", id: { open_id: BOT } }],
      }),
      client,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      { app_id: "x", app_secret: "y" },
      BOT,
    );

    expect(resolveBindingMock.mock.calls.map((call) => call[5])).toEqual([
      "lark_thread:mid-quoted-at",
      "lark_thread:mid-quoted-at",
    ]);
    expect(resolveBindingMock.mock.calls.map((call) => call[6])).toEqual([false, false]);
    expect(client.im.message.reply.mock.calls[0][0].path.message_id).toBe("mid-quoted-at");
    expect(client.im.message.reply.mock.calls[0][0].data.reply_in_thread).toBe(true);
  });

  it("team mode always keeps the shared group on the main-group reply path", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({
      sessionId: "shared-session",
      sessionKey: "chat:oc_abc123",
      contextMode: "shared",
    }));
    promptMock.mockResolvedValue({ sessionId: "shared-session" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "shared answer" }] },
      };
    });
    const config = { app_id: "x", app_secret: "y" } as const;
    const rootClient = makeLarkClient();

    await handleLarkMessage(
      groupEvent("@_user_1 查一下集群", [{ key: "@_user_1", id: { open_id: BOT } }]),
      rootClient,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      config,
      BOT,
    );

    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(resolveBindingMock.mock.calls.map((call) => call[5])).toEqual([
      "lark_thread:mid-1",
      undefined,
    ]);
    expect(rootClient.im.message.reply.mock.calls[0][0].data.reply_in_thread).toBeUndefined();
    expect(appendMessageMock.mock.calls[0][0].metadata).not.toHaveProperty("conversationKey");

    const quoteClient = makeLarkClient();
    await handleLarkMessage(
      makeTextEvent("引用回复里的共享讨论", {
        message_id: "mid-shared-quote",
        chat_type: "group",
        root_id: "mid-1",
        mentions: [],
      }),
      quoteClient,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      config,
      BOT,
    );

    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(resolveBindingMock).toHaveBeenCalledTimes(2);
    expect(quoteClient.im.message.reply).not.toHaveBeenCalled();

    await handleLarkMessage(
      makeTextEvent("@_user_1 继续分析", {
        message_id: "mid-shared-next",
        chat_type: "group",
        mentions: [{ key: "@_user_1", id: { open_id: BOT } }],
      }),
      makeLarkClient(),
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      config,
      BOT,
    );

    expect(promptMock).toHaveBeenCalledTimes(2);
    expect(promptMock.mock.calls[1][0].text).toContain("引用回复里的共享讨论");
  });

  it("personal mode ignores an unmentioned topic that has no existing bot session", async () => {
    resolveBindingMock.mockResolvedValue(null);
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("普通话题里的聊天", {
        message_id: "mid-followup",
        chat_type: "group",
        root_id: "mid-unrelated-root",
        thread_id: "omt-unrelated",
        mentions: [],
      }, "ou_user_1", "user"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      { app_id: "x", app_secret: "y" },
      BOT,
    );

    expect(resolveBindingMock).toHaveBeenCalledWith(
      "lark",
      "oc_abc123",
      expect.anything(),
      "open_id:ou_user_1",
      "ou_user_1",
      "lark_thread:mid-unrelated-root",
      true,
      "user",
    );
    expect(promptMock).not.toHaveBeenCalled();
    expect(lark.im.message.reply).not.toHaveBeenCalled();
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
            create: vi.fn().mockResolvedValue({ code: 0 }),
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
    appendMessageMock.mockImplementation(async (message: { role: string }) =>
      message.role === "assistant" ? "msg-assistant-final" : "msg-user",
    );
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
    const feedbackAppend = lark.cardkit.v1.cardElement.create.mock.calls[0][0];
    const [feedbackRow] = JSON.parse(feedbackAppend.data.elements);
    expect(feedbackRow.columns[0].elements[0].behaviors[0].value.message_id).toBe("msg-assistant-final");
    expect(lark.im.image.create).not.toHaveBeenCalled();
  });

  it("persists a delta-only reply and appends feedback linked to that message", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-delta-only" });
    streamEventsMock.mockImplementation(async function* () {
      yield { type: "content_block_delta", delta: { text: "delta-only " } };
      yield { type: "content_block_delta", delta: { text: "answer" } };
    });
    appendMessageMock.mockImplementation(async (message: { role: string }) =>
      message.role === "assistant" ? "msg-assistant-delta" : "msg-user",
    );
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    expect(lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content).toContain("delta-only answer");
    expect(appendMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s-delta-only",
      role: "assistant",
      content: "delta-only answer",
    }));
    const feedbackAppend = lark.cardkit.v1.cardElement.create.mock.calls[0][0];
    const [feedbackRow] = JSON.parse(feedbackAppend.data.elements);
    expect(feedbackRow.columns[0].elements[0].behaviors[0].value.message_id).toBe("msg-assistant-delta");
  });

  it("does not append feedback buttons when the final assistant row fails to persist", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-persist-fail" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "answer still delivered" }] },
      };
    });
    appendMessageMock
      .mockResolvedValueOnce("msg-user")
      .mockRejectedValueOnce(new Error("db down"));
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(
      makeTextEvent("hello"),
      lark,
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    expect(lark.cardkit.v1.cardElement.content.mock.calls[0][0].data.content).toContain("answer still delivered");
    expect(lark.cardkit.v1.cardElement.create).not.toHaveBeenCalled();
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

  it("never shows a bare tool name as a step, but keeps the agent's own narration", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-tool-noise" });
    streamEventsMock.mockImplementation(async function* () {
      // No details.items → the single-agent activity branch. `Ran <tool>` is the
      // producer's developer-facing text (right for Portal's work log, noise in a
      // group): it must not reach the card.
      yield {
        type: "tool_execution_update",
        toolCallId: "t1",
        partialResult: { content: [{ type: "text", text: "Ran host_list" }] },
      };
      // The child's own words ARE a milestone — this is what the asker wants to see.
      yield {
        type: "tool_execution_update",
        toolCallId: "t1",
        partialResult: { content: [{ type: "text", text: "正在核对 conntrack 会话时间线" }] },
      };
      yield {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "结论：公网入口丢包。" }] },
      };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(makeTextEvent("排查"), lark, "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);

    const contentCalls = lark.cardkit.v1.cardElement.content.mock.calls.map((c: any) => c[0].data.content as string);
    expect(contentCalls.some((c) => c.includes("host_list"))).toBe(false);
    expect(contentCalls.some((c) => c.includes("Ran "))).toBe(false);
    expect(contentCalls.some((c) => c.includes("正在核对 conntrack 会话时间线"))).toBe(true);
    expect(contentCalls.at(-1)).toContain("结论：公网入口丢包。");
  });

  it("localizes the sub-agent slot wait instead of leaking its English source text", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-slot-wait" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "tool_execution_update",
        toolCallId: "t1",
        partialResult: { content: [{ type: "text", text: "Waiting for a free slot (4 sub-agents run at a time)…" }] },
      };
      yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "完成。" }] } };
    });
    const lark = makeCardAwareLarkClient();

    await handleLarkMessage(makeTextEvent("排查"), lark, "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);

    const contentCalls = lark.cardkit.v1.cardElement.content.mock.calls.map((c: any) => c[0].data.content as string);
    expect(contentCalls.some((c) => c.includes("排队等待子任务空位"))).toBe(true);
    expect(contentCalls.some((c) => c.includes("Waiting for a free slot"))).toBe(false);
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

  it("keeps ControlPlane visual-card source as markdown when no PNG artifact is available", async () => {
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

  it("posts a replacement CARD (not raw text) when the terminal card update is rejected", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-reject" });
    const answer = "## 结论\n\n| 维度 | 结果 |\n|------|------|\n| RoCE | 正常 |";
    streamEventsMock.mockImplementation(async function* () {
      yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } };
    });
    const lark = makeCardAwareLarkClient();
    // Observed in production: a long turn outlives the card's streaming window,
    // so Feishu refuses the terminal write (200850 → then 300309). The SDK does
    // not throw on those, which is what used to freeze the card on its ⏳ line.
    lark.cardkit.v1.cardElement.content = vi.fn().mockResolvedValue({ code: 300309, msg: "streaming mode is closed" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleLarkMessage(makeTextEvent("hi"), lark, "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);

    // A SECOND card carries the answer — a text reply would ship the markdown as
    // literal `##` and `|---|` rows, which is unreadable on a long report.
    expect(lark.cardkit.v1.card.create).toHaveBeenCalledTimes(2);
    const replacement = JSON.parse(lark.cardkit.v1.card.create.mock.calls[1][0].data.data);
    expect(replacement.body.elements[0].content).toContain("## 结论");
    expect(replacement.body.elements[0].content).toContain("| 维度 | 结果 |");
    // Static card — no streaming window left to expire.
    expect(replacement.config?.streaming_mode).toBeUndefined();

    expect(lark.im.message.reply).toHaveBeenCalledTimes(2);
    expect(lark.im.message.reply.mock.calls[1][0].data.msg_type).toBe("interactive");
    // Never a plain-text reply while a card is still possible.
    const textReplies = lark.im.message.reply.mock.calls.filter((c: any) => c[0].data.msg_type === "text");
    expect(textReplies).toHaveLength(0);
  });

  it("falls back to plain text only when the replacement card also fails", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-reject-2" });
    streamEventsMock.mockImplementation(async function* () {
      yield { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "最终结论" }] } };
    });
    const lark = makeCardAwareLarkClient();
    lark.cardkit.v1.cardElement.content = vi.fn().mockResolvedValue({ code: 300309, msg: "streaming mode is closed" });
    // First create opens the typing card; the replacement create yields no card_id.
    lark.cardkit.v1.card.create = vi.fn()
      .mockResolvedValueOnce({ data: { card_id: "CARD-99" } })
      .mockResolvedValueOnce({ data: {} });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleLarkMessage(makeTextEvent("hi"), lark, "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);

    // Degraded, but the answer still reaches the user rather than vanishing.
    const textReplies = lark.im.message.reply.mock.calls.filter((c: any) => c[0].data.msg_type === "text");
    expect(textReplies).toHaveLength(1);
    expect(JSON.parse(textReplies[0][0].data.content).text).toContain("最终结论");
  });

  it("does NOT double-post when only the streaming-mode flip is rejected (answer is on the card)", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding());
    promptMock.mockResolvedValue({ sessionId: "s-settings-reject" });
    streamEventsMock.mockImplementation(async function* () {
      yield {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "答复正文" }] },
      };
    });
    const lark = makeCardAwareLarkClient();
    lark.cardkit.v1.card.settings = vi.fn().mockResolvedValue({ code: 99991400, msg: "rate limited" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleLarkMessage(makeTextEvent("hi"), lark, "lark", makeAgentBoxManager("a1") as any, undefined, {} as any);

    // Only the card post — the body landed, so a text reply would duplicate it.
    expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
    expect(lark.im.message.reply.mock.calls[0][0].data.msg_type).toBe("interactive");
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

  it("appends registered knowledge sources to a Feishu answer", async () => {
    const events = [
      { type: "knowledge_sources", sources: [{ title: "GPU Runbook", url: "https://docs.feishu.cn/wiki/a" }] },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "结论" }] } },
    ];
    const text = await collectResponse(fakeClient(events), "s-citations");
    expect(text).toContain("### 参考原文");
    expect(text).toContain("[GPU Runbook](https://docs.feishu.cn/wiki/a)");
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
    const text = await collectResponse(fakeClient(events), "s-citations-fallback");
    expect(text).toBe("answer from fallback");
    expect(text).not.toContain("Primary Runbook");
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
  const envelope = (overrides: Record<string, unknown> = {}) => ({
    v: 1,
    round: 1,
    attempt: 1,
    kind: "agent",
    model: { provider: "openai", id: "gpt-5" },
    request_at: "2026-09-03T08:00:00.000Z",
    response_end_at: "2026-09-03T08:00:01.000Z",
    ms: { net_ttft: 300, thinking: 0, output: 700, total: 1000 },
    blocks: [],
    thinking_visible: false,
    tool_call_ids: [],
    ...overrides,
  });

  it("persists every assistant turn + each tool call when persist is set", async () => {
    appendMessageMock
      .mockResolvedValueOnce("msg-assistant-intermediate")
      .mockResolvedValueOnce("msg-tool")
      .mockResolvedValueOnce("msg-assistant-final");
    const events = [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Checking nodes" }] } },
      { type: "tool_execution_start", toolName: "bash", args: { command: "kubectl get nodes" } },
      { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "node ok" }], details: {} } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All healthy." }] } },
    ];
    const collected = await collectChannelResponse(fakeClient(events), "s-audit", "lark", {
      persist: { agentId: "a1", traceId: "0123456789abcdef0123456789abcdef" },
    });
    // Reply text is still the final assistant turn.
    expect(collected.text).toBe("All healthy.");
    expect(collected.assistantMessageId).toBe("msg-assistant-final");

    const calls = appendMessageMock.mock.calls.map((c) => c[0] as any);
    expect(calls.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["Checking nodes", "All healthy."]);
    expect(calls.every((message) => message.traceId === "0123456789abcdef0123456789abcdef")).toBe(true);
    const toolRows = calls.filter((m) => m.role === "tool");
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]).toMatchObject({ sessionId: "s-audit", toolName: "bash", outcome: "success" });
    expect(toolRows[0].toolInput).toContain("kubectl get nodes");
    expect(toolRows[0].content).toBe("node ok");
  });

  it("persists the synthesized assistant reply when the stream is delta-only", async () => {
    appendMessageMock.mockResolvedValueOnce("msg-assistant-delta");
    const events = [
      { type: "content_block_delta", delta: { text: "Hello" } },
      { type: "content_block_delta", delta: { text: " world" } },
    ];

    const collected = await collectChannelResponse(fakeClient(events), "s-delta", "lark", {
      persist: { agentId: "a1" },
    });

    expect(collected).toMatchObject({
      text: "Hello world",
      assistantMessageId: "msg-assistant-delta",
    });
    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(appendMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s-delta",
      role: "assistant",
      content: "Hello world",
    }));
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

  it("keeps invocation toolsets stable for out-of-order same-name calls", async () => {
    const events = [
      { type: "tool_execution_start", toolCallId: "a", toolName: "query", toolset: "mcp:cluster-a", args: { q: "a" } },
      { type: "tool_execution_start", toolCallId: "b", toolName: "query", toolset: "mcp:cluster-b", args: { q: "b" } },
      { type: "tool_execution_end", toolCallId: "b", toolName: "query", result: { content: [], details: {} } },
      { type: "tool_execution_end", toolCallId: "a", toolName: "query", result: { content: [], details: {} } },
    ];
    await collectChannelResponse(fakeClient(events), "s-toolsets", "lark", { persist: { agentId: "a1" } });
    const rows = appendMessageMock.mock.calls.map((c) => c[0] as any).filter((m) => m.role === "tool");
    expect(rows.map((m) => m.toolset)).toEqual(["mcp:cluster-b", "mcp:cluster-a"]);
    expect(rows.map((m) => m.toolInput)).toEqual(['{"q":"b"}', '{"q":"a"}']);
  });

  it("a persist failure does not break the reply (best-effort)", async () => {
    appendMessageMock.mockRejectedValueOnce(new Error("db down"));
    const events = [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "still replies" }] } },
    ];
    const collected = await collectChannelResponse(fakeClient(events), "s-fail", "lark", { persist: { agentId: "a1" } });
    expect(collected.text).toBe("still replies");
    expect(collected.assistantMessageId).toBeNull();
  });

  it("deduplicates independently parsed message_end and turn_end envelopes", async () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      llmCall: envelope(),
    };
    await collectChannelResponse(fakeClient([
      { type: "message_end", message },
      { type: "turn_end", message: JSON.parse(JSON.stringify(message)) },
    ]), "s-dedup", "lark", { persist: { agentId: "a1" } });

    const rows = appendMessageMock.mock.calls.map((call) => call[0] as any)
      .filter((row) => row.role === "assistant");
    expect(rows).toHaveLength(1);
  });

  it("revokes recovered error rows while retaining every model call", async () => {
    await collectChannelResponse(fakeClient([
      { type: "message_end", message: {
        role: "assistant", content: [], stopReason: "error", errorMessage: "transient",
        llmCall: envelope({ round: 1, stop_reason: "error" }),
      } },
      { type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop",
        llmCall: envelope({ round: 2, request_at: "2026-09-03T08:00:02.000Z", response_end_at: "2026-09-03T08:00:03.000Z" }),
      } },
    ]), "s-retry", "lark", { persist: { agentId: "a1" } });

    const rows = appendMessageMock.mock.calls.map((call) => call[0] as any)
      .filter((row) => row.role === "assistant");
    expect(rows.map((row) => row.metadata.llm_call.round)).toEqual([1, 2]);
    expect(rows[0].content).toBe("");
    expect(rows[1].content).toBe("recovered");
    expect(rows.some((row) => row.metadata?.kind === "error_response")).toBe(false);
  });

  it("persists only the final retry error and redacts its envelope metadata", async () => {
    await collectChannelResponse(fakeClient([
      { type: "message_end", message: {
        role: "assistant", content: [], stopReason: "error", errorMessage: "first",
        llmCall: envelope({ round: 1, stop_reason: "error", error_message: "first" }),
      } },
      { type: "message_end", message: {
        role: "assistant", content: [], stopReason: "error", errorMessage: "last sk-secret123",
        llmCall: envelope({
          round: 2,
          request_at: "2026-09-03T08:00:02.000Z",
          response_end_at: "2026-09-03T08:00:03.000Z",
          stop_reason: "error",
          error_message: "last sk-secret123",
        }),
      } },
    ]), "s-errors", "lark", {
      persist: { agentId: "a1", modelConfig: { apiKey: "sk-secret123" } },
    });

    const rows = appendMessageMock.mock.calls.map((call) => call[0] as any)
      .filter((row) => row.role === "assistant");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ content: "", metadata: { llm_call: { round: 1 } } });
    expect(rows[1].metadata.kind).toBe("error_response");
    expect(rows[1].content).not.toContain("sk-secret123");
    expect(rows[1].metadata.llm_call.error_message).not.toContain("sk-secret123");
  });

  it("moves a rolled-back attempt's calls onto the fallback notice", async () => {
    await collectChannelResponse(fakeClient([
      { type: "model_route_start", candidateCount: 2 },
      { type: "message_end", message: {
        role: "assistant", content: [], stopReason: "error", errorMessage: "primary 429 sk-secret123",
        llmCall: envelope({ round: 1, attempt: 1, stop_reason: "error", error_message: "primary 429 sk-secret123" }),
      } },
      { type: "model_route_rollback", attempt: 1, candidateKey: "openai/gpt-5", failureKind: "rate_limit" },
      {
        type: "model_route_switch",
        attempt: 2,
        fromCandidateKey: "openai/gpt-5",
        toCandidateKey: "anthropic/claude",
        fromProvider: "openai",
        fromModelId: "gpt-5",
        toProvider: "anthropic",
        toModelId: "claude",
        failureKind: "rate_limit",
      },
      { type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: "fallback answer" }], stopReason: "stop",
        llmCall: envelope({ round: 1, attempt: 2 }),
      } },
      { type: "model_route_success" },
    ]), "s-route", "lark", {
      persist: { agentId: "a1", modelConfig: { apiKey: "sk-secret123" } },
    });

    const rows = appendMessageMock.mock.calls.map((call) => call[0] as any)
      .filter((row) => row.role === "assistant");
    const notice = rows.find((row) => row.metadata?.kind === "model_route_notice");
    expect(notice.metadata.discarded_llm_calls).toHaveLength(1);
    expect(notice.metadata.discarded_llm_calls[0]).toMatchObject({ round: 1, attempt: 1 });
    expect(notice.metadata.discarded_llm_calls[0].error_message).not.toContain("sk-secret123");
    expect(rows.some((row) => row.metadata?.kind === "error_response")).toBe(false);
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
      makeTextEvent("check this https://oss.example.org/x.png"),
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
    expect(arg.text).toContain("https://oss.example.org/x.png");
  });

  it("persists the user row with signed-URL credentials stripped (prompt keeps the full URL)", async () => {
    resolveBindingMock.mockResolvedValue(makeBinding({ agentId: "a1", sessionId: "session-fixed" }));
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    await handleLarkMessage(
      makeTextEvent("look https://oss.example.org/x.png?Signature=secret"),
      makeLarkClient(),
      "lark",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
    );

    const userRow = appendMessageMock.mock.calls.find((c) => c[0].role === "user")?.[0];
    expect(userRow.content).toContain("oss.example.org/x.png");
    expect(userRow.content).not.toContain("Signature"); // creds stripped from the persisted row
    // the prompt forwarded to AgentBoxClient keeps the full signed URL (client.prompt fetches it)
    expect(promptMock.mock.calls[0][0].text).toContain("Signature=secret");
  });
});

describe("extractInbound — post receive shapes", () => {
  it("parses a Feishu code_block post instead of silently dropping the turn", () => {
    const message = {
      message_type: "post",
      content: JSON.stringify({
        content: [[{ tag: "code_block", language: "PLAIN_TEXT", text: "你好-验收-adba021f\n" }]],
      }),
    };
    const { text, imageRefs } = extractInbound(message);
    expect(text).toBe("你好-验收-adba021f");
    expect(imageRefs).toEqual([]);
  });

  it("parses a standalone md node in a Feishu post", () => {
    const message = {
      message_type: "post",
      content: JSON.stringify({ content: [[{ tag: "md", text: "**hello**" }]] }),
    };
    expect(extractInbound(message).text).toBe("**hello**");
  });

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
        content: [[{ tag: "a", text: "see", href: "https://oss.example.org/x.png" }]],
      }),
    };
    const { text } = extractInbound(message);
    expect(text).toContain("Report");
    expect(text).toContain("see");
    expect(text).toContain("https://oss.example.org/x.png"); // href surfaced for the unified URL resolver
  });
});

// ── Personal-chat admission refusals ───────────────────────────────
//
// The frontend owns the decision; the runtime's gate is only "did a binding come back". What is
// tested here is what the sender is TOLD — a gated tier answering with silence is
// indistinguishable from a broken bot, and copy that says "go link your account" to someone who
// already linked it sends them in circles.

describe("handleLarkMessage — personal access denial", () => {
  const ACTION_URL = "https://upstream.example/siclaw/agent-access/9f3a2b";

  // `makeLarkClient()` has NO cardkit, so card creation fails and the handler degrades to the text
  // form — which means the text-asserting tests below are exercising the FALLBACK path. This
  // client has cardkit and therefore takes the card path.
  function makeCardClient() {
    return {
      im: { message: { reply: vi.fn().mockResolvedValue({}) } },
      cardkit: {
        v1: { card: { create: vi.fn().mockResolvedValue({ data: { card_id: "CARD-DENY" } }) } },
      },
    };
  }

  const sentCard = (lark: ReturnType<typeof makeCardClient>) =>
    JSON.parse(lark.cardkit.v1.card.create.mock.calls[0][0].data.data);

  function sendGated(
    lark: ReturnType<typeof makeLarkClient>,
    accessMode = "identified",
    overrides: Record<string, unknown> = {},
  ) {
    return handleLarkMessage(
      makeTextEvent("查一下集群", { chat_type: "p2p" }),
      lark,
      "personal-bot-1",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      makePersonalConfig(accessMode as any, overrides),
    );
  }

  const denialText = (lark: ReturnType<typeof makeLarkClient>) =>
    lark.im.message.reply.mock.calls[0][0].data.content as string;

  it("renders the link-account reason with a DERIVED expiry, not a hard-coded TTL", async () => {
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      // A few seconds ABOVE a whole minute: the renderer floors (never overstating a single-use
      // link), so sitting just under 10min would legitimately read 9 and the assertion would be
      // asserting the wrong thing.
      denied: { reason: "binding_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 10 * 60_000 + 5_000 },
    });
    const lark = makeLarkClient();

    await sendGated(lark);

    const reply = denialText(lark);
    expect(reply).toContain("需要先关联账号");
    expect(reply).toContain(ACTION_URL);
    expect(reply).toContain("10 分钟内");        // from expiresAtMs, never a constant
    expect(promptMock).not.toHaveBeenCalled();  // never enters the conversation
  });

  it("does NOT tell an already-linked sender to link again", async () => {
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "access_request_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 60_000 },
    });
    const lark = makeLarkClient();

    await sendGated(lark, "granted");

    const reply = denialText(lark);
    expect(reply).toContain("申请");
    expect(reply).not.toContain("关联账号");     // they already did that
    expect(reply).toContain(ACTION_URL);
  });

  it("offers no link when self-service is closed", async () => {
    resolvePersonalBindingMock.mockResolvedValue({ binding: null, denied: { reason: "access_denied" } });
    const lark = makeLarkClient();

    await sendGated(lark, "granted");

    expect(denialText(lark)).toContain("负责人");
    expect(denialText(lark)).not.toContain("http");
  });

  it("renders English copy for a global-domain channel", async () => {
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "binding_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 60_000 },
    });
    const lark = makeLarkClient();

    await handleLarkMessage(
      makeTextEvent("check the cluster", { chat_type: "p2p" }),
      lark, "personal-bot-1", makeAgentBoxManager("a1") as any, undefined, {} as any,
      "en-US", makePersonalConfig("identified" as any),
    );

    expect(denialText(lark)).toContain("linking your account");
    expect(denialText(lark)).toContain("within 1 minute");
  });

  it("falls back to the frontend message on an unknown reason, without duplicating the link", async () => {
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "some_future_reason", actionUrl: ACTION_URL, message: `Do this: ${ACTION_URL}` },
    });
    const lark = makeLarkClient();

    await sendGated(lark);

    const reply = denialText(lark);
    expect(reply).toContain("Do this:");
    // The message already embeds whatever link the frontend wanted shown.
    expect(reply.split(ACTION_URL).length - 1).toBe(1);
  });

  it("sends a live link as a card with an action button, keeping the URL off the text body", async () => {
    // A bare URL in a text message gets unfurled by the client, and an automated fetch of a
    // one-time token can burn the sender's only chance to use it. The URL therefore lives on the
    // button and nowhere else.
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "binding_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 10 * 60_000 + 5_000 },
    });
    const lark = makeCardClient();

    await sendGated(lark as any);

    const card = sentCard(lark);
    const json = JSON.stringify(card);
    expect(card.schema).toBe("2.0");
    // CardKit rejected a bare body-level `button` and a `note` element (create returned no
    // card_id and the handler degraded to text). Only the shapes already proven in production.
    const elements = (card as any).body.elements as any[];
    expect(elements.some((e) => e.tag === "note")).toBe(false);
    expect(elements.some((e) => e.tag === "button")).toBe(false);
    const buttonHost = elements.find((e) => e.tag === "column_set");
    expect(buttonHost.columns[0].elements[0].tag).toBe("button");
    expect(json).toContain("关联账号");                       // reason-specific button label
    expect(json).toContain("open_url");
    expect(json).toContain(ACTION_URL);                       // on the button
    expect(json).toContain("10 分钟内有效");                   // derived footnote
    // Posted as an interactive card, and the text payload never carries the link.
    const posted = lark.im.message.reply.mock.calls[0][0];
    expect(posted.data.msg_type).toBe("interactive");
    expect(posted.data.content).not.toContain(ACTION_URL);
  });

  it("labels the button for the request-access reason", async () => {
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "access_request_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 60_000 },
    });
    const lark = makeCardClient();

    await sendGated(lark as any, "granted");

    expect(JSON.stringify(sentCard(lark))).toContain("申请权限");
  });

  it("falls back to the text form when the card cannot be created", async () => {
    // The link is the whole point of the message: losing the card must never mean losing the link.
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "binding_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 60_000 },
    });
    const lark = makeCardClient();
    lark.cardkit.v1.card.create.mockRejectedValue(new Error("cardkit unavailable"));

    await sendGated(lark as any);

    const posted = lark.im.message.reply.mock.calls[0][0];
    expect(posted.data.msg_type).toBe("text");
    expect(posted.data.content).toContain(ACTION_URL);
  });

  it("uses text, not a card, when there is no live link to put on a button", async () => {
    for (const denied of [
      { reason: "access_denied" },                                                        // no link at all
      { reason: "binding_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() - 1 }, // already dead
    ]) {
      resolvePersonalBindingMock.mockResolvedValue({ binding: null, denied });
      const lark = makeCardClient();
      await sendGated(lark as any, "granted");
      expect(lark.cardkit.v1.card.create, `reason=${denied.reason}`).not.toHaveBeenCalled();
      expect(lark.im.message.reply.mock.calls[0][0].data.msg_type).toBe("text");
    }
  });

  it("does not treat an Object.prototype key as a template", async () => {
    // `reason` is frontend-controlled. An object lookup would return Object.prototype.toString
    // here — truthy, so the message fallback is skipped, and the reply becomes a Function that
    // JSON-serializes to `{}`; the platform rejects it and the sender gets nothing at all.
    for (const reason of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      resolvePersonalBindingMock.mockResolvedValue({
        binding: null,
        denied: { reason, message: "Contact your admin." },
      });
      const lark = makeLarkClient();
      await sendGated(lark);
      const reply = denialText(lark);
      expect(reply, `reason=${reason}`).toContain("Contact your admin.");
      // A prototype hit would render the function source, or serialize to {"text":{}}.
      expect(reply, `reason=${reason}`).not.toContain("native code");
      expect(reply, `reason=${reason}`).not.toContain('"text":{}');
    }
  });

  it("tells the sender to resend instead of handing over an already-expired link", async () => {
    // Reachable through ordinary clock skew + event-delivery latency, not just a stale send. The
    // frontend mints a fresh link on the next message, so resending is the real recovery.
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "binding_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() - 1_000 },
    });
    const lark = makeLarkClient();

    await sendGated(lark);

    const reply = denialText(lark);
    expect(reply).toContain("已过期");
    expect(reply).toContain("再发一条消息");
    expect(reply).not.toContain(ACTION_URL);   // never hand over a dead link
  });

  it("never overstates how long a single-use link lasts", async () => {
    // 91s must not read "2 minutes" — a sender who follows that at 1m50s finds it already gone.
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "binding_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 91_000 },
    });
    const lark = makeLarkClient();

    await sendGated(lark);

    expect(denialText(lark)).toContain("1 分钟内");
  });

  it("never truncates the link — only the frontend's prose is capped", async () => {
    // Capping the rendered result severed long URLs, handing the sender a mutilated dead link with
    // no hint it was cut — the very outcome the expired-link branch exists to prevent. The
    // platform's text limit sits far above anything rendered here, so the trade bought nothing.
    const longUrl = `https://x/${"y".repeat(5000)}`;
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "binding_required", actionUrl: longUrl, expiresAtMs: Date.now() + 60_000 },
    });
    const lark = makeLarkClient();

    await sendGated(lark);

    expect(denialText(lark)).toContain(longUrl);   // intact, not sliced
  });

  it("answers even on an open tier when the refusal cannot be rendered", async () => {
    // An explicit refusal we have no template for is STILL a refusal. Gating the silent branch on
    // the tier alone swallowed it on public/open — the exact "bot looks dead" failure this feature
    // exists to remove.
    resolvePersonalBindingMock.mockResolvedValue({ binding: null, denied: { reason: "quota_exceeded" } });
    for (const tier of ["public", "open"]) {
      const lark = makeLarkClient();
      await sendGated(lark, tier);
      expect(denialText(lark), `tier=${tier}`).toContain("需要先获得授权");
    }
  });

  it("offers no link or button for a reason with no self-service step", async () => {
    // access_denied means "ask the owner". An actionUrl arriving on it must not become a generic
    // "Continue" button, nor a "click within N minutes" line contradicting the sentence above it.
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "access_denied", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 600_000 },
    });
    const lark = makeCardClient();

    await sendGated(lark as any, "granted");

    expect(lark.cardkit.v1.card.create).not.toHaveBeenCalled();
    const reply = lark.im.message.reply.mock.calls[0][0].data.content as string;
    expect(reply).toContain("负责人");
    expect(reply).not.toContain(ACTION_URL);
    expect(reply).not.toContain("分钟内");
  });

  it("tells the sender to open their own authorization page, not to find an admin", async () => {
    // The configured console URL IS the sender's self-service page; an admin cannot link someone
    // else's chat account, so naming an admin while dangling that link is a dead end.
    resolvePersonalBindingMock.mockResolvedValue({ binding: null });
    const lark = makeLarkClient();

    await sendGated(lark, "granted", { authorize_url: "https://console.example/authz" });

    const reply = denialText(lark);
    expect(reply).toContain("请打开下面的链接");
    expect(reply).toContain("https://console.example/authz");
    expect(reply).not.toContain("管理员");
  });

  it("names an admin only when there is no link the sender could use", async () => {
    resolvePersonalBindingMock.mockResolvedValue({ binding: null });
    const lark = makeLarkClient();

    await sendGated(lark, "granted");   // no authorize_url configured

    expect(denialText(lark)).toContain("请联系管理员");
  });

  it("puts an unknown reason's link on a button too, never as unfurlable text", async () => {
    // Falling straight to text for an unfamiliar reason printed a one-time URL where a client
    // unfurl could fetch and consume the token before the sender tapped it — the exact property
    // this delivery path exists to hold, defeated by the version-skew case it must survive.
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "quota_exceeded", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 600_000, message: "Quota exceeded." },
    });
    const lark = makeCardClient();

    await sendGated(lark as any);

    const card = JSON.stringify(sentCard(lark));
    expect(card).toContain(ACTION_URL);        // on the button
    expect(card).toContain("继续");             // neutral label: we cannot name an unknown step
    expect(lark.im.message.reply.mock.calls[0][0].data.content).not.toContain(ACTION_URL);
  });

  it("delivers an unknown reason's link even with no prose from the frontend", async () => {
    // The formatter returned null without a template or a message, so the caller dropped to its own
    // generic text and the structured actionUrl was lost — link delivery must not depend on whether
    // prose was supplied.
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "quota_exceeded", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 600_000 },
    });
    const lark = makeCardClient();

    await sendGated(lark as any);

    expect(lark.cardkit.v1.card.create).toHaveBeenCalled();
    expect(JSON.stringify(sentCard(lark))).toContain(ACTION_URL);
  });

  it("keeps the link in the text degradation when the card cannot be created", async () => {
    // The fallback text was the prose-only reply, so a CardKit failure lost the link a second way.
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "quota_exceeded", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 600_000, message: "Quota exceeded." },
    });
    const lark = makeCardClient();
    lark.cardkit.v1.card.create.mockRejectedValue(new Error("cardkit down"));

    await sendGated(lark as any);

    const reply = lark.im.message.reply.mock.calls[0][0].data.content as string;
    expect(reply).toContain("Quota exceeded.");
    expect(reply).toContain(ACTION_URL);
    // Present exactly once — the prose may already embed it, and a second copy is noise.
    expect(reply.split(ACTION_URL).length - 1).toBe(1);
  });

  it("does not duplicate a link the frontend already embedded in its prose", async () => {
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "quota_exceeded", actionUrl: ACTION_URL, message: `Go here: ${ACTION_URL}` },
    });
    const lark = makeLarkClient();   // no cardkit → text degradation

    await sendGated(lark);

    expect(denialText(lark).split(ACTION_URL).length - 1).toBe(1);
  });

  it("survives a non-string message instead of going silent", async () => {
    // `denied.message?.trim()` assumed a string. An object made it throw, the detached event
    // wrapper only logged, and the sender got NO reply — the failure this feature removes.
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "some_future_reason", message: { text: "not a string" } as any },
    });
    const lark = makeLarkClient();

    await sendGated(lark);

    expect(lark.im.message.reply).toHaveBeenCalled();
    expect(denialText(lark)).toContain("需要先获得授权");   // degrades to the generic notice
  });

  it("withholds a link that lapses between composing and sending", async () => {
    // The render decision says nothing about the state at the send boundary; a link can lapse in
    // between, and a dead URL must reach neither the button nor the text.
    const lark = makeCardClient();
    let calls = 0;
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => (++calls <= 1 ? realNow() : realNow() + 10 * 60_000));
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "binding_required", actionUrl: ACTION_URL, expiresAtMs: realNow() + 60_000 },
    });

    await sendGated(lark as any);

    expect(lark.cardkit.v1.card.create).not.toHaveBeenCalled();
    const reply = lark.im.message.reply.mock.calls[0][0].data.content as string;
    expect(reply).not.toContain(ACTION_URL);
    expect(reply).toContain("已过期");
    (Date.now as any).mockRestore();
  });

  it("does not repeat the URL in the card body when the prose already embeds it", async () => {
    // buildLinkActionCard documents the URL as button-only; passing prose that embeds it gave the
    // link a second rendering path and made that claim false. Enforced in the builder itself now.
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "quota_exceeded", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 600_000, message: `Continue here: ${ACTION_URL}` },
    });
    const lark = makeCardClient();

    await sendGated(lark as any);

    const card = sentCard(lark) as any;
    const bodyText = card.body.elements.filter((e: any) => e.tag === "markdown").map((e: any) => e.content).join("\n");
    expect(bodyText).not.toContain(ACTION_URL);
    expect(bodyText).toContain("Continue here");          // the prose itself survives
    expect(JSON.stringify(card)).toContain(ACTION_URL);   // still reachable, on the button
    expect(JSON.stringify(card).split(ACTION_URL).length - 1).toBe(1);
  });

  it("strips an embedded stale URL when the link lapses at the send boundary", async () => {
    // The expired branch reused card.body verbatim, and for an unknown reason that body IS the
    // frontend prose — which may carry the URL, putting the dead link straight back into the text.
    const lark = makeCardClient();
    let calls = 0;
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => (++calls <= 1 ? realNow() : realNow() + 10 * 60_000));
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "quota_exceeded", actionUrl: ACTION_URL, expiresAtMs: realNow() + 60_000, message: `Continue here: ${ACTION_URL}` },
    });

    await sendGated(lark as any);

    expect(lark.cardkit.v1.card.create).not.toHaveBeenCalled();
    const reply = lark.im.message.reply.mock.calls[0][0].data.content as string;
    expect(reply).toContain("已过期");
    expect(reply).not.toContain(ACTION_URL);   // neither button nor text
    (Date.now as any).mockRestore();
  });

  it("truncates a pathological message instead of losing the reply to a size limit", async () => {
    resolvePersonalBindingMock.mockResolvedValue({
      binding: null,
      denied: { reason: "unknown", message: "x".repeat(5000) },
    });
    const lark = makeLarkClient();

    await sendGated(lark);

    expect(denialText(lark).length).toBeLessThan(1100);
  });

  it("still answers a gated tier when the frontend sends no reason at all", async () => {
    // Regression: any tier this build did not recognise used to fall through to a log line only,
    // so the sender's message vanished with no reply and the bot looked dead.
    resolvePersonalBindingMock.mockResolvedValue({ binding: null });
    for (const tier of ["identified", "granted", "some_future_tier"]) {
      const lark = makeLarkClient();
      await sendGated(lark, tier);
      expect(denialText(lark), `tier=${tier}`).toContain("需要先获得授权");
    }
  });

  it("stays silent for an open tier with no binding — an anomaly, not a refusal", async () => {
    resolvePersonalBindingMock.mockResolvedValue({ binding: null });
    for (const tier of ["public", "open"]) {
      const lark = makeLarkClient();
      await sendGated(lark, tier);
      expect(lark.im.message.reply, `tier=${tier}`).not.toHaveBeenCalled();
    }
  });

  it("re-evaluates every message, so linking in another tab is picked up on the next one", async () => {
    const admitted = wrapBinding(makeBinding({
      bindingId: "personal-bot-1", sessionKey: "open_id:ou_user_1", routeType: "user", createdBy: "u1",
    }));
    // The admitted message resolves twice — once before enqueue, once after dequeue to catch
    // revocation — so the granted value must be the standing default, not a single `once`.
    resolvePersonalBindingMock
      .mockResolvedValue(admitted)
      .mockResolvedValueOnce({ binding: null, denied: { reason: "binding_required", actionUrl: ACTION_URL } });
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });

    const first = makeLarkClient();
    await sendGated(first);
    expect(denialText(first)).toContain(ACTION_URL);

    const second = makeLarkClient();
    await sendGated(second);
    expect(resolvePersonalBindingMock.mock.calls.length).toBeGreaterThanOrEqual(2);  // not cached
    expect(promptMock).toHaveBeenCalled();                                           // admitted on the retry
  });
});

// ── /apikey — self-service API key issuing (personal chat only) ─────
//
// Contract under test (docs/design/2026-07-28-feishu-apikey-command.md):
// deterministic parsing that never reaches the agent, only a bare `/apikey`
// may rotate, and the group path stays silent.

describe("handleLarkMessage — /apikey", () => {
  const PICKUP = "https://upstream.example/siclaw/api-key/pickup/9f3a2b";

  // Always an `open` personal bot: the handler never branches on the access mode (admission is
  // the frontend's call), so there is no mode-specific path left to parameterise here.
  function sendPersonal(text: string, lark: ReturnType<typeof makeLarkClient>) {
    return handleLarkMessage(
      makeTextEvent(text, { chat_type: "p2p" }),
      lark,
      "personal-bot-1",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      makePersonalConfig("open"),
    );
  }

  const replyText = (lark: ReturnType<typeof makeLarkClient>) =>
    lark.im.message.reply.mock.calls[0][0].data.content as string;

  it("issues a key and replies with the single-use pickup link", async () => {
    // RELATIVE, not a fixed instant: a hardcoded date silently became the past and the delivery
    // boundary then (correctly) withheld the link as expired, so the fixture — not the code — was
    // what broke. Exact timestamp formatting is covered by the dedicated timestamp cases.
    issuePersonalApiKeyMock.mockResolvedValue({
      success: true, agentId: "a1", pickupUrl: PICKUP, expiresAt: Date.now() + 5 * 60_000, rotated: false,
    });
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    // channel_id is the personal-bot config id; sender_open_id is the only identity source. The
    // inbound message_id rides along as a stable request id so the frontend can make a
    // destructive rotation idempotent across redelivery or a second gateway replica.
    expect(issuePersonalApiKeyMock).toHaveBeenCalledWith("personal-bot-1", "ou_user_1", expect.anything(), "mid-1");
    expect(replyText(lark)).toContain(PICKUP);
    expect(replyText(lark)).toContain("仅可打开一次");
    expect(replyText(lark)).toContain("链接过期时间");
    expect(promptMock).not.toHaveBeenCalled();             // never reaches the agent
  });

  it("delivers the pickup link as a card with a button, not as an unfurlable URL", async () => {
    issuePersonalApiKeyMock.mockResolvedValue({
      success: true, pickupUrl: PICKUP, expiresAt: Date.now() + 5 * 60_000 + 5_000, rotated: true,
    });
    const lark = {
      im: { message: { reply: vi.fn().mockResolvedValue({}) } },
      cardkit: { v1: { card: { create: vi.fn().mockResolvedValue({ data: { card_id: "CARD-KEY" } }) } } },
    };

    await handleLarkMessage(
      makeTextEvent("/apikey", { chat_type: "p2p" }),
      lark as any, "personal-bot-1", makeAgentBoxManager("a1") as any, undefined, {} as any,
      "zh-CN", makePersonalConfig("open"),
    );

    const card = JSON.stringify(JSON.parse(lark.cardkit.v1.card.create.mock.calls[0][0].data.data));
    expect(card).toContain("查看 API Key");     // button label
    expect(card).toContain("open_url");
    expect(card).toContain(PICKUP);             // on the button only
    expect(card).toContain("旧 Key 已失效");     // rotation warning survives the card form
    expect(card).toContain("5 分钟内有效");      // derived from expiresAt
    expect(card).toContain("/apikey status");   // affordance survives the card form
    const posted = lark.im.message.reply.mock.calls[0][0];
    expect(posted.data.msg_type).toBe("interactive");
    expect(posted.data.content).not.toContain(PICKUP);
  });

  it("rejects a success pickup URL that is not absolute http(s), and still warns the key rotated", async () => {
    for (const pickupUrl of ["/siclaw/api-key/pickup/token", "lark://open", "javascript:alert(1)"]) {
      issuePersonalApiKeyMock.mockResolvedValue({ success: true, pickupUrl, rotated: true });
      const lark = makeLarkClient();

      await sendPersonal("/apikey", lark);

      const reply = replyText(lark);
      expect(reply, pickupUrl).toContain("领取链接无效");
      expect(reply, pickupUrl).not.toContain(pickupUrl);
      // The rotation COMMITTED before we could reply. Reusing the "service unavailable" notice
      // here — the same string the no-frontend-client path sends — told a user whose key had just
      // been destroyed that nothing had happened.
      expect(reply, pickupUrl).toContain("旧 API Key 已失效");
      expect(reply, pickupUrl).not.toContain("暂时无法处理 API Key 请求");
    }
  });

  it("does NOT claim a rotation when the frontend did not report one", async () => {
    // Mirror of the case above: warning a first-time requester that their "previous key" died
    // sends them hunting for a break that never happened.
    issuePersonalApiKeyMock.mockResolvedValue({ success: true, pickupUrl: "lark://open" });
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    const reply = replyText(lark);
    expect(reply).toContain("领取链接无效");
    expect(reply).not.toContain("旧 API Key 已失效");
  });

  it("withholds an expired pickup link, tells the sender to rerun /apikey, and warns it rotated", async () => {
    issuePersonalApiKeyMock.mockResolvedValue({
      success: true, pickupUrl: PICKUP, expiresAt: Date.now() - 1, rotated: true,
    });
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    const reply = replyText(lark);
    expect(reply).toContain("重新发送 /apikey");
    expect(reply).not.toContain("已就绪");
    expect(reply).not.toContain(PICKUP);
    // The expired short-circuit replaces the card body wholesale, and the body is the only other
    // place the rotation was stated — so dropping it here left "a link expired" as the whole
    // explanation for a dead credential.
    expect(reply).toContain("旧 API Key 已失效");
  });

  it("does NOT claim a rotation on an expired link the frontend never rotated for", async () => {
    issuePersonalApiKeyMock.mockResolvedValue({
      success: true, pickupUrl: PICKUP, expiresAt: Date.now() - 1,
    });
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    const reply = replyText(lark);
    expect(reply).toContain("重新发送 /apikey");
    expect(reply).not.toContain("旧 API Key 已失效");
  });

  it("escalates when a committed rotation's card AND its text fallback both fail", async () => {
    // The rotation already happened, so losing both delivery paths means the sender's old key is
    // dead with no link to show for it — that must not pass silently.
    issuePersonalApiKeyMock.mockResolvedValue({ success: true, pickupUrl: PICKUP, rotated: true });
    const errors: string[] = [];
    (console.error as any).mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
    const lark = {
      im: { message: { reply: vi.fn().mockResolvedValue({ code: 99991672 }) } },
      cardkit: { v1: { card: { create: vi.fn().mockRejectedValue(new Error("cardkit down")) } } },
    };

    await handleLarkMessage(
      makeTextEvent("/apikey", { chat_type: "p2p" }),
      lark as any, "personal-bot-1", makeAgentBoxManager("a1") as any, undefined, {} as any,
      "zh-CN", makePersonalConfig("open"),
    );

    expect(errors.join("\n")).toContain("UNDELIVERED after rotation");
    expect(errors.join("\n")).not.toContain(PICKUP);
  });

  it("warns that the previous key died when the frontend reports a rotation", async () => {
    issuePersonalApiKeyMock.mockResolvedValue({ success: true, pickupUrl: PICKUP, rotated: true });
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    expect(replyText(lark)).toContain("旧 Key 已失效");
  });

  it("refuses with ONE ❌ about getting a key, and says how to resume", async () => {
    // The bug this replaces: two stacked ❌ lines for one refusal, the second talking about
    // "using this assistant" when the sender had asked for a key — and nothing telling them that
    // after linking they must send /apikey again, so the flow looked broken.
    issuePersonalApiKeyMock.mockResolvedValue({
      success: false,
      denied: { reason: "binding_required", actionUrl: PICKUP, expiresAtMs: Date.now() + 9 * 60_000 + 5_000 },
    });
    const lark = makeLarkClient();   // no cardkit → text fallback

    await sendPersonal("/apikey", lark);

    const reply = replyText(lark);
    expect(reply.split("❌").length - 1).toBe(1);        // exactly one
    expect(reply).toContain("领取 API Key 需要先关联账号");
    expect(reply).not.toContain("使用这个助手");           // wrong action
    expect(reply).toContain("回来重发 /apikey");           // how to resume
  });

  it("sends an /apikey refusal as a card when it carries a live link", async () => {
    issuePersonalApiKeyMock.mockResolvedValue({
      success: false,
      denied: { reason: "access_request_required", actionUrl: PICKUP, expiresAtMs: Date.now() + 60_000 },
    });
    const lark = {
      im: { message: { reply: vi.fn().mockResolvedValue({}) } },
      cardkit: { v1: { card: { create: vi.fn().mockResolvedValue({ data: { card_id: "CARD-DENY" } }) } } },
    };

    await handleLarkMessage(
      makeTextEvent("/apikey", { chat_type: "p2p" }),
      lark as any, "personal-bot-1", makeAgentBoxManager("a1") as any, undefined, {} as any,
      "zh-CN", makePersonalConfig("open"),
    );

    const card = JSON.stringify(JSON.parse(lark.cardkit.v1.card.create.mock.calls[0][0].data.data));
    expect(card).toContain("需要该 Agent 的使用授权");
    expect(card).toContain("审批通过后回来重发");
    expect(card).toContain("申请权限");     // button label
    expect(card).toContain(PICKUP);
    expect(lark.im.message.reply.mock.calls[0][0].data.content).not.toContain(PICKUP);
  });

  it("delivers a future reason's link on the /apikey path too", async () => {
    // rendersActionLink accepted the refusal but the /apikey copy lookup vetoed it afterwards, so a
    // reason this build has never seen lost its structured link — the sibling path of the fix made
    // for ordinary messages.
    issuePersonalApiKeyMock.mockResolvedValue({
      success: false,
      denied: { reason: "quota_exceeded", actionUrl: PICKUP, expiresAtMs: Date.now() + 60_000 },
    });
    const lark = {
      im: { message: { reply: vi.fn().mockResolvedValue({}) } },
      cardkit: { v1: { card: { create: vi.fn().mockResolvedValue({ data: { card_id: "C" } }) } } },
    };

    await handleLarkMessage(
      makeTextEvent("/apikey", { chat_type: "p2p" }),
      lark as any, "personal-bot-1", makeAgentBoxManager("a1") as any, undefined, {} as any,
      "zh-CN", makePersonalConfig("open"),
    );

    expect(lark.cardkit.v1.card.create).toHaveBeenCalled();
    const card = JSON.stringify(JSON.parse(lark.cardkit.v1.card.create.mock.calls[0][0].data.data));
    expect(card).toContain(PICKUP);
    expect(card).toContain("继续");                 // neutral label for an unfamiliar reason
    expect(card).toContain("重发 /apikey");          // generic resume line
  });

  it("keeps the frontend's explanation when /apikey has neither template nor link", async () => {
    // `message` is defined as the fallback for a reason this build has no template for; the failure
    // path skipped straight to `error` and replaced a real explanation with "unknown error".
    issuePersonalApiKeyMock.mockResolvedValue({
      success: false,
      denied: { reason: "quota_exceeded", message: "Quota exceeded for this account." },
    });
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    expect(replyText(lark)).toContain("Quota exceeded for this account.");
    expect(replyText(lark)).not.toContain("未知错误");
  });

  it("says nothing about links when /apikey is refused with no self-service step", async () => {
    // The expired notice used to hang off `actionUrl` alone, so access_denied + a LIVE link was told
    // "your link expired, resend" — and the resend refuses identically. That is the dead-end loop.
    issuePersonalApiKeyMock.mockResolvedValue({
      success: false,
      denied: { reason: "access_denied", actionUrl: "https://x.example/live", expiresAtMs: Date.now() + 600_000 },
    });
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    const reply = replyText(lark);
    expect(reply).toContain("未开放自助申请");
    expect(reply).not.toContain("已过期");
    expect(reply).not.toContain("https://x.example/live");
    expect(reply).not.toContain("分钟内");
  });

  it("withholds an actionUrl that is not plain http(s)", async () => {
    // It lands on a Feishu open_url button, where other schemes resolve as deeplinks. Every other
    // field of `denied` is treated as untrusted; the scheme gets the same treatment.
    for (const actionUrl of ["javascript:alert(1)", "lark://open", "not a url"]) {
      issuePersonalApiKeyMock.mockResolvedValue({
        success: false,
        denied: { reason: "binding_required", actionUrl, expiresAtMs: Date.now() + 600_000 },
      });
      const lark = makeLarkClient();
      await sendPersonal("/apikey", lark);
      expect(replyText(lark), actionUrl).not.toContain(actionUrl);
    }
  });

  it("gives no link for a closed-self-service /apikey refusal", async () => {
    issuePersonalApiKeyMock.mockResolvedValue({ success: false, denied: { reason: "access_denied" } });
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    const reply = replyText(lark);
    expect(reply).toContain("未开放自助申请");
    expect(reply).not.toContain("http");
    expect(reply).not.toContain("重发 /apikey");   // nothing for them to retry into
  });

  it("surfaces the frontend's failure reason verbatim", async () => {
    issuePersonalApiKeyMock.mockResolvedValue({
      success: false,
      error: "你的飞书账号还没完成授权，无法领取此 Agent 的 Key。",
    });
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    expect(replyText(lark)).toContain("你的飞书账号还没完成授权");
  });

  it("bounds an oversized frontend error before sending it to Feishu", async () => {
    issuePersonalApiKeyMock.mockResolvedValue({ success: false, error: "x".repeat(2_000) });
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    const reply = replyText(lark);
    expect(reply).toContain("x".repeat(1_000));
    expect(reply).not.toContain("x".repeat(1_001));
    expect(reply).toContain("…");
  });

  it("works on an OPEN personal bot — unlike PAIR, issuing is not gated on the authorized mode", async () => {
    issuePersonalApiKeyMock.mockResolvedValue({ success: true, pickupUrl: PICKUP });
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    expect(issuePersonalApiKeyMock).toHaveBeenCalledTimes(1);
    expect(replyText(lark)).toContain(PICKUP);
  });

  it("/apikey status reports the current key and rotates nothing", async () => {
    getPersonalApiKeyStatusMock.mockResolvedValue({
      success: true, exists: true, keyPrefix: "sk-a1b2c3d4",
      lastUsedAt: 1753605840000, expiresAt: 1756197840000,
    });
    const lark = makeLarkClient();

    await sendPersonal("/apikey status", lark);

    expect(getPersonalApiKeyStatusMock).toHaveBeenCalledWith("personal-bot-1", "ou_user_1", expect.anything());
    expect(issuePersonalApiKeyMock).not.toHaveBeenCalled(); // read-only path
    const reply = replyText(lark);
    expect(reply).toContain("sk-a1b2c3d4");
    expect(reply).toContain("2025-07-27 16:44"); // last used
    expect(reply).toContain("2025-08-26");       // sliding expiry (date only)
  });

  it("/apikey status caps an oversized upstream error instead of going silent", async () => {
    // Same untrusted field and same failure mode as the issue path: an unbounded `error` makes the
    // reply exceed the Feishu limit, `replyToLark` swallows the non-zero code, and the sender who
    // was promised an answer gets nothing.
    getPersonalApiKeyStatusMock.mockResolvedValue({ success: false, error: "x".repeat(5_000) });
    const lark = makeLarkClient();

    await sendPersonal("/apikey status", lark);

    const reply = replyText(lark);
    expect(reply).toContain("查询 API Key 状态失败");
    expect(reply).toContain("x".repeat(1_000));
    expect(reply).not.toContain("x".repeat(1_001));
    expect(reply).toContain("…");
  });

  it("/apikey status renders a non-string upstream error as the unknown-error fallback", async () => {
    // A bare `??` let a structured value through and interpolated it as "[object Object]".
    getPersonalApiKeyStatusMock.mockResolvedValue({ success: false, error: { code: 500 } });
    const lark = makeLarkClient();

    await sendPersonal("/apikey status", lark);

    const reply = replyText(lark);
    expect(reply).toContain("未知错误");
    expect(reply).not.toContain("[object Object]");
  });

  it("/apikey status tells a first-time user how to get one", async () => {
    getPersonalApiKeyStatusMock.mockResolvedValue({ success: true, exists: false });
    const lark = makeLarkClient();

    await sendPersonal("/apikey status", lark);

    expect(replyText(lark)).toContain("还没有这个 Agent 的 API Key");
  });

  it("an unrecognised subcommand shows usage and issues NO rpc (a typo must not rotate)", async () => {
    const lark = makeLarkClient();

    await sendPersonal("/apikey statu", lark);

    expect(issuePersonalApiKeyMock).not.toHaveBeenCalled();
    expect(getPersonalApiKeyStatusMock).not.toHaveBeenCalled();
    expect(replyText(lark)).toContain("无法识别的 /apikey 子命令");
  });

  it("replies (does not go silent) when the rpc throws", async () => {
    issuePersonalApiKeyMock.mockRejectedValue(new Error("frontend ws closed"));
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    expect(replyText(lark)).toContain("暂时无法处理 API Key 请求");
  });

  it("replies when no frontend client is wired", async () => {
    const lark = makeLarkClient();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Called directly, not via sendPersonal: passing `undefined` to a defaulted parameter
    // would fall back to the stub client and defeat the point of this case.
    await handleLarkMessage(
      makeTextEvent("/apikey", { chat_type: "p2p" }),
      lark,
      "personal-bot-1",
      makeAgentBoxManager("a1") as any,
      undefined,
      undefined,
      "zh-CN",
      makePersonalConfig("open"),
    );

    expect(issuePersonalApiKeyMock).not.toHaveBeenCalled();
    expect(replyText(lark)).toContain("暂时无法处理 API Key 请求");
  });

  it("treats an out-of-range or zero timestamp as absent instead of throwing or printing 1970", async () => {
    // A frontend sending nanoseconds passes Number.isFinite but makes Intl.format throw
    // RangeError; that throw would surface as "unavailable" AFTER the key was already rotated.
    issuePersonalApiKeyMock.mockResolvedValue({
      success: true, pickupUrl: PICKUP, expiresAt: 1753800000000000000, rotated: true,
    });
    const lark = makeLarkClient();

    await sendPersonal("/apikey", lark);

    const reply = replyText(lark);
    expect(reply).toContain(PICKUP);            // the link still reaches the user
    expect(reply).not.toContain("暂时无法处理");  // not swallowed as an outage
    expect(reply).not.toContain("链接过期时间");  // unusable value simply omitted

    getPersonalApiKeyStatusMock.mockResolvedValue({
      success: true, exists: true, keyPrefix: "sk-a1b2c3d4", lastUsedAt: 0, expiresAt: 0,
    });
    const lark2 = makeLarkClient();
    await sendPersonal("/apikey status", lark2);
    expect(replyText(lark2)).toContain("从未使用");
    expect(replyText(lark2)).not.toContain("1970");
  });

  it("does not advise the destructive /apikey when a prefix proves a key exists", async () => {
    // `exists` is optional on the wire; inferring absence from a missing field would tell the
    // user to run the rotating command against the key they were trying to inspect.
    getPersonalApiKeyStatusMock.mockResolvedValue({ success: true, keyPrefix: "sk-a1b2c3d4" });
    const lark = makeLarkClient();

    await sendPersonal("/apikey status", lark);

    expect(replyText(lark)).toContain("sk-a1b2c3d4");
    expect(replyText(lark)).not.toContain("还没有这个 Agent 的 API Key");
  });

  it("rejects a second concurrent request so a double-tap cannot rotate twice", async () => {
    let release!: (v: unknown) => void;
    issuePersonalApiKeyMock.mockReturnValue(new Promise((r) => { release = r; }));
    const first = makeLarkClient();
    const second = makeLarkClient();

    const inflight = sendPersonal("/apikey", first);
    await sendPersonal("/apikey", second); // lands while the first is still open

    expect(issuePersonalApiKeyMock).toHaveBeenCalledTimes(1); // no second rotation
    expect(replyText(second)).toContain("正在处理你上一条 API Key 请求");

    release({ success: true, pickupUrl: PICKUP });
    await inflight;
    expect(replyText(first)).toContain(PICKUP);

    // The slot is freed once settled, so a later request works normally.
    issuePersonalApiKeyMock.mockResolvedValue({ success: true, pickupUrl: PICKUP });
    const third = makeLarkClient();
    await sendPersonal("/apikey", third);
    expect(issuePersonalApiKeyMock).toHaveBeenCalledTimes(2);
  });

  // Rotation commits upstream BEFORE we can reply, and replyToLark swallows both failure shapes,
  // so a lost reply means the requester's old key is dead with no link to show for it. Delivery
  // must therefore be checked, retried once, and — if still lost — recorded loudly.
  for (const [shape, makeFailingLark] of [
    ["thrown send failure", () => ({ im: { message: { reply: vi.fn().mockRejectedValue(new Error("feishu down")) } } })],
    ["non-zero Feishu code", () => ({ im: { message: { reply: vi.fn().mockResolvedValue({ code: 99991672, msg: "no permission" }) } } })],
  ] as const) {
    it(`retries and records an audit line when a ${shape} loses a delivered rotation`, async () => {
      issuePersonalApiKeyMock.mockResolvedValue({ success: true, pickupUrl: PICKUP, rotated: true });
      const errors: string[] = [];
      (console.error as any).mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
      const lark = makeFailingLark();

      await sendPersonal("/apikey", lark as any);

      expect(lark.im.message.reply).toHaveBeenCalledTimes(2); // one retry for the transient case
      expect(errors.join("\n")).toContain("UNDELIVERED after rotation");
      expect(errors.join("\n")).toContain("ou_user_1");       // names the affected sender
      expect(errors.join("\n")).not.toContain(PICKUP);        // never logs the bearer link
    });
  }

  it("does not escalate a lost reply when nothing was rotated", async () => {
    // A failed issue has no committed side effect, so a lost reply is an ordinary retriable
    // no-op — it must not be retried or reported as a lost credential.
    issuePersonalApiKeyMock.mockResolvedValue({ success: false, error: "not authorized" });
    const errors: string[] = [];
    (console.error as any).mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
    const lark = { im: { message: { reply: vi.fn().mockResolvedValue({ code: 99991672 }) } } };

    await sendPersonal("/apikey", lark as any);

    expect(lark.im.message.reply).toHaveBeenCalledTimes(1);
    expect(errors.join("\n")).not.toContain("UNDELIVERED after rotation");
  });

  it("claims the whole namespace — /apikeys never reaches the agent", async () => {
    const lark = makeLarkClient();

    await sendPersonal("/apikeys", lark);

    expect(replyText(lark)).toContain("无法识别的 /apikey 子命令");
    expect(promptMock).not.toHaveBeenCalled();
    expect(issuePersonalApiKeyMock).not.toHaveBeenCalled();
  });

  it("is ignored in a group chat — no reply, no rpc, never routed to the agent", async () => {
    const lark = makeLarkClient();

    for (const text of ["/apikey", "/apikey status", "/apikeys"]) {
      await handleLarkMessage(
        makeTextEvent(text, {
          chat_type: "group",
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_self" } }],
        }),
        lark,
        "group-channel-1",
        makeAgentBoxManager("a1") as any,
        undefined,
        {} as any,
        "zh-CN",
        undefined,
        "ou_bot_self",
      );
    }

    // The group gate must claim exactly what the personal gate claims — it is the side whose
    // failure mode is posting a credential reply to a whole room.
    expect(issuePersonalApiKeyMock).not.toHaveBeenCalled();
    expect(getPersonalApiKeyStatusMock).not.toHaveBeenCalled();
    expect(resolveBindingMock).not.toHaveBeenCalled();
    expect(lark.im.message.reply).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });
});

// ── /webchat — self-service browser chat link (personal chat only) ──

describe("handleLarkMessage — /webchat", () => {
  const ACTION_URL = "https://control-plane.example/siclaw/webchat/claim/token-1";

  function sendPersonal(text: string, lark: ReturnType<typeof makeLarkClient>) {
    return handleLarkMessage(
      makeTextEvent(text, { chat_type: "p2p" }),
      lark,
      "personal-bot-1",
      makeAgentBoxManager("a1") as any,
      undefined,
      {} as any,
      "zh-CN",
      makePersonalConfig("platform_authorized"),
    );
  }

  const replyText = (lark: ReturnType<typeof makeLarkClient>) =>
    lark.im.message.reply.mock.calls[0][0].data.content as string;

  it("issues a link with the stable inbound message id and never reaches the agent", async () => {
    issuePersonalWebChatLinkMock.mockResolvedValue({
      success: true, agentId: "a1", actionUrl: ACTION_URL, expiresAt: Date.now() + 5 * 60_000,
    });
    const lark = makeLarkClient();

    await sendPersonal("/webchat", lark);

    expect(issuePersonalWebChatLinkMock).toHaveBeenCalledWith(
      "personal-bot-1", "ou_user_1", expect.anything(), "mid-1",
    );
    expect(replyText(lark)).toContain(ACTION_URL);
    expect(replyText(lark)).toContain("全新的空白对话");
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("delivers the link as a card button when CardKit is available", async () => {
    issuePersonalWebChatLinkMock.mockResolvedValue({
      success: true, actionUrl: ACTION_URL, expiresAt: Date.now() + 5 * 60_000 + 5_000,
    });
    const lark = {
      im: { message: { reply: vi.fn().mockResolvedValue({}) } },
      cardkit: { v1: { card: { create: vi.fn().mockResolvedValue({ data: { card_id: "CARD-WEBCHAT" } }) } } },
    };

    await handleLarkMessage(
      makeTextEvent("/webchat", { chat_type: "p2p" }),
      lark as any, "personal-bot-1", makeAgentBoxManager("a1") as any, undefined, {} as any,
      "zh-CN", makePersonalConfig("platform_authorized"),
    );

    const card = JSON.stringify(JSON.parse(lark.cardkit.v1.card.create.mock.calls[0][0].data.data));
    expect(card).toContain("打开网页对话");
    expect(card).toContain(ACTION_URL);
    expect(card).toContain("5 分钟内有效");
    expect(lark.im.message.reply.mock.calls[0][0].data.msg_type).toBe("interactive");
    expect(lark.im.message.reply.mock.calls[0][0].data.content).not.toContain(ACTION_URL);
  });

  it("rejects a success URL that is not absolute http(s)", async () => {
    for (const actionUrl of ["/siclaw/webchat/claim/token", "lark://open", "javascript:alert(1)"]) {
      issuePersonalWebChatLinkMock.mockResolvedValue({ success: true, actionUrl });
      const lark = makeLarkClient();

      await sendPersonal("/webchat", lark);

      expect(replyText(lark), actionUrl).toContain("暂时无法生成网页对话链接");
      expect(replyText(lark), actionUrl).not.toContain(actionUrl);
    }
  });

  it("withholds an already-expired success link and tells the sender to rerun /webchat", async () => {
    issuePersonalWebChatLinkMock.mockResolvedValue({
      success: true, actionUrl: ACTION_URL, expiresAt: Date.now() - 1,
    });
    const lark = makeLarkClient();

    await sendPersonal("/webchat", lark);

    const reply = replyText(lark);
    expect(reply).toContain("重新发送 /webchat");
    expect(reply).not.toContain("已就绪");
    expect(reply).not.toContain(ACTION_URL);
  });

  it("bounds a frontend error so an oversized reply cannot be dropped by Feishu", async () => {
    issuePersonalWebChatLinkMock.mockResolvedValue({ success: false, error: "x".repeat(2_000) });
    const lark = makeLarkClient();

    await sendPersonal("/webchat", lark);

    const reply = replyText(lark);
    expect(reply).toContain("x".repeat(1_000));
    expect(reply).not.toContain("x".repeat(1_001));
    expect(reply).toContain("…");
  });

  it("renders a binding refusal with the webchat-specific resume instruction", async () => {
    issuePersonalWebChatLinkMock.mockResolvedValue({
      success: false,
      denied: { reason: "binding_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 60_000 },
    });
    const lark = makeLarkClient();

    await sendPersonal("/webchat", lark);

    const reply = replyText(lark);
    expect(reply).toContain("打开网页对话需要先关联账号");
    expect(reply).toContain("回来重发 /webchat");
    expect(reply).not.toContain("/apikey");
    expect(reply).toContain(ACTION_URL);
  });

  it("delivers an actionable refusal as a card without exposing its URL as text", async () => {
    issuePersonalWebChatLinkMock.mockResolvedValue({
      success: false,
      denied: {
        reason: "access_request_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 60_000,
      },
    });
    const lark = {
      im: { message: { reply: vi.fn().mockResolvedValue({}) } },
      cardkit: { v1: { card: { create: vi.fn().mockResolvedValue({ data: { card_id: "DENIAL" } }) } } },
    };

    await handleLarkMessage(
      makeTextEvent("/webchat", { chat_type: "p2p" }),
      lark as any, "personal-bot-1", makeAgentBoxManager("a1") as any, undefined, {} as any,
      "zh-CN", makePersonalConfig("platform_authorized"),
    );

    const card = JSON.stringify(JSON.parse(lark.cardkit.v1.card.create.mock.calls[0][0].data.data));
    expect(card).toContain("需要该 Agent 的使用授权");
    expect(card).toContain("回来重发 /webchat");
    expect(card).toContain("申请权限");
    expect(card).toContain(ACTION_URL);
    expect(lark.im.message.reply.mock.calls[0][0].data.content).not.toContain(ACTION_URL);
  });

  it("keeps a future denial reason actionable with generic webchat copy", async () => {
    issuePersonalWebChatLinkMock.mockResolvedValue({
      success: false,
      denied: { reason: "quota_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 60_000 },
    });
    const lark = makeLarkClient();

    await sendPersonal("/webchat", lark);

    const reply = replyText(lark);
    expect(reply).toContain("打开网页对话需要先获得授权");
    expect(reply).toContain("重发 /webchat");
    expect(reply).toContain(ACTION_URL);
  });

  it("withholds links and retry copy for a refusal with no self-service step", async () => {
    issuePersonalWebChatLinkMock.mockResolvedValue({
      success: false,
      denied: { reason: "access_denied", actionUrl: ACTION_URL, expiresAtMs: Date.now() + 60_000 },
    });
    const lark = makeLarkClient();

    await sendPersonal("/webchat", lark);

    const reply = replyText(lark);
    expect(reply).toContain("未开放自助申请");
    expect(reply).not.toContain(ACTION_URL);
    expect(reply).not.toContain("重发 /webchat");
  });

  it("withholds an expired denial link but preserves the webchat resume instruction", async () => {
    issuePersonalWebChatLinkMock.mockResolvedValue({
      success: false,
      denied: { reason: "binding_required", actionUrl: ACTION_URL, expiresAtMs: Date.now() - 1 },
    });
    const lark = makeLarkClient();

    await sendPersonal("/webchat", lark);

    const reply = replyText(lark);
    expect(reply).toContain("链接已过期");
    expect(reply).toContain("回来重发 /webchat");
    expect(reply).not.toContain(ACTION_URL);
  });

  it("claims a whitespace-delimited typo but sends no RPC", async () => {
    const lark = makeLarkClient();

    await sendPersonal("/webchat open", lark);

    expect(replyText(lark)).toContain("无法识别的 /webchat 子命令");
    expect(issuePersonalWebChatLinkMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("deliberately leaves other tokens with the same prefix as ordinary prompts", async () => {
    resolvePersonalBindingMock.mockResolvedValue(wrapBinding(makeBinding({
      bindingId: "personal-bot-1", sessionKey: "open_id:ou_user_1", routeType: "user",
    })));
    promptMock.mockResolvedValue({ sessionId: "session-fixed" });
    streamEventsMock.mockImplementation(async function* () { /* empty */ });
    const lark = makeLarkClient();

    await sendPersonal("/webchats explain the service", lark);

    expect(issuePersonalWebChatLinkMock).not.toHaveBeenCalled();
    expect(promptMock).toHaveBeenCalled();
  });

  it("replies with an unavailable notice when the frontend RPC throws", async () => {
    issuePersonalWebChatLinkMock.mockRejectedValue(new Error("unknown method: channel.issueWebChatLink"));
    const lark = makeLarkClient();

    await sendPersonal("/webchat", lark);

    expect(replyText(lark)).toContain("暂时无法生成网页对话链接");
  });

  it("rejects a second overlapping request and frees the slot after settlement", async () => {
    let release!: (value: unknown) => void;
    issuePersonalWebChatLinkMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const first = makeLarkClient();
    const second = makeLarkClient();

    const inflight = sendPersonal("/webchat", first);
    await sendPersonal("/webchat", second);

    expect(issuePersonalWebChatLinkMock).toHaveBeenCalledTimes(1);
    expect(replyText(second)).toContain("正在生成你的网页对话链接");

    release({ success: true, actionUrl: ACTION_URL });
    await inflight;

    issuePersonalWebChatLinkMock.mockResolvedValue({ success: true, actionUrl: ACTION_URL });
    await sendPersonal("/webchat", makeLarkClient());
    expect(issuePersonalWebChatLinkMock).toHaveBeenCalledTimes(2);
  });

  it("drops the actual command in groups, but not a different slash command sharing its prefix", async () => {
    const exact = makeLarkClient();
    for (const text of ["/webchat", "/webchat open"]) {
      await handleLarkMessage(
        makeTextEvent(text, {
          chat_type: "group",
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_self" } }],
        }), exact, "group-channel-1",
        makeAgentBoxManager("a1") as any, undefined, {} as any, "zh-CN",
        undefined, "ou_bot_self",
      );
    }
    expect(exact.im.message.reply).not.toHaveBeenCalled();
    expect(issuePersonalWebChatLinkMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
    expect(resolveBindingMock).not.toHaveBeenCalled();

    resolveBindingMock.mockResolvedValue(null);
    await handleLarkMessage(
      makeTextEvent("@_user_1 /webchatops inspect", {
        chat_type: "group",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_self" } }],
      }),
      makeLarkClient(), "group-channel-1", makeAgentBoxManager("a1") as any,
      undefined, {} as any, "zh-CN", undefined, "ou_bot_self",
    );
    expect(resolveBindingMock).toHaveBeenCalled();
  });
});
