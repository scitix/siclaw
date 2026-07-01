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
  isChannelAccessDenied,
  type ResolvedChannelBinding,
  type ChannelAccessDenied,
} from "../channel-manager.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";
import { sessionRegistry } from "../session-registry.js";
import { appendMessage, ensureChatSession } from "../chat-repo.js";
import { buildRedactionConfigForModelConfig, redactText } from "../output-redactor.js";
import { resolveAgentModelBinding } from "../agent-model-binding.js";
import {
  openTypingCard,
  updateCardContent,
  finalizeCard,
  buildMilestoneCardMarkdown,
  PLACEHOLDER_BY_LOCALE,
  EMPTY_RESULT_NOTICE_BY_LOCALE,
  localeForDomain,
} from "./lark-card.js";
import { collectImageAttachments, stripVisualBlocks, type RenderedReplyImage } from "./visual-image.js";
import { replyImageToLark } from "./lark-image.js";
import { collectInboundImages, type LarkImageRef } from "./inbound-image.js";
import { modelOptionsSupportImageInput } from "../../core/model-routing.js";
import { redactImageUrlsInText } from "../agentbox/image-url-ingest.js";
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
// sicore_authorized group: sender hasn't linked their Feishu account to Sicore.
const GROUP_ACCESS_UNBOUND_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 你的飞书账号还没绑定 Sicore，无法在群里使用这个助手。请打开 Sicore 的 Agent Channels 页面授权飞书账号后再试。",
  "en-US": "❌ Your Feishu account isn't linked to Sicore yet, so you can't use this assistant here. Open the Sicore Agent Channels page to authorize, then try again.",
} as const;
// sicore_authorized group: sender is linked but lacks read access to the agent.
const GROUP_ACCESS_DENIED_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 你没有这个助手的访问权限，请联系管理员授权。",
  "en-US": "❌ You don't have access to this assistant. Ask an admin to grant access.",
} as const;
// The card only ever shows the single latest step, so the milestone list is
// just an internal buffer for dedup against the previous step. Bound it anyway
// to keep memory flat if an agent over-emits.
const MILESTONE_CAP = 20;
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
    group_auto_bind?: boolean;
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

      // Fetch the bot's own open_id once at start. Group-message handling needs
      // it to tell an individual "@bot" from "@所有人": Feishu delivers @所有人
      // to an @bot-scoped app too (it mentions everyone, the bot included), so
      // at the event layer an @所有人 announcement is indistinguishable from a
      // real @bot unless we match the bot's own open_id. Best-effort: on
      // failure we fall back to @_all-exclusion (see isBotMentioned).
      let botOpenId: string | undefined;
      try {
        const botInfo: any = await (larkClient as any).request({
          method: "GET",
          url: "/open-apis/bot/v3/info",
        });
        botOpenId = botInfo?.bot?.open_id ?? botInfo?.data?.bot?.open_id;
        console.log(`[lark] Channel ${channelId} bot open_id=${botOpenId ?? "(unknown)"}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[lark] Could not fetch bot info for channel ${channelId}; group @-mention gating falls back to @_all-exclusion: ${msg}`);
      }

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
            handleLarkMessage(data, larkClient, channelId, agentBoxManager, tlsOptions, frontendClient, localeForDomain(config.domain), config, botOpenId)
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

/**
 * Whether a group message is actually directed at THIS bot.
 *
 * Feishu delivers a group message to an app scoped to "receive @bot messages"
 * whenever the bot is mentioned — but "@所有人" (@all) mentions *everyone*, the
 * bot included, so an @所有人 announcement is delivered too and looks identical
 * to a real @bot at the event layer. We must match the bot's own open_id:
 * "@所有人" carries key "@_all" and never the bot's open_id, so a strict
 * open_id match excludes it (and any "@someone-else").
 *
 * Degraded path — bot-info fetch failed, so `botOpenId` is unknown: we can't
 * positively identify the bot, but we can still drop "@所有人" explicitly by
 * its "@_all" key. This kills the reported announcement-spam case without
 * muting the bot when its open_id couldn't be resolved.
 */
