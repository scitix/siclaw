import type { ChannelPlugin } from "../plugins/api.js";
import type { ChannelBridge } from "../plugins/channel-bridge.js";
import type { GatewayConfig, ChannelConfig } from "../config.js";
import type { ChannelDeps } from "./channel-manager.js";
import { splitMessage, markdownToSlackMrkdwn } from "./utils.js";

interface SlackConfig extends ChannelConfig {
  botToken: string;
  appToken: string;
}

// --- Standalone send helpers (aligned with openclaw's sendMessageSlack) ---

async function sendSlackMessage(
  client: import("@slack/web-api").WebClient,
  channel: string,
  text: string,
  opts?: { threadTs?: string },
): Promise<void> {
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await client.chat.postMessage({
      channel,
      text: chunk,
      ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {}),
    });
  }
}

async function sendSlackMarkdown(
  client: import("@slack/web-api").WebClient,
  channel: string,
  markdown: string,
  opts?: { threadTs?: string },
): Promise<void> {
  const mrkdwn = markdownToSlackMrkdwn(markdown);
  const chunks = splitMessage(mrkdwn, 3000); // blocks have lower effective limit
  for (const chunk of chunks) {
    await client.chat.postMessage({
      channel,
      text: chunk, // fallback for notifications
      blocks: [{ type: "section", text: { type: "mrkdwn", text: chunk } }],
      ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {}),
    });
  }
}

async function sendSlackDM(
  client: import("@slack/web-api").WebClient,
  userId: string,
  text: string,
): Promise<void> {
  // Open (or reuse) a DM conversation with the user
  const conv = await client.conversations.open({ users: userId });
  const dmChannelId = conv.channel?.id;
  if (!dmChannelId) throw new Error("Failed to open DM channel");
  await sendSlackMessage(client, dmChannelId, text);
}

// --- ChannelPlugin factory ---

export function createSlackChannel(
  config: GatewayConfig,
  channelBridge: ChannelBridge,
  deps?: ChannelDeps,
): ChannelPlugin {
  const slackConfig = config.channels.slack as SlackConfig | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any = null;
  let webClient: import("@slack/web-api").WebClient | null = null;

  const plugin: ChannelPlugin = {
    name: "slack",

    gateway: {
      async startAccount() {
        if (!slackConfig?.enabled || !slackConfig?.botToken || !slackConfig?.appToken) {
          console.log("[slack] Channel disabled or missing botToken/appToken");
          return;
        }

        try {
          const { App } = await import("@slack/bolt");

          const slackApp = new App({
            token: slackConfig.botToken,
            appToken: slackConfig.appToken,
            socketMode: true,
          });

          // Cache bot user ID for mention detection
          let botUserId: string | undefined;
          try {
            const authResult = await slackApp.client.auth.test();
            botUserId = authResult.user_id as string | undefined;
            console.log(`[slack] Bot user ID: ${botUserId}`);
          } catch (err) {
            console.warn("[slack] Could not fetch bot info:", err);
          }

          // Register message handler
          slackApp.message(async ({ message, client: _client }) => {
            // Type-narrow: only handle regular messages (not message_changed etc.)
            if (message.subtype) return;
            const msg = message as {
              text?: string;
              user?: string;
              channel?: string;
              thread_ts?: string;
              bot_id?: string;
              channel_type?: string;
            };

            // Ignore bot messages
            if (msg.bot_id) return;

            const text = msg.text ?? "";
            const channelId = msg.channel;
            const userId = msg.user;
            if (!channelId || !userId || !text) return;

            // Group/Channel: only respond when @mentioned
            const isDM = msg.channel_type === "im";
            if (!isDM) {
              if (!botUserId || !text.includes(`<@${botUserId}>`)) return;
            }

            // Strip bot mention from text
            let cleanText = text;
            if (botUserId) {
              cleanText = cleanText.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
            }
            if (!cleanText) return;

            // Intercept /bind command
            const bindMatch = cleanText.match(/^\/bind\s+(\d{6})$/);
            if (bindMatch && deps) {
              const code = bindMatch[1];
              const boundUserId = deps.bindCodeStore.verifyCode(code);
              if (boundUserId) {
                try {
                  deps.userStore.addBinding(boundUserId, "slack", userId);
                  const user = deps.userStore.getById(boundUserId);
                  await sendSlackMessage(webClient!, channelId,
                    `Binding successful! Linked to user "${user?.username ?? boundUserId}". Future messages will be routed to this account.`,
                  );
                } catch (err) {
                  await sendSlackMessage(webClient!, channelId,
                    `Binding failed: ${err instanceof Error ? err.message : "Unknown error"}`,
                  );
                }
              } else {
                await sendSlackMessage(webClient!, channelId,
                  "Invalid or expired code. Please generate a new one from the web UI.",
                );
              }
              return;
            }

            await channelBridge.handleInbound("slack", channelId, userId, cleanText);
          });

          await slackApp.start();
          app = slackApp;
          webClient = slackApp.client;

          console.log("[slack] Channel started (Socket Mode)");
        } catch (err) {
          console.error("[slack] Failed to start:", err);
          throw err;
        }
      },

      async stopAccount() {
        if (app) {
          try {
            await app.stop();
          } catch { /* ignore */ }
        }
        app = null;
        webClient = null;
        console.log("[slack] Channel stopped");
      },
    },

    outbound: {
      async sendText({ to, text }) {
        if (!webClient) return;
        try {
          await sendSlackMessage(webClient, to, text);
        } catch (err) {
          console.error(`[slack] Failed to send text to ${to}:`, err);
        }
      },

      async sendMarkdown({ to, markdown }) {
        if (!webClient) return;
        try {
          await sendSlackMarkdown(webClient, to, markdown.content);
        } catch (err) {
          console.error(`[slack] Failed to send markdown to ${to}:`, err);
        }
      },

      async sendDirectText({ userId, text }) {
        if (!webClient) return;
        try {
          await sendSlackDM(webClient, userId, text);
        } catch (err) {
          console.error(`[slack] Failed to send DM to ${userId}:`, err);
        }
      },
    },
  };

  return plugin;
}
