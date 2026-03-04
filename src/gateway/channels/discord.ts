import type { ChannelPlugin } from "../plugins/api.js";
import type { ChannelBridge } from "../plugins/channel-bridge.js";
import type { GatewayConfig, ChannelConfig } from "../config.js";
import type { ChannelDeps } from "./channel-manager.js";
import { splitMessage } from "./utils.js";

interface DiscordConfig extends ChannelConfig {
  token: string;
}

export function createDiscordChannel(
  config: GatewayConfig,
  channelBridge: ChannelBridge,
  _deps?: ChannelDeps,
): ChannelPlugin {
  const discordConfig = config.channels.discord as DiscordConfig | undefined;
  let client: unknown = null;

  const plugin: ChannelPlugin = {
    name: "discord",

    gateway: {
      async startAccount() {
        if (!discordConfig?.enabled || !discordConfig?.token) {
          console.log("[discord] Channel disabled or no token configured");
          return;
        }

        try {
          // Dynamic import since discord.js is optional
          const { Client, GatewayIntentBits } = await import("discord.js");

          const discordClient = new Client({
            intents: [
              GatewayIntentBits.Guilds,
              GatewayIntentBits.GuildMessages,
              GatewayIntentBits.MessageContent,
              GatewayIntentBits.DirectMessages,
            ],
          });

          discordClient.on("ready", () => {
            console.log(`[discord] Bot connected as ${discordClient.user?.tag}`);
          });

          discordClient.on("messageCreate", async (message) => {
            // Ignore bot's own messages
            if (message.author.bot) return;

            // Only respond to mentions or DMs
            const isMentioned = message.mentions.has(discordClient.user!);
            const isDM = !message.guild;

            if (!isMentioned && !isDM) return;

            // Strip bot mention from text
            let text = message.content;
            if (isMentioned && discordClient.user) {
              text = text.replace(new RegExp(`<@!?${discordClient.user.id}>`, "g"), "").trim();
            }

            if (!text) return;

            const channelId = message.channel.id;
            const userId = message.author.id;

            await channelBridge.handleInbound("discord", channelId, userId, text);
          });

          await discordClient.login(discordConfig.token);
          client = discordClient;

          console.log("[discord] Channel started");
        } catch (err) {
          console.error("[discord] Failed to start:", err);
        }
      },

      async stopAccount() {
        if (client) {
          const discordClient = client as import("discord.js").Client;
          discordClient.destroy();
          client = null;
          console.log("[discord] Channel stopped");
        }
      },
    },

    outbound: {
      async sendText({ to, text }) {
        if (!client) return;

        try {
          const discordClient = client as import("discord.js").Client;
          const channel = await discordClient.channels.fetch(to);
          if (channel && "send" in channel && typeof channel.send === "function") {
            // Discord message limit is 2000 chars — split if needed
            const chunks = splitMessage(text, 2000);
            for (const chunk of chunks) {
              await channel.send(chunk);
            }
          }
        } catch (err) {
          console.error(`[discord] Failed to send to ${to}:`, err);
        }
      },
    },
  };

  return plugin;
}

