/**
 * Lark (飞书) channel handler.
 *
 * Connects to Lark via WebSocket-based event subscription.
 * Routes messages dynamically via channel_bindings (not hardcoded agent).
 * Supports PAIR command for binding chat groups to agents.
 */

import crypto from "node:crypto";
import type { AgentBoxManager } from "../agentbox/manager.js";
import { AgentBoxClient, type PromptOptions } from "../agentbox/client.js";
import type { ChannelHandler } from "../channel-manager.js";
import { resolveBinding, handlePairingCode } from "../channel-manager.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";
import { sessionRegistry } from "../session-registry.js";
import {
  openTypingCard,
  finalizeCard,
  PLACEHOLDER_BY_LOCALE,
  EMPTY_RESULT_NOTICE_BY_LOCALE,
  localeForDomain,
} from "./lark-card.js";
import {
  collectImageAttachments,
  collectImageAttachmentsFromMetadata,
  imageAttachmentKey,
  stripVisualBlocks,
  type RenderedReplyImage,
} from "./visual-image.js";
import { replyImageToLark } from "./lark-image.js";
import { registerBackgroundChannelDelivery } from "./background-delivery.js";

const VISUAL_ONLY_NOTICE_BY_LOCALE = {
  "zh-CN": "已生成图片如下。",
  "en-US": "Image generated below.",
} as const;

export interface LarkChannelConfig {
  domain?: "feishu" | "lark";  // feishu = China (default), lark = Global
  app_id: string;
  app_secret: string;
  verification_token?: string;
  encrypt_key?: string;
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
            handleLarkMessage(data, larkClient, channelId, agentBoxManager, tlsOptions, frontendClient, localeForDomain(config.domain))
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
): Promise<void> {
  // @larksuiteoapi/node-sdk EventDispatcher flattens the event payload before
  // dispatching: `event.*` fields land on the top level and `data.event`
  // disappears (see RequestHandle.parse in the SDK). Read `message` directly.
  const message = data?.message;
  if (!message) return;

  const messageId: string = message.message_id;
  const chatId: string = message.chat_id;
  const msgType: string = message.message_type;

  if (msgType !== "text") return;

  let text: string;
  try {
    const content = JSON.parse(message.content);
    text = content.text;
  } catch { return; }

  if (!text || text.trim().length === 0) return;
  text = text.replace(/@_user_\d+/g, "").trim();
  if (text.length === 0) return;

  // Check for PAIR command
  const pairMatch = text.match(/^PAIR\s+([A-Z0-9]{6})$/i);
  if (pairMatch) {
    const code = pairMatch[1].toUpperCase();
    const result = await handlePairingCode(code, channelId, chatId, "group", frontendClient!);

    const replyText = formatPairReply(result, locale);
    await replyToLark(larkClient, messageId, replyText);
    return;
  }

  // Look up binding for this chat
  const binding = await resolveBinding(channelId, chatId, frontendClient!);
  if (!binding) {
    console.log(`[lark] No binding for channel=${channelId} chat=${chatId} — ignoring`);
    // Don't spam the group with "not paired" for every message.
    // Only reply if the message looks like it's directed at the bot (@mention).
    return;
  }

  const agentId = binding.agentId;
  // Tenant key for the group's conversational context — used as the "user" in
  // chat_sessions and session registry. It does NOT travel to AgentBox (cert
  // CN is agentId, payload carries only sessionId) but Runtime uses it to
  // tag audit rows so outbound Upstream calls attribute correctly.
  const conversationKey = `lark:${chatId}`;
  const sessionId = crypto.randomUUID();
  sessionRegistry.remember(sessionId, conversationKey, agentId);

  console.log(`[lark] Message channel=${channelId} chat=${chatId} \u2192 agent=${agentId}: "${text.slice(0, 80)}"`);

  // Open the typing-indicator card FIRST so the user sees immediate feedback.
  // If the CardKit APIs fail we fall back to posting a plain text reply
  // once the agent is done (preserves the pre-card behaviour).
  const cardSession = await openTypingCard(larkClient, messageId, PLACEHOLDER_BY_LOCALE[locale]);
  let deliveredTextChars = 0;
  let initialReplyCompleted = false;
  const deliveredImageKeys = new Set<string>();
  const pendingBackgroundImages: RenderedReplyImage[] = [];
  registerBackgroundChannelDelivery(sessionId, async (backgroundMessage) => {
    const backgroundImages: RenderedReplyImage[] = [];
    collectImageAttachmentsFromMetadata(backgroundMessage.metadata, backgroundImages, new Set());
    if (backgroundMessage.role !== "assistant") {
      if (initialReplyCompleted) {
        await replyVisualImages(larkClient, messageId, backgroundImages, deliveredImageKeys);
      } else {
        pendingBackgroundImages.push(...backgroundImages);
      }
      return backgroundImages.length > 0;
    }
    const display = stripVisualBlocks(backgroundMessage.content) || EMPTY_RESULT_NOTICE_BY_LOCALE[locale];
    if (!shouldDeliverBackgroundReply(display, deliveredTextChars)) return true;
    if (cardSession) {
      const ok = await finalizeCard(larkClient, cardSession, display);
      if (ok) {
        deliveredTextChars = display.length;
        if (initialReplyCompleted) {
          await replyVisualImages(larkClient, messageId, backgroundImages, deliveredImageKeys);
        } else {
          pendingBackgroundImages.push(...backgroundImages);
        }
        return true;
      }
      console.warn(`[lark] Background card update failed for session=${sessionId}; falling back to text reply`);
    }
    await replyToLark(larkClient, messageId, display);
    deliveredTextChars = display.length;
    if (initialReplyCompleted) {
      await replyVisualImages(larkClient, messageId, backgroundImages, deliveredImageKeys);
    } else {
      pendingBackgroundImages.push(...backgroundImages);
    }
    return true;
  });

  // Get or create AgentBox for this agent (shared across all callers).
  const handle = await agentBoxManager.getOrCreate(agentId);
  const client = new AgentBoxClient(handle.endpoint, 120_000, tlsOptions);

  const promptOpts: PromptOptions = { text, agentId, mode: "channel", sessionId };
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

  initialReplyCompleted = true;
  await replyVisualImages(larkClient, messageId, [...pendingBackgroundImages, ...replyImages], deliveredImageKeys);
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

async function replyVisualImages(
  larkClient: any,
  messageId: string,
  images: RenderedReplyImage[],
  deliveredImageKeys: Set<string> = new Set(),
): Promise<void> {
  for (const imageAttachment of images) {
    const key = imageAttachmentKey(imageAttachment);
    if (deliveredImageKeys.has(key)) continue;
    deliveredImageKeys.add(key);
    const ok = await replyImageToLark(larkClient, messageId, imageAttachment.image);
    if (!ok) {
      console.warn(`[lark] ${imageAttachment.kind} image reply failed for messageId=${messageId}; markdown card remains primary`);
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
