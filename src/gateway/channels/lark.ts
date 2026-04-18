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
        "im.message.receive_v1": async (data: any) => {
          try {
            await handleLarkMessage(data, larkClient, channelId, agentBoxManager, tlsOptions, frontendClient);
          } catch (err) {
            console.error(`[lark] Error handling message for channel=${channelId}:`, err);
          }
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

    const replyText = result.success
      ? `\u2705 Paired! This group is now connected to agent "${result.agentName}".`
      : `\u274C Pairing failed: ${result.error}`;

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

  // Get or create AgentBox for this agent (shared across all callers).
  const handle = await agentBoxManager.getOrCreate(agentId);
  const client = new AgentBoxClient(handle.endpoint, 120_000, tlsOptions);

  const promptOpts: PromptOptions = { text, agentId, mode: "channel", sessionId };
  const promptResult = await client.prompt(promptOpts);
  const resultText = await collectResponse(client, promptResult.sessionId);

  if (resultText) {
    await replyToLark(larkClient, messageId, resultText);
  }
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

// ── SSE response collector ─────────────────────────────────────

export async function collectResponse(client: AgentBoxClient, sessionId: string): Promise<string> {
  const parts: string[] = [];
  // Track the latest assistant turn so we only reply with the *final* text
  // (tool-use turns emit intermediate message_end events that aren't meant
  // for the user). pi-agent's agent_end signals the last turn is complete.
  let lastAssistantText = "";
  try {
    for await (const event of client.streamEvents(sessionId)) {
      const ev = event as Record<string, any>;
      if (ev.type === "content_block_delta" && ev.delta?.text) parts.push(ev.delta.text);
      if (ev.type === "text" && typeof ev.text === "string") parts.push(ev.text);
      // pi-agent-brain emits the final assistant reply as message_end with
      // a content array of blocks; collect the text blocks only.
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
        const turnText = blocks
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("");
        if (turnText) lastAssistantText = turnText;
      }
    }
  } catch (err) {
    console.error(`[lark] SSE collect error for session=${sessionId}:`, err);
  }
  // Prefer the last full assistant turn; fall back to streamed deltas if the
  // brain only emits content_block_delta events.
  return lastAssistantText || parts.join("");
}
