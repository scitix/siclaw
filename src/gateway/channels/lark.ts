/**
 * Lark (飞书) channel handler.
 *
 * Connects to Lark via WebSocket-based event subscription.
 * Routes messages dynamically via channel_bindings (not hardcoded agent).
 * Supports PAIR command for binding chat groups to agents.
 */

import type { AgentBoxManager } from "../agentbox/manager.js";
import { AgentBoxClient, type PromptOptions } from "../agentbox/client.js";
import type { ChannelHandler } from "../channel-manager.js";
import {
  resolveBinding,
  handlePairingCode,
  resetBindingSession,
  resolvePersonalBinding,
  handlePersonalPairingCode,
  resetPersonalSession,
  type ResolvedChannelBinding,
} from "../channel-manager.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";
import { sessionRegistry } from "../session-registry.js";
import { appendMessage, ensureChatSession } from "../chat-repo.js";
import {
  openTypingCard,
  updateCardContent,
  finalizeCard,
  PLACEHOLDER_BY_LOCALE,
  EMPTY_RESULT_NOTICE_BY_LOCALE,
  localeForDomain,
} from "./lark-card.js";
import { collectImageAttachments, stripVisualBlocks, type RenderedReplyImage } from "./visual-image.js";
import { replyImageToLark } from "./lark-image.js";
import { registerBackgroundChannelDelivery } from "./background-delivery.js";

const VISUAL_ONLY_NOTICE_BY_LOCALE = {
  "zh-CN": "已生成图片如下。",
  "en-US": "Image generated below.",
} as const;
const QUEUE_FULL_NOTICE_BY_LOCALE = {
  "zh-CN": "⏳ 当前会话还有较多消息排队处理中，请稍后再发。",
  "en-US": "⏳ This channel session already has several messages queued. Please try again later.",
} as const;
const NEW_SESSION_NOTICE_BY_LOCALE = {
  "zh-CN": "✅ 已开启新会话，此入口中的历史上下文已清空。",
  "en-US": "✅ Started a new session. Previous context for this channel entry has been cleared.",
} as const;
const MISSING_OWNER_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 当前群绑定缺少会话归属信息，请在 Agent 页面重新生成 PAIR code 并在群里重新绑定。",
  "en-US": "❌ This group binding is missing a session owner. Generate a fresh PAIR code from the Agent page and pair this group again.",
} as const;
const PERSONAL_BIND_REQUIRED_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 这个个人机器人需要先绑定 Sicore 账号。请打开 Sicore 的 Agent Channels 页面，点击“授权飞书账号”后再回来私聊。",
  "en-US": "❌ This personal bot requires Sicore authorization. Open the Sicore Agent Channels page, click “Authorize Feishu account”, then come back to this chat.",
} as const;
const MAX_AGENT_SELECTED_UPDATES = 2;
const MAX_LARK_BINDING_QUEUE = 20;