function isBotMentioned(message: any, botOpenId?: string): boolean {
  const mentions = message?.mentions as
    | Array<{ id?: { open_id?: string }; key?: string }>
    | undefined;
  if (!mentions || mentions.length === 0) return false;
  if (botOpenId) return mentions.some((m) => m.id?.open_id === botOpenId);
  return mentions.some((m) => m.key !== "@_all");
}

/**
 * Placeholder text for an image-only message (no caption). Keeps the user
 * message row, session title, and prompt non-empty so the audit transcript
 * still shows "user sent image(s)".
 */
const IMAGE_ONLY_PLACEHOLDER = "[image]";

/**
 * Pull the user text and any inbound image references out of a Feishu message.
 * This is the ONLY place message content is parsed — `imageRefs` is carried
 * through the queue as a structured value (no re-parse downstream).
 *
 *   - text  → `content.text`
 *   - image → `content.image_key`
 *   - post  → rich text whose `content` is a `Node[][]` (array of paragraphs of
 *             nodes); flatten and split by `tag`: img → image_key, text → text.
 *
 * Unknown types yield empty text + no refs (caller drops them).
 */
export function extractInbound(message: any): { text: string; imageRefs: LarkImageRef[] } {
  const msgType: string = message?.message_type;
  let raw: any;
  try {
    raw = JSON.parse(message?.content ?? "");
  } catch {
    return { text: "", imageRefs: [] };
  }

  if (msgType === "text") {
    return { text: stripMentions(typeof raw?.text === "string" ? raw.text : ""), imageRefs: [] };
  }

  if (msgType === "image") {
    const imageKey = typeof raw?.image_key === "string" ? raw.image_key : null;
    return { text: "", imageRefs: imageKey ? [{ imageKey }] : [] };
  }

  if (msgType === "post") {
    const imageRefs: LarkImageRef[] = [];
    const textParts: string[] = [];
    // Post content is normally delivered flat as `{ title, content: Node[][] }`,
    // but some Feishu API/SDK versions deliver the locale-nested send-shape
    // `{ zh_cn: { title, content }, en_us: {…} }` on receive — accept both so a
    // nested payload is not silently dropped (it would otherwise yield neither
    // text nor image and the whole turn would be discarded).
    const post = Array.isArray(raw?.content) ? raw : firstLocalePost(raw);
    if (typeof post?.title === "string" && post.title) textParts.push(post.title);
    const paragraphs: any[][] = Array.isArray(post?.content) ? post.content : [];
    for (const node of paragraphs.flat()) {
      if (node?.tag === "img" && typeof node?.image_key === "string") {
        imageRefs.push({ imageKey: node.image_key });
      } else if ((node?.tag === "text" || node?.tag === "a") && typeof node?.text === "string") {
        textParts.push(node.text);
      }
      // A hyperlink's href may itself be an image URL — surface it so the unified
      // text-URL resolver (AgentBoxClient.prompt) can pick it up.
      if (node?.tag === "a" && typeof node?.href === "string") {
        textParts.push(node.href);
      }
    }
    return { text: stripMentions(textParts.join(" ")), imageRefs };
  }

  return { text: "", imageRefs: [] };
}

function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, "").trim();
}

/** Feishu post may arrive locale-nested as `{ zh_cn: { content: Node[][] } }`;
 *  pick the first locale block that carries a `content` array. */
