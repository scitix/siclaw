import type { ChannelPlugin } from "../plugins/api.js";
import type { ChannelBridge } from "../plugins/channel-bridge.js";
import type { GatewayConfig, ChannelConfig } from "../config.js";
import type { ChannelDeps } from "./channel-manager.js";
import { splitMessage, markdownToTelegramHtml } from "./utils.js";

interface TelegramConfig extends ChannelConfig {
  botToken: string;
}

/**
 * Regex matching Telegram HTML parse errors (aligned with openclaw's PARSE_ERR_RE).
 * When the API rejects our HTML, we retry as plain text.
 */
const PARSE_ERR_RE = /can't parse entities/i;

// --- Standalone send helpers (aligned with openclaw's sendMessageTelegram) ---

async function sendTelegramMessage(
  bot: import("grammy").Bot,
  chatId: string | number,
  text: string,
  opts?: { replyToMessageId?: number; messageThreadId?: number },
): Promise<void> {
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        ...(opts?.replyToMessageId
          ? { reply_parameters: { message_id: opts.replyToMessageId } }
          : {}),
        ...(opts?.messageThreadId
          ? { message_thread_id: opts.messageThreadId }
          : {}),
      });
    } catch (err: unknown) {
      // Fallback: if HTML parse fails, retry as plain text
      const msg = err instanceof Error ? err.message : String(err);
      if (PARSE_ERR_RE.test(msg)) {
        await bot.api.sendMessage(chatId, chunk, {
          ...(opts?.replyToMessageId
            ? { reply_parameters: { message_id: opts.replyToMessageId } }
            : {}),
          ...(opts?.messageThreadId
            ? { message_thread_id: opts.messageThreadId }
            : {}),
        });
      } else {
        throw err;
      }
    }
  }
}

// --- ChannelPlugin factory ---

export function createTelegramChannel(
  config: GatewayConfig,
  channelBridge: ChannelBridge,
  deps?: ChannelDeps,
): ChannelPlugin {
  const telegramConfig = config.channels.telegram as TelegramConfig | undefined;

  let bot: import("grammy").Bot | null = null;

  const plugin: ChannelPlugin = {
    name: "telegram",

    gateway: {
      async startAccount() {
        if (!telegramConfig?.enabled || !telegramConfig?.botToken) {
          console.log("[telegram] Channel disabled or no botToken configured");
          return;
        }

        try {
          const { Bot: GrammyBot } = await import("grammy");

          const tgBot = new GrammyBot(telegramConfig.botToken);

          // Cache bot info for mention detection
          let botUsername: string | undefined;

          // Global error handler (aligned with openclaw's recoverable error pattern)
          tgBot.catch((err) => {
            console.error("[telegram] Unhandled error:", err.error);
          });

          // Handle text messages
          tgBot.on("message:text", async (ctx) => {
            const text = ctx.message.text ?? "";
            const chatId = String(ctx.chat.id);
            const userId = String(ctx.from.id);
            const chatType = ctx.chat.type; // "private" | "group" | "supergroup" | "channel"

            // Group/supergroup: only respond to @mention or / commands
            if (chatType !== "private") {
              const isMentioned = botUsername
                ? text.includes(`@${botUsername}`)
                : false;
              const isCommand = text.startsWith("/");
              if (!isMentioned && !isCommand) return;
            }

            // Strip bot mention from text
            let cleanText = text;
            if (botUsername) {
              cleanText = cleanText.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();
            }
            if (!cleanText) return;

            // Intercept /bind command
            const bindMatch = cleanText.match(/^\/bind\s+(\d{6})$/);
            if (bindMatch && deps) {
              const code = bindMatch[1];
              const boundUserId = deps.bindCodeStore.verifyCode(code);
              if (boundUserId) {
                try {
                  deps.userStore.addBinding(boundUserId, "telegram", userId);
                  const user = deps.userStore.getById(boundUserId);
                  await ctx.reply(
                    `Binding successful! Linked to user "${user?.username ?? boundUserId}". Future messages will be routed to this account.`,
                  );
                } catch (err) {
                  await ctx.reply(
                    `Binding failed: ${err instanceof Error ? err.message : "Unknown error"}`,
                  );
                }
              } else {
                await ctx.reply(
                  "Invalid or expired code. Please generate a new one from the web UI.",
                );
              }
              return;
            }

            await channelBridge.handleInbound("telegram", chatId, userId, cleanText);
          });

          // Start long polling
          // bot.start() is non-blocking in grammy — it runs in the background
          tgBot.start({
            onStart: (info) => {
              botUsername = info.username;
              console.log(`[telegram] Bot connected as @${info.username}`);
            },
          });

          bot = tgBot;
          console.log("[telegram] Channel started (long polling)");
        } catch (err) {
          console.error("[telegram] Failed to start:", err);
          throw err;
        }
      },

      async stopAccount() {
        if (bot) {
          try {
            bot.stop();
          } catch { /* ignore */ }
        }
        bot = null;
        console.log("[telegram] Channel stopped");
      },
    },

    outbound: {
      async sendText({ to, text }) {
        if (!bot) return;
        try {
          // Convert to HTML for richer display
          const html = markdownToTelegramHtml(text);
          await sendTelegramMessage(bot, to, html);
        } catch (err) {
          console.error(`[telegram] Failed to send text to ${to}:`, err);
        }
      },

      async sendMarkdown({ to, markdown }) {
        if (!bot) return;
        try {
          const html = markdownToTelegramHtml(markdown.content);
          await sendTelegramMessage(bot, to, html);
        } catch (err) {
          console.error(`[telegram] Failed to send markdown to ${to}:`, err);
        }
      },

      async sendDirectText({ userId, text }) {
        if (!bot) return;
        try {
          // In Telegram, DM is just sendMessage to the user's chat ID
          const html = markdownToTelegramHtml(text);
          await sendTelegramMessage(bot, userId, html);
        } catch (err) {
          console.error(`[telegram] Failed to send DM to ${userId}:`, err);
        }
      },
    },
  };

  return plugin;
}
