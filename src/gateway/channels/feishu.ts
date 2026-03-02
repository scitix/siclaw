import type {
  ChannelPlugin,
  StreamingCard,
  MarkdownData,
  RichTextData,
  ActionCardData,
} from "../plugins/api.js";
import type {
  ChannelBridge,
  ImageInput,
  FileInput,
  AudioInput,
  VideoInput,
  StickerInput,
  MediaInputs,
} from "../plugins/channel-bridge.js";
import type { GatewayConfig, ChannelConfig } from "../config.js";
import type { ChannelDeps } from "./channel-manager.js";
import { splitMessage } from "./utils.js";
import { containsMarkdown, markdownToFeishuPost } from "./feishu-format.js";

// ─── CardKit Streaming API helpers ──────────────────────────

const FEISHU_API = "https://open.feishu.cn/open-apis";
const LARK_API = "https://open.larksuite.com/open-apis";

function resolveApiBase(domain?: "feishu" | "lark"): string {
  return domain === "lark" ? LARK_API : FEISHU_API;
}

/** Token cache keyed by domain|appId */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getTenantAccessToken(
  appId: string,
  appSecret: string,
  domain?: "feishu" | "lark",
): Promise<string> {
  const key = `${domain ?? "feishu"}|${appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const resp = await fetch(`${resolveApiBase(domain)}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const r = (await resp.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (r.code !== 0 || !r.tenant_access_token) {
    throw new Error(`Failed to get tenant access token: ${r.msg}`);
  }
  tokenCache.set(key, {
    token: r.tenant_access_token,
    expiresAt: Date.now() + (r.expire ?? 7200) * 1000,
  });
  return r.tenant_access_token;
}

/** Smart receive_id_type from ID prefix (matches openclaw behaviour) */
function resolveReceiveIdType(id: string): "open_id" | "union_id" | "chat_id" {
  if (id.startsWith("ou_")) return "open_id";
  if (id.startsWith("on_")) return "union_id";
  return "chat_id";
}

// ─────────────────────────────────────────────────────────────

interface FeishuConfig extends ChannelConfig {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
}

export function createFeishuChannel(
  config: GatewayConfig,
  channelBridge: ChannelBridge,
  deps?: ChannelDeps,
): ChannelPlugin {
  const feishuConfig = config.channels.feishu as FeishuConfig | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let apiClient: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wsClient: any = null;

  const plugin: ChannelPlugin = {
    name: "feishu",

    gateway: {
      async startAccount() {
        if (!feishuConfig?.enabled || !feishuConfig?.appId || !feishuConfig?.appSecret) {
          console.log("[feishu] Channel disabled or missing appId/appSecret");
          return;
        }

        try {
          const lark = await import("@larksuiteoapi/node-sdk");

          const domain =
            feishuConfig.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

          apiClient = new lark.Client({
            appId: feishuConfig.appId,
            appSecret: feishuConfig.appSecret,
            domain,
          });

          // Get bot info for mention detection in groups
          let botOpenId: string | undefined;
          try {
            const botInfo = await (apiClient as any).request({
              method: "GET",
              url: "/open-apis/bot/v3/info",
            });
            botOpenId = botInfo?.bot?.open_id ?? botInfo?.data?.bot?.open_id;
            console.log(`[feishu] Bot open_id: ${botOpenId}`);
          } catch (err) {
            console.warn("[feishu] Could not fetch bot info:", err);
          }

          const eventDispatcher = new lark.EventDispatcher({});
          // Helper to download media (image or file) and convert to base64
          async function downloadMedia(
            messageId: string,
            fileKey: string,
            type: "image" | "file",
          ): Promise<{ data: string; mimeType: string } | null> {
            try {
              const resp = await (apiClient as any).im.messageResource.get({
                path: { message_id: messageId, file_key: fileKey },
                params: { type },
              });

              if (resp?.data) {
                // resp.data is a ReadableStream or Buffer
                let buffer: Buffer;
                if (Buffer.isBuffer(resp.data)) {
                  buffer = resp.data;
                } else if (resp.data instanceof ArrayBuffer) {
                  buffer = Buffer.from(resp.data);
                } else if (typeof resp.data.arrayBuffer === "function") {
                  buffer = Buffer.from(await resp.data.arrayBuffer());
                } else {
                  console.warn("[feishu] Unknown media data type");
                  return null;
                }

                // Determine mime type from content-type header or default
                const contentType =
                  type === "image"
                    ? "image/png"
                    : "application/octet-stream";

                return {
                  data: buffer.toString("base64"),
                  mimeType: contentType,
                };
              }
            } catch (err) {
              console.error(`[feishu] Failed to download ${type}:`, err);
            }
            return null;
          }

          // Dedup: Feishu may deliver the same event multiple times
          const processedMessageIds = new Set<string>();
          const MESSAGE_ID_TTL = 5 * 60 * 1000; // 5 minutes

          eventDispatcher.register({
            "im.message.receive_v1": async (data: any) => {
              try {
                const message = data.message;
                const sender = data.sender;

                // Ignore bot's own messages
                if (sender?.sender_type === "app") return;

                const chatId: string | undefined = message?.chat_id;
                const chatType: string | undefined = message?.chat_type; // "p2p" | "group"
                const senderId: string | undefined = sender?.sender_id?.open_id;
                const messageId: string | undefined = message?.message_id;

                if (!chatId || !senderId) return;

                // Deduplicate by message_id
                if (messageId) {
                  if (processedMessageIds.has(messageId)) {
                    console.log(`[feishu] Duplicate message ${messageId}, skipping`);
                    return;
                  }
                  processedMessageIds.add(messageId);
                  setTimeout(() => processedMessageIds.delete(messageId), MESSAGE_ID_TTL);
                }

                // Group chat: only respond when bot is @mentioned
                if (chatType === "group") {
                  const mentions = message?.mentions as
                    | Array<{ id?: { open_id?: string }; key?: string }>
                    | undefined;
                  const isBotMentioned = botOpenId
                    ? mentions?.some((m) => m.id?.open_id === botOpenId)
                    : (mentions?.length ?? 0) > 0;
                  if (!isBotMentioned) return;
                }

                const messageType = message?.message_type;
                let text = "";
                const images: ImageInput[] = [];
                const files: FileInput[] = [];
                const audios: AudioInput[] = [];
                const videos: VideoInput[] = [];
                let sticker: StickerInput | undefined;

                if (messageType === "text") {
                  try {
                    const content = JSON.parse(message.content);
                    text = content.text ?? "";
                  } catch {
                    return;
                  }

                  // Strip @mention markers from text
                  const mentions = message?.mentions as Array<{ key?: string }> | undefined;
                  if (mentions) {
                    for (const m of mentions) {
                      if (m.key) {
                        text = text.replace(m.key, "").trim();
                      }
                    }
                  }
                } else if (messageType === "image" && messageId) {
                  // Handle image message
                  try {
                    const content = JSON.parse(message.content);
                    const imageKey = content.image_key;
                    if (imageKey) {
                      const media = await downloadMedia(messageId, imageKey, "image");
                      if (media) {
                        images.push({
                          data: media.data,
                          mimeType: media.mimeType,
                        });
                        text = "[User sent an image]";
                      }
                    }
                  } catch {
                    return;
                  }
                } else if (messageType === "file" && messageId) {
                  // Handle file message
                  try {
                    const content = JSON.parse(message.content);
                    const fileKey = content.file_key;
                    const fileName = content.file_name ?? "unknown";
                    if (fileKey) {
                      const media = await downloadMedia(messageId, fileKey, "file");
                      if (media) {
                        files.push({
                          data: media.data,
                          mimeType: media.mimeType,
                          filename: fileName,
                        });
                        text = `[User sent a file: ${fileName}]`;
                      }
                    }
                  } catch {
                    return;
                  }
                } else if (messageType === "audio" && messageId) {
                  // Handle audio message
                  try {
                    const content = JSON.parse(message.content);
                    const fileKey = content.file_key;
                    const duration = content.duration;
                    if (fileKey) {
                      const media = await downloadMedia(messageId, fileKey, "file");
                      if (media) {
                        audios.push({
                          data: media.data,
                          mimeType: "audio/ogg",
                          duration,
                        });
                        text = `[User sent a voice message ${duration ? `(${Math.round(duration / 1000)}s)` : ""}]`;
                      }
                    }
                  } catch {
                    return;
                  }
                } else if ((messageType === "media" || messageType === "video") && messageId) {
                  // Handle video message
                  try {
                    const content = JSON.parse(message.content);
                    const fileKey = content.file_key;
                    const duration = content.duration;
                    if (fileKey) {
                      const media = await downloadMedia(messageId, fileKey, "file");
                      if (media) {
                        videos.push({
                          data: media.data,
                          mimeType: "video/mp4",
                          duration,
                        });
                        text = `[User sent a video ${duration ? `(${Math.round(duration / 1000)}s)` : ""}]`;
                      }
                    }
                  } catch {
                    return;
                  }
                } else if (messageType === "sticker") {
                  // Handle sticker message
                  try {
                    const content = JSON.parse(message.content);
                    sticker = { stickerId: content.file_key ?? "unknown" };
                    text = "[User sent a sticker]";
                  } catch {
                    return;
                  }
                } else if (messageType === "post") {
                  // Handle rich text (post) message
                  try {
                    const content = JSON.parse(message.content);
                    const post = content.zh_cn ?? content.en_us ?? Object.values(content)[0];
                    if (post) {
                      text = post.title ? `[${post.title}]\n` : "";
                      // Extract text from post content
                      if (Array.isArray(post.content)) {
                        for (const line of post.content) {
                          if (Array.isArray(line)) {
                            for (const elem of line) {
                              if (elem.tag === "text") {
                                text += elem.text ?? "";
                              } else if (elem.tag === "a") {
                                text += `[${elem.text}](${elem.href})`;
                              } else if (elem.tag === "at") {
                                // Skip @mentions in extracted text
                              } else if (elem.tag === "img" && messageId) {
                                const media = await downloadMedia(messageId, elem.image_key, "image");
                                if (media) {
                                  images.push({ data: media.data, mimeType: media.mimeType });
                                }
                              }
                            }
                            text += "\n";
                          }
                        }
                      }
                      text = text.trim();
                    }
                  } catch {
                    return;
                  }
                } else {
                  // Unsupported message type - log and skip
                  console.log(`[feishu] Unsupported message type: ${messageType}`);
                  return;
                }

                if (!text && images.length === 0 && files.length === 0 && audios.length === 0 && videos.length === 0 && !sticker) return;

                // Intercept bind commands: /bind xxx
                const bindMatch = text.match(/^\/(?:bind)\s+(\d{6})$/);
                if (bindMatch && deps) {
                  const code = bindMatch[1];
                  const userId = deps.bindCodeStore.verifyCode(code);
                  if (userId) {
                    try {
                      deps.userStore.addBinding(userId, "feishu", senderId);
                      const user = deps.userStore.getById(userId);
                      await plugin.outbound?.sendText?.({
                        to: chatId,
                        text: `Binding successful! Linked to user "${user?.username ?? userId}". Future messages will be routed to this account.`,
                      });
                    } catch (err) {
                      await plugin.outbound?.sendText?.({
                        to: chatId,
                        text: `Binding failed: ${err instanceof Error ? err.message : "Unknown error"}`,
                      });
                    }
                  } else {
                    await plugin.outbound?.sendText?.({
                      to: chatId,
                      text: "Invalid or expired code. Please generate a new one from the web UI.",
                    });
                  }
                  return;
                }

                // /env command removed — credential-based workspace system replaces environments
                const envMatch = text.match(/^\/(?:env)(?:\s+(.+))?$/);
                if (envMatch) {
                  await plugin.outbound?.sendText?.({
                    to: chatId,
                    text: "Environment selection has been removed. Credentials are now automatically mounted via workspace configuration.",
                  });
                  return;
                }

                const media: MediaInputs | undefined =
                  images.length > 0 || files.length > 0 || audios.length > 0 || videos.length > 0 || sticker
                    ? {
                        images: images.length > 0 ? images : undefined,
                        files: files.length > 0 ? files : undefined,
                        audios: audios.length > 0 ? audios : undefined,
                        videos: videos.length > 0 ? videos : undefined,
                        sticker,
                      }
                    : undefined;

                // Acknowledge receipt with a reaction (fire-and-forget)
                if (messageId && apiClient) {
                  (apiClient as any).im.messageReaction.create({
                    path: { message_id: messageId },
                    data: { reaction_type: { emoji_type: "OnIt" } },
                  }).catch(() => {/* ignore reaction failures */});
                }

                await channelBridge.handleInbound("feishu", chatId, senderId, text, media);
              } catch (err) {
                console.error("[feishu] Error handling message:", err);
              }
            },
          });

          wsClient = new lark.WSClient({
            appId: feishuConfig.appId,
            appSecret: feishuConfig.appSecret,
            domain,
            loggerLevel: lark.LoggerLevel.info,
          });
          await wsClient.start({ eventDispatcher });

          console.log("[feishu] Channel started (WebSocket mode)");
        } catch (err) {
          console.error("[feishu] Failed to start:", err);
        }
      },

      async stopAccount() {
        if (wsClient) {
          try {
            wsClient.close();
          } catch {
            /* ignore */
          }
        }
        wsClient = null;
        apiClient = null;
        console.log("[feishu] Channel stopped");
      },
    },

    outbound: {
      async sendText({ to, text }) {
        if (!apiClient) return;

        try {
          // Auto-convert markdown to Feishu post (rich text) format
          if (containsMarkdown(text)) {
            await (apiClient as any).im.message.create({
              params: { receive_id_type: resolveReceiveIdType(to) },
              data: {
                receive_id: to,
                msg_type: "post",
                content: markdownToFeishuPost(text),
              },
            });
            return;
          }

          const chunks = splitMessage(text, 3800);
          for (let i = 0; i < chunks.length; i++) {
            await (apiClient as any).im.message.create({
              params: { receive_id_type: resolveReceiveIdType(to) },
              data: {
                receive_id: to,
                msg_type: "text",
                content: JSON.stringify({ text: chunks[i] }),
              },
            });
            if (i < chunks.length - 1) {
              await new Promise((r) => setTimeout(r, 50));
            }
          }
        } catch (err) {
          console.error(`[feishu] Failed to send to ${to}:`, err);
        }
      },

      async sendDirectText({ userId, text }) {
        if (!apiClient) return;

        try {
          // Auto-convert markdown to Feishu post (rich text) format
          if (containsMarkdown(text)) {
            await (apiClient as any).im.message.create({
              params: { receive_id_type: "open_id" },
              data: {
                receive_id: userId,
                msg_type: "post",
                content: markdownToFeishuPost(text),
              },
            });
            return;
          }

          const chunks = splitMessage(text, 3800);
          for (let i = 0; i < chunks.length; i++) {
            await (apiClient as any).im.message.create({
              params: { receive_id_type: "open_id" },
              data: {
                receive_id: userId,
                msg_type: "text",
                content: JSON.stringify({ text: chunks[i] }),
              },
            });
            if (i < chunks.length - 1) {
              await new Promise((r) => setTimeout(r, 50));
            }
          }
        } catch (err) {
          console.error(`[feishu] Failed to send direct message to ${userId}:`, err);
        }
      },

      async sendMarkdown({ to, markdown, replyTo }) {
        if (!apiClient) return;

        try {
          // Feishu doesn't have native markdown message, use interactive card
          const adapted = adaptMarkdownForFeishu(markdown.content);
          const cardContent = {
            config: { wide_screen_mode: true },
            header: markdown.title
              ? { template: "blue", title: { tag: "plain_text", content: markdown.title } }
              : undefined,
            elements: [{ tag: "markdown", content: adapted }],
          };

          await (apiClient as any).im.message.create({
            params: { receive_id_type: resolveReceiveIdType(to) },
            data: {
              receive_id: to,
              msg_type: "interactive",
              content: JSON.stringify(cardContent),
            },
          });
        } catch (err) {
          console.error(`[feishu] Failed to send markdown to ${to}:`, err);
        }
      },

      async sendImageData({ to, image }) {
        if (!apiClient) return;

        try {
          const buffer = Buffer.from(image.data, "base64");
          const uploadResp = await (apiClient as any).im.image.create({
            data: {
              image_type: "message",
              image: buffer,
            },
          });

          const imageKey = uploadResp?.data?.image_key;
          if (!imageKey) {
            throw new Error("Failed to upload image");
          }

          await (apiClient as any).im.message.create({
            params: { receive_id_type: resolveReceiveIdType(to) },
            data: {
              receive_id: to,
              msg_type: "image",
              content: JSON.stringify({ image_key: imageKey }),
            },
          });
        } catch (err) {
          console.error(`[feishu] Failed to send image to ${to}:`, err);
        }
      },

      async sendFile({ to, file }) {
        if (!apiClient) return;

        try {
          const buffer = Buffer.from(file.data, "base64");
          const uploadResp = await (apiClient as any).im.file.create({
            data: {
              file_type: "stream",
              file_name: file.filename,
              file: buffer,
            },
          });

          const fileKey = uploadResp?.data?.file_key;
          if (!fileKey) {
            throw new Error("Failed to upload file");
          }

          await (apiClient as any).im.message.create({
            params: { receive_id_type: resolveReceiveIdType(to) },
            data: {
              receive_id: to,
              msg_type: "file",
              content: JSON.stringify({ file_key: fileKey }),
            },
          });
        } catch (err) {
          console.error(`[feishu] Failed to send file to ${to}:`, err);
        }
      },

      async sendAudio({ to, audio }) {
        if (!apiClient) return;

        try {
          const buffer = Buffer.from(audio.data, "base64");
          const uploadResp = await (apiClient as any).im.file.create({
            data: {
              file_type: "opus",
              file_name: audio.filename ?? "audio.opus",
              file: buffer,
              duration: audio.duration ? audio.duration * 1000 : undefined,
            },
          });

          const fileKey = uploadResp?.data?.file_key;
          if (!fileKey) {
            throw new Error("Failed to upload audio");
          }

          await (apiClient as any).im.message.create({
            params: { receive_id_type: resolveReceiveIdType(to) },
            data: {
              receive_id: to,
              msg_type: "audio",
              content: JSON.stringify({ file_key: fileKey }),
            },
          });
        } catch (err) {
          console.error(`[feishu] Failed to send audio to ${to}:`, err);
        }
      },

      async sendVideo({ to, video }) {
        if (!apiClient) return;

        try {
          const buffer = Buffer.from(video.data, "base64");
          // Upload video file
          const uploadResp = await (apiClient as any).im.file.create({
            data: {
              file_type: "mp4",
              file_name: video.filename ?? "video.mp4",
              file: buffer,
              duration: video.duration ? video.duration * 1000 : undefined,
            },
          });

          const fileKey = uploadResp?.data?.file_key;
          if (!fileKey) {
            throw new Error("Failed to upload video");
          }

          // Upload thumbnail if provided
          let imageKey: string | undefined;
          if (video.thumbnail) {
            const thumbBuffer = Buffer.from(video.thumbnail, "base64");
            const thumbResp = await (apiClient as any).im.image.create({
              data: { image_type: "message", image: thumbBuffer },
            });
            imageKey = thumbResp?.data?.image_key;
          }

          await (apiClient as any).im.message.create({
            params: { receive_id_type: resolveReceiveIdType(to) },
            data: {
              receive_id: to,
              msg_type: "media",
              content: JSON.stringify({
                file_key: fileKey,
                image_key: imageKey,
              }),
            },
          });
        } catch (err) {
          console.error(`[feishu] Failed to send video to ${to}:`, err);
        }
      },

      async sendRichText({ to, richText }) {
        if (!apiClient) return;

        try {
          // Convert RichTextData to Feishu post format
          const postContent: Record<string, unknown>[][] = richText.content.map((line) =>
            line.map((elem) => {
              if (elem.tag === "text") {
                return { tag: "text", text: elem.text ?? "" };
              } else if (elem.tag === "a") {
                return { tag: "a", text: elem.text ?? "", href: elem.href ?? "" };
              } else if (elem.tag === "at") {
                return { tag: "at", user_id: elem.userId ?? "" };
              } else if (elem.tag === "img") {
                return { tag: "img", image_key: elem.imageKey ?? "" };
              }
              return { tag: "text", text: "" };
            }),
          );

          const content = {
            zh_cn: {
              title: richText.title ?? "",
              content: postContent,
            },
          };

          await (apiClient as any).im.message.create({
            params: { receive_id_type: resolveReceiveIdType(to) },
            data: {
              receive_id: to,
              msg_type: "post",
              content: JSON.stringify(content),
            },
          });
        } catch (err) {
          console.error(`[feishu] Failed to send rich text to ${to}:`, err);
        }
      },

      async sendActionCard({ to, card }) {
        if (!apiClient) return;

        try {
          const elements: Record<string, unknown>[] = [
            { tag: "markdown", content: adaptMarkdownForFeishu(card.text) },
          ];

          // Add buttons if provided
          if (card.buttons && card.buttons.length > 0) {
            const actions = card.buttons.map((btn) => ({
              tag: "button",
              text: { tag: "plain_text", content: btn.title },
              type: "primary",
              url: btn.actionUrl,
              value: btn.callbackId ? { callback_id: btn.callbackId } : undefined,
            }));

            elements.push({
              tag: "action",
              actions,
              layout: card.btnOrientation === "1" ? "bisected" : "flow",
            });
          } else if (card.singleTitle && card.singleUrl) {
            elements.push({
              tag: "action",
              actions: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: card.singleTitle },
                  type: "primary",
                  url: card.singleUrl,
                },
              ],
            });
          }

          const cardContent = {
            config: { wide_screen_mode: true },
            header: {
              template: "blue",
              title: { tag: "plain_text", content: card.title },
            },
            elements,
          };

          await (apiClient as any).im.message.create({
            params: { receive_id_type: resolveReceiveIdType(to) },
            data: {
              receive_id: to,
              msg_type: "interactive",
              content: JSON.stringify(cardContent),
            },
          });
        } catch (err) {
          console.error(`[feishu] Failed to send action card to ${to}:`, err);
        }
      },
    },

    streaming: {
      async createCard({ to, title }): Promise<StreamingCard> {
        if (!apiClient || !feishuConfig?.appId || !feishuConfig?.appSecret) {
          throw new Error("Feishu client not initialized");
        }

        const apiBase = resolveApiBase(feishuConfig.domain);
        const token = await getTenantAccessToken(
          feishuConfig.appId, feishuConfig.appSecret, feishuConfig.domain,
        );

        // 1. Create CardKit card entity with streaming mode (schema 2.0)
        const cardJson = {
          schema: "2.0",
          ...(title ? { header: { title: { content: title, tag: "plain_text" } } } : {}),
          config: {
            streaming_mode: true,
            summary: { content: "[Generating...]" },
            streaming_config: {
              print_frequency_ms: { default: 50 },
              print_step: { default: 2 },
              print_strategy: "fast",
            },
          },
          body: {
            elements: [{
              tag: "markdown",
              content: "⏳ Thinking...",
              element_id: "streaming_content",
            }],
          },
        };

        const createResp = await fetch(`${apiBase}/cardkit/v1/cards`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
        });

        const cr = (await createResp.json()) as {
          code: number; msg: string; data?: { card_id: string };
        };
        if (cr.code !== 0 || !cr.data?.card_id) {
          throw new Error(`Failed to create streaming card: ${cr.msg}`);
        }

        // 2. Send card as a message
        const sendResp = await (apiClient as any).im.message.create({
          params: { receive_id_type: resolveReceiveIdType(to) },
          data: {
            receive_id: to,
            msg_type: "interactive",
            content: JSON.stringify({ type: "card", data: { card_id: cr.data.card_id } }),
          },
        });

        const messageId = sendResp?.data?.message_id;
        if (!messageId) {
          throw new Error("Failed to send streaming card message");
        }

        console.log(`[feishu] Streaming card created: cardId=${cr.data.card_id}, msgId=${messageId}`);
        return {
          cardId: cr.data.card_id,
          messageId,
          chatId: to,
          title: title ?? "AI Response",
          sequence: 1,
          elementId: "streaming_content",
        };
      },

      async updateCard({ card, content }): Promise<void> {
        if (!feishuConfig?.appId || !feishuConfig?.appSecret) return;

        const seq = ((card.sequence as number) ?? 1) + 1;
        card.sequence = seq;

        const apiBase = resolveApiBase(feishuConfig.domain);
        const token = await getTenantAccessToken(
          feishuConfig.appId, feishuConfig.appSecret, feishuConfig.domain,
        );
        const elementId = (card.elementId as string) ?? "streaming_content";

        const resp = await fetch(
          `${apiBase}/cardkit/v1/cards/${card.cardId}/elements/${elementId}/content`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              content: content || "...",
              sequence: seq,
              uuid: `stream_${card.cardId}_${seq}`,
            }),
          },
        );

        const r = (await resp.json()) as { code: number; msg: string };
        if (r.code !== 0) {
          console.warn(`[feishu] Streaming update failed: ${r.msg}`);
        }
      },

      async finalizeCard({ card, content, toolOutputs }): Promise<void> {
        if (!feishuConfig?.appId || !feishuConfig?.appSecret) return;

        const apiBase = resolveApiBase(feishuConfig.domain);
        const token = await getTenantAccessToken(
          feishuConfig.appId, feishuConfig.appSecret, feishuConfig.domain,
        );
        const elementId = (card.elementId as string) ?? "streaming_content";

        // Update final text
        let seq = ((card.sequence as number) ?? 1) + 1;
        card.sequence = seq;

        if (content) {
          await fetch(
            `${apiBase}/cardkit/v1/cards/${card.cardId}/elements/${elementId}/content`,
            {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                content,
                sequence: seq,
                uuid: `stream_${card.cardId}_${seq}`,
              }),
            },
          );
        }

        // Close streaming mode
        seq += 1;
        const summary = content
          ? content.replace(/\n/g, " ").trim().slice(0, 50) + (content.length > 50 ? "..." : "")
          : "";

        await fetch(`${apiBase}/cardkit/v1/cards/${card.cardId}/settings`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            settings: JSON.stringify({
              config: {
                streaming_mode: false,
                summary: { content: summary },
              },
            }),
            sequence: seq,
            uuid: `close_${card.cardId}_${seq}`,
          }),
        });

        console.log(`[feishu] Streaming card finalized: ${card.cardId}`);

        // After streaming ends, rebuild card with collapsible panels for tool outputs
        const messageId = card.messageId as string | undefined;
        if (toolOutputs?.length && messageId && apiClient) {
          try {
            // Build structured card: AI response on top, tool details in collapsible panels
            const elements: unknown[] = [];

            // Extract assistant text from content (after last ---)
            const parts = content.split("\n\n---\n\n");
            const aiResponse = parts.length > 1 ? parts[parts.length - 1] : content;

            // AI response as main content
            if (aiResponse) {
              elements.push({ tag: "markdown", content: aiResponse });
            }

            // Divider before tool details
            if (toolOutputs.length > 0) {
              elements.push({ tag: "hr" });
            }

            // Each tool call in a collapsible panel (collapsed by default)
            for (const tool of toolOutputs) {
              const title = tool.command
                ? `🔧 ${tool.name}  ${tool.command}`
                : `🔧 ${tool.name}`;
              // Truncate output for panel body (keep more than streaming, ~2000 chars)
              let body = tool.output || "(no output)";
              if (body.length > 2000) {
                body = body.slice(0, 2000) + "\n... (truncated)";
              }
              elements.push({
                tag: "collapsible_panel",
                expanded: false,
                header: {
                  title: {
                    tag: "plain_text",
                    content: title.slice(0, 200),
                  },
                },
                border: { color: "grey", corner_radius: "5px" },
                body: {
                  elements: [
                    { tag: "markdown", content: body },
                  ],
                },
              });
            }

            const newCard = {
              config: { wide_screen_mode: true },
              elements,
            };

            await (apiClient as any).im.message.patch({
              path: { message_id: messageId },
              data: {
                msg_type: "interactive",
                content: JSON.stringify(newCard),
              },
            });

            console.log(`[feishu] Card rebuilt with ${toolOutputs.length} collapsible panels: ${messageId}`);
          } catch (err) {
            // Non-fatal: card was already finalized with flat content
            console.error(`[feishu] Failed to rebuild card with collapsible panels:`, err);
          }
        }
      },
    },
  };

  return plugin;
}