function firstLocalePost(raw: any): any {
  if (!raw || typeof raw !== "object") return undefined;
  for (const v of Object.values(raw)) {
    if (v && typeof v === "object" && Array.isArray((v as any).content)) return v;
  }
  return undefined;
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
  botOpenId?: string,
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

  // Raw receipt log: fires for EVERY delivered event before any drop, so a
  // group message that arrives but is filtered (non-text, empty after @-strip)
  // is still visible. Lets us tell "never delivered" from "silently dropped".
  console.log(`[lark] recv event chat=${chatId} chat_type=${chatType} msg_type=${msgType} sender=${senderOpenId ?? "?"} channelCfg=${channelId}`);

  // Accept text, native image, and rich-text (post, may embed images). Other
  // types (audio/file/sticker/…) are still dropped.
  if (msgType !== "text" && msgType !== "image" && msgType !== "post") return;

  const { text, imageRefs } = extractInbound(message);
  // Drop only when there is neither text NOR an image — an image-only message
  // has empty text but must continue.
  if (text.length === 0 && imageRefs.length === 0) return;

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
      imageRefs,
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

  // Only respond when THIS bot is individually @-mentioned. Feishu also
  // delivers "@所有人" to an @bot-scoped app (it mentions everyone, the bot
  // included), so an @所有人 announcement arrives looking just like a real
  // @bot — without this gate the bot replies to group-wide announcements that
  // were never aimed at it. Skips "@所有人" and "@someone-else"; PAIR above is
  // exempt (explicit command). Gated on chat_type==="group" so the binding/
  // access checks below stay reachable only for messages aimed at the bot.
  if (chatType === "group" && !isBotMentioned(message, botOpenId)) {
    console.log(`[lark] Group message not directed at bot (chat=${chatId}) — ignoring (@所有人 / @others / no @bot)`);
    return;
  }

  // Look up binding for this chat. Pass sender_open_id so the Portal can
  // auto-bind / per-sender resolve group bots and pick the session key.
  const binding = await resolveBinding(groupChannelId, chatId, frontendClient!, sessionKey, senderOpenId ?? undefined);
  if (isChannelAccessDenied(binding)) {
    // sicore_authorized group: this sender isn't allowed. Feishu only delivers
    // @-mentioned group messages, so the message is already directed at the bot
    // — a single short hint is fine, not spam.
    await replyToLark(larkClient, messageId, formatGroupAccessDeniedReply(binding, locale));
    return;
  }
  if (!binding) {
    console.log(`[lark] No binding for channel=${groupChannelId} chat=${chatId} — ignoring`);
    // Don't spam the group with "not paired" for every message.
    // Only reply if the message looks like it's directed at the bot (@mention).
    return;
  }

  // Use the SERVER-authoritative session key (not the local open_id default) for
  // both the queue and the queued context, so the two-path contract holds:
  //   - open group     → open_id:<sender>  (per-sender: concurrent + isolated)
  //   - authorized group → sicore_user:<id> (per-user)
  //   - legacy single binding session → "" (binding-level queue + /new reset)
  // /new then resets the right session, and same-session senders serialize.
  const effectiveSessionKey = binding.sessionKey ?? "";
  const queueKey = `${binding.bindingId}:${binding.sessionKey ?? "__binding__"}`;
  const queued = enqueueBindingTask(queueKey, () => processQueuedLarkMessage({
    text,
    imageRefs,
    messageId,
    chatId,
    senderOpenId,
    sessionKey: effectiveSessionKey,
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
  imageRefs: LarkImageRef[];
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
    imageRefs,
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

  // After the command branch (matched on the raw text): an image whose caption
  // is exactly a command word (e.g. "/new") is routed as that command and its
  // image dropped — an accepted edge, since commands are exact-match only.
  // An image-only message has empty text, so give it a placeholder. Replace
  // `text` uniformly here (not just in promptOpts) so the session title,
  // persisted user row, and logs all show "user sent image(s)".
  const effectiveText = text.length === 0 && imageRefs.length > 0 ? IMAGE_ONLY_PLACEHOLDER : text;

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
  // Channel audit actor (NOT runtime identity — that stays `createdBy` via
  // remember() above). The sender's raw open_id is the "same person" key for
  // channel audit; it is stamped on the SESSION (chat_sessions), never falls
  // back to the binding owner. open_id is NULL when the event omits it.
  const senderExternalId = senderOpenId ?? null;

  console.log(`[lark] Message channel=${channelId} chat=${chatId} sender=${senderOpenId ?? "unknown"} → agent=${agentId} session=${sessionId}: "${effectiveText.slice(0, 80)}" images=${imageRefs.length}`);

  // Persist with signed-URL credentials stripped (the prompt still uses the full
  // URL — see promptText below — so resolution is unaffected). Keeps DB rows /
  // session title free of plaintext Signature/AccessKeyId.
  const persistedText = redactImageUrlsInText(effectiveText);
  try {
    await ensureChatSession(sessionId, agentId, binding.createdBy, persistedText, persistedText, "channel", undefined, { senderExternalId, channelId });
    await appendMessage({
      sessionId,
      role: "user",
      content: persistedText,
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
  // Live "current step" indicator. Two milestone sources feed it: explicit
  // channel_update tool calls (agent-curated) AND auto-derived first lines of
  // intermediate assistant turns (collectChannelResponse.onMilestone). The card
  // shows ONLY the single latest step (⏳), replaced in place as work proceeds —
  // no accumulating checklist — and on finalize the step is replaced entirely by
  // the conclusion. `milestones` is kept only to dedup against the last step;
  // renders use the latest entry. Re-renders are coalesced to respect Feishu's
  // update rate.
  const milestones: string[] = [];
  let cardFlushInflight = false;
  let cardFlushDirty = false;
  let cardFinalizing = false;
  let cardFlushPromise: Promise<void> | null = null;
  const flushMilestoneCard = (): Promise<void> => {
    if (!cardSession || cardFinalizing) return Promise.resolve();
    if (cardFlushInflight) { cardFlushDirty = true; return cardFlushPromise ?? Promise.resolve(); }
    cardFlushInflight = true;
    cardFlushPromise = (async () => {
      try {
        do {
          cardFlushDirty = false;
          // Render only the single latest step — never an accumulating list.
          const md = buildMilestoneCardMarkdown({ milestones: milestones.slice(-1) });
          if (md.trim()) await updateCardContent(larkClient, cardSession, md);
        } while (cardFlushDirty && !cardFinalizing);
      } catch (err) {
        console.warn(`[lark] milestone card flush failed for session=${sessionId}:`, err);
      } finally {
        cardFlushInflight = false;
      }
    })();
    return cardFlushPromise;
  };
  // Returns a promise the channel_update path awaits (deterministic delivered
  // bool); the narration onMilestone path ignores it (must not block the SSE
  // loop). Bursts coalesce — a flush in flight just marks the card dirty.
  const addMilestone = (text: string): Promise<void> => {
    const t = (text ?? "").trim();
    if (!t || milestones[milestones.length - 1] === t) return Promise.resolve(); // skip empty/dup
    milestones.push(t);
    if (milestones.length > MILESTONE_CAP) milestones.shift();
    return flushMilestoneCard();
  };
  registerBackgroundChannelDelivery(sessionId, async (backgroundMessage) => {
    if ("text" in backgroundMessage) {
      const display = stripVisualBlocks(backgroundMessage.text);
      if (!display || !display.trim()) return true;

      if (backgroundMessage.kind === "final") {
        const md = buildMilestoneCardMarkdown({ milestones: [], finalText: display });
        const delivered = await deliverVisibleChannelText(larkClient, messageId, cardSession, md, true);
        if (delivered) deliveredTextChars = md.length;
        return delivered;
      }

      // milestone / artifact → accumulate into the checklist (coalesced render).
      await addMilestone(display);
      return true;
    }

    const display = stripVisualBlocks(backgroundMessage.content) || EMPTY_RESULT_NOTICE_BY_LOCALE[locale];
    if (!shouldDeliverBackgroundReply(display, deliveredTextChars)) return true;
    const md = buildMilestoneCardMarkdown({ milestones: [], finalText: display });
    if (cardSession) {
      const ok = await finalizeCard(larkClient, cardSession, md);
      if (ok) {
        deliveredTextChars = md.length;
        return true;
      }
      console.warn(`[lark] Background card update failed for session=${sessionId}; falling back to text reply`);
    }
    await replyToLark(larkClient, messageId, md);
    deliveredTextChars = md.length;
    return true;
  });

  // Get or create AgentBox for this agent (shared across all callers).
  const handle = await agentBoxManager.getOrCreate(agentId);
  const client = new AgentBoxClient(handle.endpoint, 120_000, tlsOptions);

  const modelBinding = frontendClient
    ? await resolveAgentModelBinding(agentId, frontendClient)
    : null;
  // Native Lark images are vision-gated too, mirroring the text-URL path: a
  // non-vision model can't use them and would fail-closed at AgentBox media
  // filtering, so skip the download entirely for non-vision models (the [image]
  // placeholder in effectiveText still records that the user sent an image).
  // Text image URLs are NOT handled here — they are resolved generically (and
  // vision-gated) at the `AgentBoxClient.prompt()` boundary, shared with Portal
  // Web chat / a2a / cron.
  const visionCapable = modelOptionsSupportImageInput({
    modelProvider: modelBinding?.modelProvider,
    modelId: modelBinding?.modelId,
    modelConfig: modelBinding?.modelConfig,
    modelRouting: modelBinding?.modelRouting,
  });
  const images = visionCapable
    ? await collectInboundImages({ imageRefs, larkClient, messageId })
    : [];
  // Non-vision model + the user sent native image(s): they were dropped (can't be
  // used). Tell the model so it can inform the user — mirroring the text-URL path,
  // where a non-vision model at least sees the URL and can say it can't open it.
  const promptText = !visionCapable && imageRefs.length > 0
    ? `${effectiveText}\n[Note: the user attached ${imageRefs.length} image(s), but the current model cannot read images.]`
    : effectiveText;
  const promptOpts: PromptOptions = {
    text: buildChannelTurnPrompt(promptText),
    agentId,
    mode: "channel",
    sessionId,
    modelProvider: modelBinding?.modelProvider,
    modelId: modelBinding?.modelId,
    modelConfig: modelBinding?.modelConfig,
    modelRouting: modelBinding?.modelRouting,
    systemPromptTemplate: modelBinding?.systemPrompt?.trim() || undefined,
    ...(images.length ? { images } : {}),
  };
  let resultText = "";
  let replyImages: RenderedReplyImage[] = [];
  let agentError: Error | null = null;
  try {
    const promptResult = await client.prompt(promptOpts);
    const collected = await collectChannelResponse(client, promptResult.sessionId, "lark", {
      includeImages: true,
      onMilestone: addMilestone,
      // Audit: persist assistant + tool rows so the channel transcript matches
      // web/api/a2a (origin="channel" set on the session above). Tool output on
      // this stream is already sanitized at the agentbox boundary.
      persist: { agentId, modelConfig: modelBinding?.modelConfig },
    });
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
  // The final card is JUST the conclusion — the live step indicator is replaced
  // entirely, no milestone trail is kept on the card.
  const finalCardBody = buildMilestoneCardMarkdown({ milestones: [], finalText: displayBody });

  // Stop any further coalesced milestone renders and let the in-flight one
  // settle, so finalizeCard isn't overwritten by a later (higher-sequence)
  // milestone-only update.
  cardFinalizing = true;
  if (cardFlushPromise) { try { await cardFlushPromise; } catch { /* logged in flush */ } }

  if (cardSession) {
    const ok = await finalizeCard(larkClient, cardSession, finalCardBody);
    deliveredTextChars = finalCardBody.length;
    if (!ok) {
      // Partial-failure path: the card is visible but stuck in streaming
      // state. We log but do NOT post a second reply — that would produce
      // duplicate messages in the group.
      console.warn(`[lark] Card finalize incomplete for cardId=${cardSession.cardId}; user may see stuck placeholder`);
    }
  } else if (resultText || agentError) {
    // Card could not be opened; fall back to a plain text reply with
    // whatever we have (final answer or error) + any accumulated milestones.
    await replyToLark(larkClient, messageId, finalCardBody);
    deliveredTextChars = finalCardBody.length;
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
  const result = await resolveBinding(channelId, chatId, frontendClient, sessionKey, senderOpenId ?? undefined);
  // If access was revoked between enqueue and run, treat as gone (the queued
  // task then skips). The pre-enqueue check already replied any access hint.
  return isChannelAccessDenied(result) ? null : result;
}

/**
 * Build the access-denied reply for a sicore_authorized group, in the channel's
 * locale. Appends the authorize URL for the "unbound" case.
 */
function formatGroupAccessDeniedReply(
  denied: ChannelAccessDenied,
  locale: "zh-CN" | "en-US",
): string {
  if (denied.reason === "denied") {
    return GROUP_ACCESS_DENIED_NOTICE_BY_LOCALE[locale];
  }
  const base = GROUP_ACCESS_UNBOUND_NOTICE_BY_LOCALE[locale];
  return denied.authorizeUrl ? `${base}\n${denied.authorizeUrl}` : base;
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
    // Feishu's SDK does NOT throw on a non-zero API code (e.g. missing
    // im:message send scope) — it returns {code,msg} in the body. Surface it,
    // otherwise a permission failure looks like a silent no-op.
    const resp = await larkClient.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text }), msg_type: "text" },
    });
    if (resp && typeof resp.code === "number" && resp.code !== 0) {
      console.error(`[lark] reply API returned non-zero code for messageId=${messageId}: code=${resp.code} msg=${resp.msg}`);
    }
  } catch (err) {
    console.error(`[lark] Failed to reply to messageId=${messageId}:`, err);
  }
}

function shouldDeliverBackgroundReply(text: string, previousChars: number): boolean {
  const chars = text.trim().length;
  if (chars === 0) return false;
  return !(previousChars > 80 && chars < 120 && chars < previousChars * 0.75);
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
  options: { persist?: ChannelPersistContext } = {},
): Promise<string> {
  return (await collectChannelResponse(client, sessionId, logPrefix, { persist: options.persist })).text;
}

/**
 * Opt-in audit persistence for the channel path. When set, collectChannelResponse
 * writes the same user/assistant/tool transcript that web/api/a2a get via the
 * runtime's sse-consumer, so IM-channel sessions are fully auditable (not just
 * the inbound user message). `modelConfig` drives the same apiKey/baseUrl
 * redaction the sse-consumer applies. The caller has already persisted the user
 * message + ensured the session row (origin="channel").
 */
export interface ChannelPersistContext {
  agentId: string;
  modelConfig?: { apiKey?: string; baseUrl?: string };
}

export async function collectChannelResponse(
  client: AgentBoxClient,
  sessionId: string,
  logPrefix = "lark",
  options: { includeImages?: boolean; onMilestone?: (text: string) => void; persist?: ChannelPersistContext } = {},
): Promise<CollectedChannelResponse> {
  const parts: string[] = [];
  const images: RenderedReplyImage[] = [];
  const seenImageKeys = new Set<string>();
  // Track the latest assistant turn so we only reply with the *final* text
  // (tool-use turns emit intermediate message_end events that aren't meant
  // for the user). pi-agent's agent_end signals the last turn is complete.
  let lastAssistantText = "";

  // ── Audit persistence (opt-in) ──────────────────────────────────────────
  // Mirrors the field mapping in sse-consumer.ts so a channel transcript looks
  // like a web/api/a2a one. Tool content + input are redacted with the same
  // model-config redactor. Best-effort: a persist failure must never break the
  // user-facing reply, so each write is wrapped and swallowed-with-log.
  const persist = options.persist;
  const redaction = persist ? buildRedactionConfigForModelConfig(persist.modelConfig) : null;
  const redact = (s: string): string => (redaction ? redactText(s, redaction) : s);
  // FIFO per-tool queues to pair start↔end (same approach as sse-consumer's
  // pendingTool* maps). Caveat inherited from there: multiple *concurrent*
  // same-name calls finishing out of order can mispair, skewing that row's
  // durationMs. Only affects the audit metric, never the reply; acceptable.
  const toolInputs = new Map<string, string[]>();
  const toolStarts = new Map<string, number[]>();
  const pushQ = <T,>(m: Map<string, T[]>, k: string, v: T): void => { const a = m.get(k) ?? []; a.push(v); m.set(k, a); };
  const shiftQ = <T,>(m: Map<string, T[]>, k: string): T | undefined => m.get(k)?.shift();
  const persistRow = async (msg: Parameters<typeof appendMessage>[0]): Promise<void> => {
    try { await appendMessage(msg); }
    catch (err) { console.warn(`[${logPrefix}] audit persist failed session=${sessionId}:`, err); }
  };

  try {
    for await (const event of client.streamEvents(sessionId)) {
      const ev = event as Record<string, any>;
      if (ev.type === "content_block_delta" && ev.delta?.text) parts.push(ev.delta.text);
      if (ev.type === "text" && typeof ev.text === "string") parts.push(ev.text);

      // Capture tool input + start time for the matching tool_execution_end.
      if (persist && (ev.type === "tool_execution_start" || ev.type === "tool_start")) {
        const name = (ev.toolName as string) || (ev.name as string) || "tool";
        pushQ(toolInputs, name, ev.args ? JSON.stringify(ev.args) : "");
        pushQ(toolStarts, name, Date.now());
      }

      if (ev.type === "tool_execution_end" || ev.type === "tool_end") {
        if (options.includeImages) collectImageAttachments(ev.result?.content, images, seenImageKeys);
        if (persist) {
          const name = (ev.toolName as string) || (ev.name as string) || "tool";
          const resultText = Array.isArray(ev.result?.content)
            ? ev.result.content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("")
            : "";
          let outcome: "success" | "error" | "blocked" = "success";
          if (ev.result?.details?.blocked) outcome = "blocked";
          else if (ev.result?.details?.error) outcome = "error";
          const input = shiftQ(toolInputs, name) || "";
          const startedAt = shiftQ(toolStarts, name);
          await persistRow({
            sessionId,
            role: "tool",
            content: redact(resultText),
            toolName: name,
            toolInput: input ? redact(input) : null,
            outcome,
            durationMs: startedAt != null ? Date.now() - startedAt : null,
          });
        }
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
        if (turnText) {
          // A NEW assistant turn means the PREVIOUS one was an intermediate
          // step (the agent narrated, then called a tool) — surface its first
          // line as a progress milestone. The final turn is never followed by
          // another, so it stays the answer, not a milestone.
          if (lastAssistantText && options.onMilestone) {
            const m = condenseMilestone(lastAssistantText);
            if (m) options.onMilestone(m);
          }
          lastAssistantText = turnText;
          // Persist every assistant turn (intermediate narration + final answer),
          // mirroring sse-consumer. Awaited so its created_at precedes the next
          // tool row in the transcript.
          if (persist) await persistRow({ sessionId, role: "assistant", content: redact(turnText) });
        }
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

/**
 * Condense an intermediate assistant turn into a one-line progress milestone:
 * first non-empty line, strip a leading heading marker, cap length. Inline
 * code/bold pass through so chips still render.
 */
function condenseMilestone(text: string): string {
  const firstLine = text.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  const clean = firstLine.replace(/^#{1,6}\s+/, "").trim();
  if (!clean) return "";
  return clean.length > 90 ? `${clean.slice(0, 88)}…` : clean;
}

function contentBlocksToMarkdown(blocks: unknown[]): string {
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return "";
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") return rec.text;
    return "";
  }).join("");
}
