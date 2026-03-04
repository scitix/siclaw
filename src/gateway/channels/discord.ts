import type { ChannelPlugin } from "../plugins/api.js";
import type { ChannelBridge } from "../plugins/channel-bridge.js";
import type { GatewayConfig, ChannelConfig } from "../config.js";
import type { ChannelDeps } from "./channel-manager.js";
import { splitMessage } from "./utils.js";

interface DiscordConfig extends ChannelConfig {
  token: string;
}

// --- Standalone send helpers (aligned with openclaw's discord/send.outbound) ---

async function sendDiscordMessage(
  client: import("discord.js").Client,
  channelId: string,
  text: string,
  opts?: { threadId?: string },
): Promise<void> {
  const target = opts?.threadId || channelId;
  const channel = await client.channels.fetch(target);
  if (!channel || !("send" in channel) || typeof channel.send !== "function") return;

  const chunks = splitMessage(text, 2000);
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

async function sendDiscordEmbed(
  client: import("discord.js").Client,
  channelId: string,
  markdown: string,
  opts?: { title?: string; threadId?: string },
): Promise<void> {
  const { EmbedBuilder } = await import("discord.js");

  const target = opts?.threadId || channelId;
  const channel = await client.channels.fetch(target);
  if (!channel || !("send" in channel) || typeof channel.send !== "function") return;

  // Discord embed description limit is 4096 chars
  const chunks = splitMessage(markdown, 4096);
  for (const chunk of chunks) {
    const embed = new EmbedBuilder().setDescription(chunk);
    if (opts?.title) {
      embed.setTitle(opts.title);
      // Only set title on the first chunk
      opts = { ...opts, title: undefined };
    }
    await channel.send({ embeds: [embed] });
  }
}

async function sendDiscordDM(
  client: import("discord.js").Client,
  userId: string,
  text: string,
): Promise<void> {
  const user = await client.users.fetch(userId);
  const chunks = splitMessage(text, 2000);
  for (const chunk of chunks) {
    await user.send(chunk);
  }
}

// --- ChannelPlugin factory ---

export function createDiscordChannel(
  config: GatewayConfig,
  channelBridge: ChannelBridge,
  deps?: ChannelDeps,
): ChannelPlugin {
  const discordConfig = config.channels.discord as DiscordConfig | undefined;
  let client: import("discord.js").Client | null = null;

  const plugin: ChannelPlugin = {
    name: "discord",

    gateway: {
      async startAccount() {
        if (!discordConfig?.enabled || !discordConfig?.token) {
          console.log("[discord] Channel disabled or no token configured");
          return;
        }

        try {
          const { Client, GatewayIntentBits, Partials } = await import("discord.js");

          const discordClient = new Client({
            intents: [
              GatewayIntentBits.Guilds,
              GatewayIntentBits.GuildMessages,
              GatewayIntentBits.MessageContent,
              GatewayIntentBits.DirectMessages,
            ],
            // Partials needed to receive DM messages
            partials: [Partials.Channel, Partials.Message],
          });

          discordClient.on("ready", () => {
            console.log(`[discord] Bot connected as ${discordClient.user?.tag}`);
          });

          discordClient.on("messageCreate", async (message) => {
            // Ignore bot messages
            if (message.author.bot) return;

            const isMentioned = message.mentions.has(discordClient.user!);
            const isDM = !message.guild;

            // Only respond to mentions or DMs
            if (!isMentioned && !isDM) return;

            // Strip bot mention from text
            let text = message.content;
            if (isMentioned && discordClient.user) {
              text = text.replace(new RegExp(`<@!?${discordClient.user.id}>`, "g"), "").trim();
            }

            if (!text) return;

            const channelId = message.channel.id;
            const userId = message.author.id;

            // Intercept /bind command
            const bindMatch = text.match(/^\/bind\s+(\d{6})$/);
            if (bindMatch && deps) {
              const code = bindMatch[1];
              const boundUserId = deps.bindCodeStore.verifyCode(code);
              if (boundUserId) {
                try {
                  deps.userStore.addBinding(boundUserId, "discord", userId);
                  const user = deps.userStore.getById(boundUserId);
                  await message.reply(
                    `Binding successful! Linked to user "${user?.username ?? boundUserId}". Future messages will be routed to this account.`,
                  );
                } catch (err) {
                  await message.reply(
                    `Binding failed: ${err instanceof Error ? err.message : "Unknown error"}`,
                  );
                }
              } else {
                await message.reply(
                  "Invalid or expired code. Please generate a new one from the web UI.",
                );
              }
              return;
            }

            await channelBridge.handleInbound("discord", channelId, userId, text);
          });

          await discordClient.login(discordConfig.token);
          client = discordClient;

          console.log("[discord] Channel started");
        } catch (err) {
          console.error("[discord] Failed to start:", err);
          throw err;
        }
      },

      async stopAccount() {
        if (client) {
          client.destroy();
          client = null;
          console.log("[discord] Channel stopped");
        }
      },
    },

    outbound: {
      async sendText({ to, text }) {
        if (!client) return;
        try {
          await sendDiscordMessage(client, to, text);
        } catch (err) {
          console.error(`[discord] Failed to send text to ${to}:`, err);
        }
      },

      async sendMarkdown({ to, markdown }) {
        if (!client) return;
        try {
          // Discord natively supports most markdown; use embeds for richer display
          await sendDiscordEmbed(client, to, markdown.content, { title: markdown.title });
        } catch (err) {
          console.error(`[discord] Failed to send markdown to ${to}:`, err);
        }
      },

      async sendDirectText({ userId, text }) {
        if (!client) return;
        try {
          await sendDiscordDM(client, userId, text);
        } catch (err) {
          console.error(`[discord] Failed to send DM to ${userId}:`, err);
        }
      },

      async sendImageData({ to, image }) {
        if (!client) return;
        try {
          const { AttachmentBuilder } = await import("discord.js");
          const buffer = Buffer.from(image.data, "base64");
          const ext = image.mimeType.split("/")[1] ?? "png";
          const attachment = new AttachmentBuilder(buffer, {
            name: image.filename ?? `image.${ext}`,
          });
          const channel = await client.channels.fetch(to);
          if (channel && "send" in channel && typeof channel.send === "function") {
            await channel.send({ files: [attachment] });
          }
        } catch (err) {
          console.error(`[discord] Failed to send image to ${to}:`, err);
        }
      },
    },
  };

  return plugin;
}