interface QueuedLarkTask {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface LarkBindingQueue {
  running: boolean;
  pending: QueuedLarkTask[];
}

const bindingQueues = new Map<string, LarkBindingQueue>();

export interface LarkChannelConfig {
  domain?: "feishu" | "lark";  // feishu = China (default), lark = Global
  app_id: string;
  app_secret: string;
  group_channel_id?: string;
  verification_token?: string;
  encrypt_key?: string;
  personal_bot?: {
    channel_id?: string;
    agent_id: string;
    access_mode: "open" | "sicore_authorized";
    owner_user_id?: string;
    authorize_url?: string;
  };
}

/**
 * Create a Lark channel handler for one global channel record.
 */
export function createLarkHandler(
  channel: Record<string, any>,
  agentBoxManager: AgentBoxManager,
  tlsOptions?: { cert: string; key: string; ca: string },
  frontendClient?: FrontendWsClient,
): ChannelHandler {
  const channelId: string = channel.id;
  const config: LarkChannelConfig =
    typeof channel.config === "string"
      ? JSON.parse(channel.config)
      : channel.config;

  let wsClient: { close(params?: { force?: boolean }): void } | null = null;

  return {
    async start() {
      let lark: typeof import("@larksuiteoapi/node-sdk");
      try {
        lark = await import("@larksuiteoapi/node-sdk");
      } catch {
        console.error(`[lark] @larksuiteoapi/node-sdk not installed — skipping channel ${channelId}`);
        return;
      }

      // domain: "lark" → open.larksuite.com (global), default → open.feishu.cn (China)
      const domain = config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
      const larkClient = new lark.Client({
        appId: config.app_id,
        appSecret: config.app_secret,
        domain,
      });

      const dispatcher = new lark.EventDispatcher({
        verificationToken: config.verification_token,
        encryptKey: config.encrypt_key,
      });

      dispatcher.register({
        // Feishu's WSClient waits for this handler to resolve before it sends
        // the ACK frame back. If we hold it open while the agent runs (10-30s),
        // Feishu times out the in-flight event and redelivers — the handler
        // then runs a second time and the user sees two replies. Resolve
        // immediately and kick the actual work onto a detached task so the
        // ACK ships in <1ms and redelivery never triggers.
        "im.message.receive_v1": (data: any) => {
          setImmediate(() => {
            handleLarkMessage(data, larkClient, channelId, agentBoxManager, tlsOptions, frontendClient, localeForDomain(config.domain), config)
              .catch((err) => {
                console.error(`[lark] Error handling message for channel=${channelId}:`, err);
              });
          });
          return Promise.resolve();
        },
      });

      const ws = new lark.WSClient({
        appId: config.app_id,
        appSecret: config.app_secret,
      });

      try {
        await ws.start({ eventDispatcher: dispatcher });
        wsClient = ws;
        console.log(`[lark] Channel started id=${channelId} app=${config.app_id}`);
      } catch (err) {
        console.error(`[lark] Failed to start channel ${channelId}:`, err);
      }
    },

    async stop() {
      if (wsClient) wsClient.close({ force: true });
      wsClient = null;
      console.log(`[lark] Channel stopped id=${channelId}`);
    },
  };
}

export function resetLarkBindingQueuesForTest(): void {
  bindingQueues.clear();
}

function enqueueBindingTask(bindingId: string, run: () => Promise<void>): { accepted: true; done: Promise<void> } | { accepted: false } {
  let queue = bindingQueues.get(bindingId);
  if (!queue) {
    queue = { running: false, pending: [] };
    bindingQueues.set(bindingId, queue);
  }

  if (queue.pending.length >= MAX_LARK_BINDING_QUEUE) {
    return { accepted: false };
  }

  const done = new Promise<void>((resolve, reject) => {
    queue!.pending.push({ run, resolve, reject });
  });
  drainBindingQueue(bindingId);
  return { accepted: true, done };
}

function drainBindingQueue(bindingId: string): void {
  const queue = bindingQueues.get(bindingId);
  if (!queue || queue.running) return;
  const next = queue.pending.shift();
  if (!next) {
    bindingQueues.delete(bindingId);
    return;
  }

  queue.running = true;
  void (async () => {
    try {
      await next.run();
      next.resolve();
    } catch (err) {
      next.reject(err);
    } finally {
      const current = bindingQueues.get(bindingId);
      if (current) {
        current.running = false;
        drainBindingQueue(bindingId);
      }
    }
  })();
}

function getLarkSenderOpenId(data: any): string | null {
  const senderId = data?.sender?.sender_id ?? data?.event?.sender?.sender_id;
  const openId = senderId?.open_id;
  return typeof openId === "string" && openId.trim() ? openId.trim() : null;
}

function buildLarkSessionKey(senderOpenId: string | null, chatId: string): string {
  return senderOpenId ? `open_id:${senderOpenId}` : `chat:${chatId}`;
}

export function buildChannelTurnPrompt(text: string): string {
  return [
    "<channel-turn>",
    "This Feishu/Lark channel session may contain earlier incidents, clusters, pods, or reports.",
    "Treat the message below as the current user request and answer it first.",
    "Use earlier session context only when the user explicitly refers to it, or when it is stable configuration context needed to answer the current request.",
    "If the current message names a different case, cluster, time range, object, or task, treat it as a new request. Do not force the previous case into the answer.",
    "Do not mention these channel-turn instructions to the user.",
    "</channel-turn>",
    "",
    text,
  ].join("\n");
}

// ── Message handler ────────────────────────────────────────────

/**
 * Exported for unit tests. Consumes the already-flattened event payload
 * produced by `@larksuiteoapi/node-sdk`'s EventDispatcher.
 */
export async function handleLarkMessage(
  data: any,
  larkClient: any,
  channelId: string,
  agentBoxManager: AgentBoxManager,
  tlsOptions?: { cert: string; key: string; ca: string },
  frontendClient?: FrontendWsClient,
  locale: "zh-CN" | "en-US" = "zh-CN",
  channelConfig?: LarkChannelConfig,
): Promise<void> {
  // @larksuiteoapi/node-sdk EventDispatcher flattens the event payload before
  // dispatching: `event.*` fields land on the top level and `data.event`
  // disappears (see RequestHandle.parse in the SDK). Read `message` directly.
  const message = data?.message;
  if (!message) return;

  const messageId: string = message.message_id;
  const chatId: string = message.chat_id;
  const msgType: string = message.message_type;
  const chatType: string | undefined = message.chat_type;
  const senderOpenId = getLarkSenderOpenId(data);
  const sessionKey = buildLarkSessionKey(senderOpenId, chatId);

  if (msgType !== "text") return;

  let text: string;
  try {
    const content = JSON.parse(message.content);
    text = content.text;
  } catch { return; }

  if (!text || text.trim().length === 0) return;
  text = text.replace(/@_user_\d+/g, "").trim();
  if (text.length === 0) return;

  const personalBot = channelConfig?.personal_bot;
  const personalChannelId = personalBot?.channel_id ?? channelId;
  const groupChannelId = channelConfig?.group_channel_id ?? (personalBot ? null : channelId);
  if (chatType === "p2p") {
    if (!personalBot) {
      console.log(`[lark] Ignoring p2p message for non-personal channel=${channelId}`);
      return;
    }
    if (!senderOpenId) {
      await replyToLark(larkClient, messageId, "❌ Missing Feishu sender open_id.");
      return;
    }
    const pairMatch = text.match(/^PAIR\s+([A-Z0-9]{6})$/i);
    if (pairMatch) {
      if (personalBot.access_mode !== "sicore_authorized") {
        await replyToLark(larkClient, messageId, locale === "en-US"
          ? "This open personal bot does not require PAIR."
          : "这个公开个人机器人不需要 PAIR。");
        return;
      }
      const code = pairMatch[1].toUpperCase();
      const result = await handlePersonalPairingCode(code, personalChannelId, senderOpenId, frontendClient!);
      await replyToLark(larkClient, messageId, formatPersonalPairReply(result, locale));
      return;
    }

    const binding = await resolvePersonalBinding(personalChannelId, senderOpenId, frontendClient!);
    if (!binding) {
      if (personalBot.access_mode === "sicore_authorized") {
        await replyToLark(larkClient, messageId, formatPersonalBindRequiredReply(personalBot.authorize_url, locale));
      } else {
        console.log(`[lark] No personal binding for open channel=${channelId} sender=${senderOpenId}`);
      }
      return;
    }

    const personalSessionKey = binding.sessionKey ?? `open_id:${senderOpenId}`;
    const queueKey = `${binding.bindingId}:${personalSessionKey}`;
    const queued = enqueueBindingTask(queueKey, () => processQueuedLarkMessage({
      text,
      messageId,
      chatId,
      senderOpenId,
      sessionKey: personalSessionKey,
      channelId: personalChannelId,
      route: "personal",
      larkClient,
      agentBoxManager,
      tlsOptions,
      frontendClient,
      locale,
    }));
    if (!queued.accepted) {
      await replyToLark(larkClient, messageId, QUEUE_FULL_NOTICE_BY_LOCALE[locale]);
      return;
    }
    await queued.done;
    return;
  }

  if (!groupChannelId) {
    console.log(`[lark] Ignoring group message for personal-only channel=${channelId}`);
    return;
  }

  // Check for PAIR command
  const pairMatch = text.match(/^PAIR\s+([A-Z0-9]{6})$/i);
  if (pairMatch) {
    const code = pairMatch[1].toUpperCase();
    const result = await handlePairingCode(code, groupChannelId, chatId, "group", frontendClient!);

    const replyText = formatPairReply(result, locale);
    await replyToLark(larkClient, messageId, replyText);
    return;
  }

  // Look up binding for this chat
  const binding = await resolveBinding(groupChannelId, chatId, frontendClient!, sessionKey);
  if (!binding) {
    console.log(`[lark] No binding for channel=${groupChannelId} chat=${chatId} — ignoring`);
    // Don't spam the group with "not paired" for every message.
    // Only reply if the message looks like it's directed at the bot (@mention).
    return;
  }

  const queueKey = `${binding.bindingId}:${binding.sessionKey ?? sessionKey}`;
  const queued = enqueueBindingTask(queueKey, () => processQueuedLarkMessage({
    text,
    messageId,
    chatId,
    senderOpenId,
    sessionKey,
    channelId: groupChannelId,
    route: "group",
    larkClient,
    agentBoxManager,
    tlsOptions,
    frontendClient,
    locale,
  }));
  if (!queued.accepted) {
    await replyToLark(larkClient, messageId, QUEUE_FULL_NOTICE_BY_LOCALE[locale]);
    return;
  }
  await queued.done;
}

interface QueuedLarkMessageContext {
  text: string;
  messageId: string;
  chatId: string;
  senderOpenId: string | null;
  sessionKey: string;
  channelId: string;
  route: "group" | "personal";
  larkClient: any;
  agentBoxManager: AgentBoxManager;
  tlsOptions?: { cert: string; key: string; ca: string };
  frontendClient?: FrontendWsClient;
  locale: "zh-CN" | "en-US";
}

async function processQueuedLarkMessage(ctx: QueuedLarkMessageContext): Promise<void> {
  const {
    text,
    messageId,
    chatId,
    senderOpenId,
    sessionKey,
    channelId,
    route,
    larkClient,
    agentBoxManager,
    tlsOptions,
    frontendClient,
    locale,
  } = ctx;

  if (/^\/new$/i.test(text)) {
    await handleNewCommand(route, channelId, chatId, sessionKey, messageId, larkClient, agentBoxManager, tlsOptions, frontendClient, locale);
    return;
  }

  const binding = await resolveQueuedBinding(route, channelId, chatId, senderOpenId, frontendClient!, sessionKey);
  if (!binding) {
    console.log(`[lark] Binding disappeared before queued run channel=${channelId} chat=${chatId} route=${route}`);
    return;
  }
  if (!binding.createdBy) {
    await replyToLark(larkClient, messageId, MISSING_OWNER_NOTICE_BY_LOCALE[locale]);
    return;
  }

  const agentId = binding.agentId;
  const sessionId = binding.sessionId;
  sessionRegistry.remember(sessionId, binding.createdBy, agentId);

  console.log(`[lark] Message channel=${channelId} chat=${chatId} sender=${senderOpenId ?? "unknown"} → agent=${agentId} session=${sessionId}: "${text.slice(0, 80)}"`);

  try {
    await ensureChatSession(sessionId, agentId, binding.createdBy, text, text, "channel");
    await appendMessage({
      sessionId,
      role: "user",
      content: text,
      metadata: { source: "lark", channelId, chatId, messageId, bindingId: binding.bindingId, senderOpenId, sessionKey, route },
    });
  } catch (err) {
    console.error(`[lark] Failed to persist channel user message session=${sessionId}:`, err);
    await replyToLark(larkClient, messageId, `❌ ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
    return;
  }

  // Open the typing-indicator card FIRST so the user sees immediate feedback.
  // If the CardKit APIs fail we fall back to posting a plain text reply
  // once the agent is done (preserves the pre-card behaviour).
  const cardSession = await openTypingCard(larkClient, messageId, PLACEHOLDER_BY_LOCALE[locale]);
  let deliveredTextChars = 0;
  let deliveredAgentUpdates = 0;
  registerBackgroundChannelDelivery(sessionId, async (backgroundMessage) => {
    if ("text" in backgroundMessage) {
      const display = stripVisualBlocks(backgroundMessage.text) || EMPTY_RESULT_NOTICE_BY_LOCALE[locale];
      if (!shouldDeliverAgentSelectedUpdate(backgroundMessage.kind, display, deliveredAgentUpdates)) return true;
      if (backgroundMessage.kind !== "final") deliveredAgentUpdates += 1;
      const terminal = backgroundMessage.kind === "final";
      const delivered = await deliverVisibleChannelText(larkClient, messageId, cardSession, display, terminal);
      if (delivered) deliveredTextChars = display.length;
      return delivered;
    }

    const display = stripVisualBlocks(backgroundMessage.content) || EMPTY_RESULT_NOTICE_BY_LOCALE[locale];
    if (!shouldDeliverBackgroundReply(display, deliveredTextChars)) return true;
    if (cardSession) {
      const ok = await finalizeCard(larkClient, cardSession, display);
      if (ok) {
        deliveredTextChars = display.length;
        return true;
      }
      console.warn(`[lark] Background card update failed for session=${sessionId}; falling back to text reply`);
    }
    await replyToLark(larkClient, messageId, display);
    deliveredTextChars = display.length;
    return true;
  });

  // Get or create AgentBox for this agent (shared across all callers).
  const handle = await agentBoxManager.getOrCreate(agentId);
  const client = new AgentBoxClient(handle.endpoint, 120_000, tlsOptions);

  const promptOpts: PromptOptions = { text: buildChannelTurnPrompt(text), agentId, mode: "channel", sessionId };
  let resultText = "";
  let replyImages: RenderedReplyImage[] = [];
  let agentError: Error | null = null;
  try {
    const promptResult = await client.prompt(promptOpts);
    const collected = await collectChannelResponse(client, promptResult.sessionId, "lark", { includeImages: true });
    resultText = collected.text;
    replyImages = collected.images;
  } catch (err) {
    agentError = err instanceof Error ? err : new Error(String(err));
    console.error(`[lark] Agent execution failed for session=${sessionId}:`, agentError);
  }

  // Materialize the final reply body. Preserve the agent-like-API-key UX:
  // a single message to the user — no intermediate tool-call spam.
  const finalBody = agentError
    ? `\u274C ${agentError.message.slice(0, 500)}`
    : (resultText || EMPTY_RESULT_NOTICE_BY_LOCALE[locale]);
  if (agentError) replyImages = [];
  const displayBody = stripVisualBlocks(finalBody, { stripSourceBlocks: replyImages.length > 0 })
    || VISUAL_ONLY_NOTICE_BY_LOCALE[locale];

  if (cardSession) {
    const ok = await finalizeCard(larkClient, cardSession, displayBody);
    deliveredTextChars = displayBody.length;
    if (!ok) {
      // Partial-failure path: the card is visible but stuck in streaming
      // state. We log but do NOT post a second reply — that would produce
      // duplicate messages in the group.
      console.warn(`[lark] Card finalize incomplete for cardId=${cardSession.cardId}; user may see stuck placeholder`);
    }
  } else if (resultText || agentError) {
    // Card could not be opened; fall back to a plain text reply with
    // whatever we have (final answer or error).
    await replyToLark(larkClient, messageId, displayBody);
    deliveredTextChars = displayBody.length;
  }

  await replyVisualImages(larkClient, messageId, replyImages);
}

async function resolveQueuedBinding(
  route: "group" | "personal",
  channelId: string,
  chatId: string,
  senderOpenId: string | null,
  frontendClient: FrontendWsClient,
  sessionKey: string,
): Promise<ResolvedChannelBinding | null> {
  if (route === "personal") {
    if (!senderOpenId) return null;
    return resolvePersonalBinding(channelId, senderOpenId, frontendClient);
  }
  return resolveBinding(channelId, chatId, frontendClient, sessionKey);
}

async function handleNewCommand(
  route: "group" | "personal",
  channelId: string,
  chatId: string,
  sessionKey: string,
  messageId: string,
  larkClient: any,
  agentBoxManager: AgentBoxManager,
  tlsOptions?: { cert: string; key: string; ca: string },
  frontendClient?: FrontendWsClient,
  locale: "zh-CN" | "en-US" = "zh-CN",
): Promise<void> {
  const reset = route === "personal"
    ? await resetPersonalSession(channelId, sessionKey, frontendClient!)
    : await resetBindingSession(channelId, chatId, frontendClient!, sessionKey);
  if (!reset.success || !reset.sessionId || !reset.agentId) {
    await replyToLark(larkClient, messageId, `❌ ${reset.error ?? "Failed to reset session"}`);
    return;
  }

  if (reset.oldSessionId) {
    sessionRegistry.forget(reset.oldSessionId);
    try {
      const handle = await agentBoxManager.getOrCreate(reset.agentId);
      const client = new AgentBoxClient(handle.endpoint, 120_000, tlsOptions);
      await client.closeSession(reset.oldSessionId);
    } catch (err) {
      console.error(`[lark] Failed to close old session=${reset.oldSessionId} on /new:`, err);
    }
  }

  await replyToLark(larkClient, messageId, NEW_SESSION_NOTICE_BY_LOCALE[locale]);
}

/**
 * Build the PAIR-command reply in the channel's locale. Kept here (not in
 * lark-card) because it's plain-text (uses replyToLark, not CardKit) and
 * tightly coupled to the handler's PAIR branch.
 */
function formatPairReply(
  result: { success: boolean; agentName?: string; error?: string },
  locale: "zh-CN" | "en-US",
): string {
  if (result.success) {
    return locale === "en-US"
      ? `\u2705 Paired! This group is now connected to agent "${result.agentName}".`
      : `\u2705 绑定成功！此群组已连接到 Agent "${result.agentName}"。`;
  }
  return locale === "en-US"
    ? `\u274C Pairing failed: ${result.error}`
    : `\u274C 绑定失败: ${result.error}`;
}

function formatPersonalBindRequiredReply(
  authorizeUrl: string | undefined,
  locale: "zh-CN" | "en-US",
): string {
  const base = PERSONAL_BIND_REQUIRED_NOTICE_BY_LOCALE[locale];
  if (!authorizeUrl) return base;
  return locale === "en-US"
    ? `${base}\n${authorizeUrl}`
    : `${base}\n${authorizeUrl}`;
}

function formatPersonalPairReply(
  result: { success: boolean; agentName?: string; error?: string },
  locale: "zh-CN" | "en-US",
): string {
  if (result.success) {
    return locale === "en-US"
      ? `\u2705 Authorized! This personal bot is now connected to agent "${result.agentName}".`
      : `\u2705 授权成功！这个个人机器人已连接到 Agent "${result.agentName}"。`;
  }
  return locale === "en-US"
    ? `\u274C Authorization failed: ${result.error}`
    : `\u274C 授权失败: ${result.error}`;
}

async function replyToLark(larkClient: any, messageId: string, text: string): Promise<void> {
  try {
    await larkClient.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text }), msg_type: "text" },
    });
  } catch (err) {
    console.error(`[lark] Failed to reply to messageId=${messageId}:`, err);
  }
}

function shouldDeliverBackgroundReply(text: string, previousChars: number): boolean {
  const chars = text.trim().length;
  if (chars === 0) return false;
  return !(previousChars > 80 && chars < 120 && chars < previousChars * 0.75);
}

function shouldDeliverAgentSelectedUpdate(kind: "milestone" | "final" | "artifact", text: string, deliveredUpdates: number): boolean {
  if (!text.trim()) return false;
  if (kind !== "final" && deliveredUpdates >= MAX_AGENT_SELECTED_UPDATES) return false;
  return true;
}

async function deliverVisibleChannelText(
  larkClient: any,
  messageId: string,
  cardSession: Awaited<ReturnType<typeof openTypingCard>>,
  text: string,
  terminal: boolean,
): Promise<boolean> {
  if (cardSession) {
    const ok = terminal
      ? await finalizeCard(larkClient, cardSession, text)
      : await updateCardContent(larkClient, cardSession, text);
    if (ok) return true;
    console.warn(`[lark] Channel-visible card update failed for messageId=${messageId}; falling back to text reply`);
  }
  await replyToLark(larkClient, messageId, text);
  return true;
}

async function replyVisualImages(larkClient: any, messageId: string, images: RenderedReplyImage[]): Promise<void> {
  for (const { kind, image } of images) {
    const ok = await replyImageToLark(larkClient, messageId, image);
    if (!ok) {
      console.warn(`[lark] ${kind} image reply failed for messageId=${messageId}; markdown card remains primary`);
    }
  }
}

// ── SSE response collector ─────────────────────────────────────

export interface CollectedChannelResponse {
  text: string;
  images: RenderedReplyImage[];
}

export async function collectResponse(
  client: AgentBoxClient,
  sessionId: string,
  logPrefix = "lark",
): Promise<string> {
  return (await collectChannelResponse(client, sessionId, logPrefix)).text;
}

export async function collectChannelResponse(
  client: AgentBoxClient,
  sessionId: string,
  logPrefix = "lark",
  options: { includeImages?: boolean } = {},
): Promise<CollectedChannelResponse> {
  const parts: string[] = [];
  const images: RenderedReplyImage[] = [];
  const seenImageKeys = new Set<string>();
  // Track the latest assistant turn so we only reply with the *final* text
  // (tool-use turns emit intermediate message_end events that aren't meant
  // for the user). pi-agent's agent_end signals the last turn is complete.
  let lastAssistantText = "";
  try {
    for await (const event of client.streamEvents(sessionId)) {
      const ev = event as Record<string, any>;
      if (ev.type === "content_block_delta" && ev.delta?.text) parts.push(ev.delta.text);
      if (ev.type === "text" && typeof ev.text === "string") parts.push(ev.text);
      if (options.includeImages && (ev.type === "tool_execution_end" || ev.type === "tool_end")) {
        collectImageAttachments(ev.result?.content, images, seenImageKeys);
      }
      if (options.includeImages && ev.type === "message_end" && (ev.message?.role === "toolResult" || ev.message?.role === "tool")) {
        collectImageAttachments(ev.message?.content, images, seenImageKeys);
      }
      // pi-agent-brain emits the final assistant reply as message_end with
      // a content array of blocks; collect the text blocks only.
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
        if (options.includeImages) collectImageAttachments(blocks, images, seenImageKeys);
        const turnText = contentBlocksToMarkdown(blocks);
        if (turnText) lastAssistantText = turnText;
      }
    }
  } catch (err) {
    console.error(`[${logPrefix}] SSE collect error for session=${sessionId}:`, err);
  }
  // Prefer the last full assistant turn; fall back to streamed deltas if the
  // brain only emits content_block_delta events.
  const text = lastAssistantText || parts.join("");
  return { text, images };
}

function contentBlocksToMarkdown(blocks: unknown[]): string {
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return "";
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") return rec.text;
    return "";
  }).join("");
}