// ─── Markdown Table → List Adapter ─────────────────────────
//
// Feishu's card markdown renderer handles wide tables very poorly.
// Tables with > 3 columns are converted to a compact list format
// where each row becomes a block with key-value pairs.

function parseTableRow(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^\|[\s\-:]+(\|[\s\-:]+)+\|$/.test(line.trim());
}

function adaptMarkdownForFeishu(content: string): string {
  // Phase 1: Convert unsupported markdown syntax to Feishu-compatible equivalents.
  // Feishu card markdown only supports: **bold**, *italic*, ~~strikethrough~~, [links](url).
  // Convert fenced code blocks to indented plain text
  let md = content.replace(/```[\s\S]*?```/g, (block) => {
    const inner = block.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
    return inner.split("\n").map((line) => "  " + line).join("\n");
  });
  // Strip inline code backticks
  md = md.replace(/`([^`]+)`/g, "$1");
  // Convert headers to bold
  md = md.replace(/^(#{1,6})\s+(.+)$/gm, "**$2**");
  // Convert unordered list markers to bullet character
  md = md.replace(/^[ \t]*[-*+]\s+/gm, "• ");
  // Strip blockquote markers
  md = md.replace(/^>\s?/gm, "");
  // Convert horizontal rules
  md = md.replace(/^[-*_]{3,}$/gm, "────────────");
  // Convert images to links
  md = md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "[$1]($2)");

  // Phase 2: Convert wide tables to list format.
  const lines = md.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Detect table: header row + separator row + at least one data row
    if (
      i + 2 < lines.length &&
      lines[i].trim().startsWith("|") &&
      isSeparatorRow(lines[i + 1]) &&
      lines[i + 2].trim().startsWith("|")
    ) {
      const headers = parseTableRow(lines[i]);
      i += 2; // skip header + separator

      // Collect data rows
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }

      // Convert all tables to list format (Feishu markdown doesn't support table syntax)
      for (let r = 0; r < rows.length; r++) {
        const cells = rows[r];
        // First column as bold title
        const title = cells[0] || "-";
        result.push(`**${title}**`);

        // Remaining columns as key-value pairs, ~3 per line
        const pairs: string[] = [];
        for (let c = 1; c < headers.length; c++) {
          const val = cells[c] || "";
          if (val && val !== "-") {
            pairs.push(`${headers[c]}: ${val}`);
          }
        }

        // Group pairs into lines of ~3
        for (let p = 0; p < pairs.length; p += 3) {
          result.push(pairs.slice(p, p + 3).join(" | "));
        }

        if (r < rows.length - 1) result.push(""); // blank line between rows
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}
