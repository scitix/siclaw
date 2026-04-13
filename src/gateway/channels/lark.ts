/**
 * Lark (飞书) channel handler.
 *
 * Connects to Lark via WebSocket-based event subscription using
 * @larksuiteoapi/node-sdk (optionalDependency — loaded dynamically).
 *
 * Flow:
 *   Lark message -> resolve userId -> getOrCreate AgentBox -> prompt -> reply
 */

import type { AgentBoxManager } from "../agentbox/manager.js";
import { AgentBoxClient, type PromptOptions } from "../agentbox/client.js";
import type { ChannelHandler } from "../channel-manager.js";

export interface LarkChannelConfig {
  app_id: string;
  app_secret: string;
  verification_token?: string;
  encrypt_key?: string;
}

/**
 * Create a Lark channel handler for one agent_channels row.
 */
export function createLarkHandler(
  channel: Record<string, any>,
  agentBoxManager: AgentBoxManager,
  tlsOptions?: { cert: string; key: string; ca: string },
): ChannelHandler {
  const agentId: string = channel.agent_id;
  const authMode: string = channel.auth_mode || "open";
  const serviceAccountId: string | undefined = channel.service_account_id;
  const config: LarkChannelConfig =
    typeof channel.config === "string"
      ? JSON.parse(channel.config)
      : channel.config;

  // Hold a reference so stop() can shut down the socket.
  let wsClient: { close(params?: { force?: boolean }): void } | null = null;

  return {
    async start() {
      let lark: typeof import("@larksuiteoapi/node-sdk");
      try {
        lark = await import("@larksuiteoapi/node-sdk");
      } catch {
        console.error(
          `[lark] @larksuiteoapi/node-sdk is not installed — skipping channel for agent=${agentId}`,
        );
        return;
      }

      const larkClient = new lark.Client({
        appId: config.app_id,
        appSecret: config.app_secret,
      });

      const dispatcher = new lark.EventDispatcher({
        verificationToken: config.verification_token,
        encryptKey: config.encrypt_key,
      });

      dispatcher.register({
        "im.message.receive_v1": async (data: any) => {
          try {
            await handleLarkMessage(
              data,
              larkClient,
              agentId,
              authMode,
              serviceAccountId,
              agentBoxManager,
              tlsOptions,
            );
          } catch (err) {
            console.error(
              `[lark] Error handling message for agent=${agentId}:`,
              err,
            );
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
        console.log(
          `[lark] Channel started for agent=${agentId} app=${config.app_id}`,
        );
      } catch (err) {
        console.error(
          `[lark] Failed to start channel for agent=${agentId}:`,
          err,
        );
      }
    },

    async stop() {
      if (wsClient) {
        wsClient.close({ force: true });
      }
      wsClient = null;
      console.log(`[lark] Channel stopped for agent=${agentId}`);
    },
  };
}

// ── Message handler ────────────────────────────────────────────

async function handleLarkMessage(
  data: any,
  larkClient: any,
  agentId: string,
  authMode: string,
  serviceAccountId: string | undefined,
  agentBoxManager: AgentBoxManager,
  tlsOptions?: { cert: string; key: string; ca: string },
): Promise<void> {
  // 1. Extract text from the incoming message event
  const message = data?.event?.message;
  if (!message) {
    console.warn("[lark] Received event with no message payload");
    return;
  }

  const messageId: string = message.message_id;
  const chatId: string = message.chat_id;
  const msgType: string = message.message_type;

  // Only handle text messages for now
  if (msgType !== "text") {
    console.log(`[lark] Ignoring non-text message type=${msgType} in chat=${chatId}`);
    return;
  }

  let text: string;
  try {
    const content = JSON.parse(message.content);
    text = content.text;
  } catch {
    console.warn(`[lark] Failed to parse message content for messageId=${messageId}`);
    return;
  }

  if (!text || text.trim().length === 0) return;

  // Strip @mention tags that Lark wraps around bot mentions
  text = text.replace(/@_user_\d+/g, "").trim();
  if (text.length === 0) return;

  // 2. Resolve userId based on auth_mode
  let userId: string;
  if (authMode === "mapped") {
    // Future: look up a Lark user → Upstream user mapping.
    // For now, fall back to service account.
    userId = serviceAccountId ?? "lark-default";
  } else {
    // "open" or "service_account" → use the service account
    userId = serviceAccountId ?? "lark-default";
  }

  console.log(
    `[lark] Message from chat=${chatId} resolved userId=${userId} agent=${agentId}: "${text.slice(0, 80)}"`,
  );

  // 3. Get or create AgentBox
  const handle = await agentBoxManager.getOrCreate(userId, agentId);
  const client = new AgentBoxClient(handle.endpoint, 120_000, tlsOptions);

  // 4. Send prompt with mode="channel"
  const promptOpts: PromptOptions = {
    text,
    agentId,
    mode: "channel",
  };

  const promptResult = await client.prompt(promptOpts);

  // 5. Drain SSE events and collect the final text
  const resultText = await collectResponse(client, promptResult.sessionId);

  // 6. Reply to Lark
  if (resultText) {
    try {
      await larkClient.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text: resultText }),
          msg_type: "text",
        },
      });
    } catch (err) {
      console.error(
        `[lark] Failed to reply to messageId=${messageId}:`,
        err,
      );
    }
  }
}

// ── SSE response collector ─────────────────────────────────────

async function collectResponse(
  client: AgentBoxClient,
  sessionId: string,
): Promise<string> {
  const parts: string[] = [];

  try {
    for await (const event of client.streamEvents(sessionId)) {
      const ev = event as Record<string, any>;

      // Collect assistant text events
      if (ev.type === "content_block_delta" && ev.delta?.text) {
        parts.push(ev.delta.text);
      }
      // Also handle the simple "text" wrapper some brains emit
      if (ev.type === "text" && typeof ev.text === "string") {
        parts.push(ev.text);
      }
    }
  } catch (err) {
    console.error(
      `[lark] SSE collect error for sessionId=${sessionId}:`,
      err,
    );
  }

  return parts.join("");
}
