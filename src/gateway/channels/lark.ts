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
import { resolveBinding, handlePairingCode } from "../channel-manager.js";

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
            await handleLarkMessage(data, larkClient, channelId, agentBoxManager, tlsOptions);
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

async function handleLarkMessage(
  data: any,
  larkClient: any,
  channelId: string,
  agentBoxManager: AgentBoxManager,
  tlsOptions?: { cert: string; key: string; ca: string },
): Promise<void> {
  const message = data?.event?.message;
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
    const result = await handlePairingCode(code, channelId, chatId, "group");

    const replyText = result.success
      ? `✅ Paired! This group is now connected to agent "${result.agentName}".`
      : `❌ Pairing failed: ${result.error}`;

    await replyToLark(larkClient, messageId, replyText);
    return;
  }

  // Look up binding for this chat
  const binding = await resolveBinding(channelId, chatId);
  if (!binding) {
    console.log(`[lark] No binding for channel=${channelId} chat=${chatId} — ignoring`);
    // Don't spam the group with "not paired" for every message.
    // Only reply if the message looks like it's directed at the bot (@mention).
    return;
  }

  const agentId = binding.agentId;
  // Use a deterministic userId scoped to channel + chat for session isolation
  const userId = `lark-${chatId.slice(0, 12)}`;

  console.log(`[lark] Message channel=${channelId} chat=${chatId} → agent=${agentId}: "${text.slice(0, 80)}"`);

  // Get or create AgentBox
  const handle = await agentBoxManager.getOrCreate(userId, agentId);
  const client = new AgentBoxClient(handle.endpoint, 120_000, tlsOptions);

  const promptOpts: PromptOptions = { text, agentId, mode: "channel" };
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

async function collectResponse(client: AgentBoxClient, sessionId: string): Promise<string> {
  const parts: string[] = [];
  try {
    for await (const event of client.streamEvents(sessionId)) {
      const ev = event as Record<string, any>;
      if (ev.type === "content_block_delta" && ev.delta?.text) parts.push(ev.delta.text);
      if (ev.type === "text" && typeof ev.text === "string") parts.push(ev.text);
    }
  } catch (err) {
    console.error(`[lark] SSE collect error for session=${sessionId}:`, err);
  }
  return parts.join("");
}
