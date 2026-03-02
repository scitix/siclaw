import crypto from "node:crypto";
import type {
  ChannelPlugin,
  StreamingCard,
  MarkdownData,
  LinkData,
  ActionCardData,
} from "../plugins/api.js";
import type {
  ChannelBridge,
  ImageInput,
  FileInput,
  AudioInput,
  VideoInput,
  LocationInput,
  MediaInputs,
} from "../plugins/channel-bridge.js";
import type { GatewayConfig, ChannelConfig } from "../config.js";
import type { ChannelDeps } from "./channel-manager.js";
import { splitMessage } from "./utils.js";

interface DingTalkConfig extends ChannelConfig {
  clientId: string; // AppKey
  clientSecret: string; // AppSecret
}

export function createDingTalkChannel(
  config: GatewayConfig,
  channelBridge: ChannelBridge,
  deps?: ChannelDeps,
): ChannelPlugin {
  const dingtalkConfig = config.channels.dingtalk as DingTalkConfig | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let streamClient: any = null;

  // Access token management
  let accessToken = "";
  let tokenExpiresAt = 0;

  // Track conversation metadata for reply routing (group vs single chat)
  const chatMeta = new Map<string, { type: string; userId: string }>();

  async function ensureAccessToken(): Promise<string> {
    if (accessToken && Date.now() < tokenExpiresAt) {
      return accessToken;
    }

    if (!dingtalkConfig?.clientId || !dingtalkConfig?.clientSecret) {
      throw new Error("DingTalk clientId/clientSecret not configured");
    }

    const resp = await fetch(
      `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(dingtalkConfig.clientId)}&appsecret=${encodeURIComponent(dingtalkConfig.clientSecret)}`,
    );
    const data = (await resp.json()) as {
      access_token: string;
      expires_in: number;
      errcode?: number;
      errmsg?: string;
    };

    if (data.errcode && data.errcode !== 0) {
      throw new Error(`DingTalk token error: ${data.errmsg}`);
    }

    accessToken = data.access_token;
    // Refresh 200s before expiry
    tokenExpiresAt = Date.now() + (data.expires_in - 200) * 1000;
    return accessToken;
  }

  const plugin: ChannelPlugin = {
    name: "dingtalk",

    gateway: {
      async startAccount() {
        if (
          !dingtalkConfig?.enabled ||
          !dingtalkConfig?.clientId ||
          !dingtalkConfig?.clientSecret
        ) {
          console.log("[dingtalk] Channel disabled or missing clientId/clientSecret");
          return;
        }

        try {
          // dingtalk-stream-sdk-nodejs is CJS — handle default export
          const mod = await import("dingtalk-stream-sdk-nodejs");
          const sdk = (mod as any).default ?? mod;
          const DWClient = sdk.DWClient;
          const DWClientDownStream = sdk.DWClientDownStream;

          streamClient = new DWClient({
            clientId: dingtalkConfig.clientId,
            clientSecret: dingtalkConfig.clientSecret,
          });

          // Helper to download media (image or file) from DingTalk
          async function downloadMedia(
            downloadCode: string,
          ): Promise<{ data: string; mimeType: string } | null> {
            try {
              const token = await ensureAccessToken();
              const resp = await fetch(
                "https://api.dingtalk.com/v1.0/robot/messageFiles/download",
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "x-acs-dingtalk-access-token": token,
                  },
                  body: JSON.stringify({
                    downloadCode,
                    robotCode: dingtalkConfig!.clientId,
                  }),
                },
              );

              if (!resp.ok) {
                console.error("[dingtalk] Failed to get download URL:", await resp.text());
                return null;
              }

              const result = (await resp.json()) as { downloadUrl?: string };
              if (!result.downloadUrl) {
                console.error("[dingtalk] No downloadUrl in response");
                return null;
              }

              // Download the actual file
              const mediaResp = await fetch(result.downloadUrl);
              if (!mediaResp.ok) {
                console.error("[dingtalk] Failed to download media");
                return null;
              }

              const arrayBuffer = await mediaResp.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              const contentType = mediaResp.headers.get("content-type") || "application/octet-stream";

              return {
                data: buffer.toString("base64"),
                mimeType: contentType,
              };
            } catch (err) {
              console.error("[dingtalk] Error downloading media:", err);
              return null;
            }
          }

          streamClient.registerCallbackListener(
            "/v1.0/im/bot/messages/get",
            async (res: any) => {
              try {
                const data = JSON.parse(res.data);
                const {
                  conversationId,
                  conversationType, // "1" = single, "2" = group
                  senderStaffId,
                  chatbotUserId,
                  atUsers,
                  msgtype,
                } = data;

                if (!conversationId) {
                  return { status: DWClientDownStream.SUCCESS, message: "OK" };
                }

                // Track conversation metadata for reply routing
                chatMeta.set(conversationId, {
                  type: conversationType,
                  userId: senderStaffId,
                });

                // Group: only respond when bot is mentioned
                if (conversationType === "2") {
                  const botMentioned = Array.isArray(atUsers)
                    ? atUsers.some((u: any) => u.dingtalkId === chatbotUserId)
                    : false;
                  if (!botMentioned) {
                    return { status: DWClientDownStream.SUCCESS, message: "OK" };
                  }
                }

                let text = "";
                const images: ImageInput[] = [];
                const files: FileInput[] = [];
                const audios: AudioInput[] = [];
                const videos: VideoInput[] = [];
                let location: LocationInput | undefined;

                if (msgtype === "text" || !msgtype) {
                  // Text message
                  text = data.text?.content ?? "";
                  // Strip @mentions from text
                  text = text.replace(/@\S+/g, "").trim();
                } else if (msgtype === "picture") {
                  // Image message
                  const downloadCode = data.content?.downloadCode;
                  if (downloadCode) {
                    const media = await downloadMedia(downloadCode);
                    if (media) {
                      images.push({
                        data: media.data,
                        mimeType: media.mimeType,
                      });
                      text = "[User sent an image]";
                    }
                  }
                } else if (msgtype === "file") {
                  // File message
                  const downloadCode = data.content?.downloadCode;
                  const fileName = data.content?.fileName ?? "unknown";
                  if (downloadCode) {
                    const media = await downloadMedia(downloadCode);
                    if (media) {
                      files.push({
                        data: media.data,
                        mimeType: media.mimeType,
                        filename: fileName,
                      });
                      text = `[User sent a file: ${fileName}]`;
                    }
                  }
                } else if (msgtype === "audio") {
                  // Audio/voice message
                  const downloadCode = data.content?.downloadCode;
                  const duration = data.content?.duration;
                  if (downloadCode) {
                    const media = await downloadMedia(downloadCode);
                    if (media) {
                      audios.push({
                        data: media.data,
                        mimeType: media.mimeType || "audio/amr",
                        duration,
                      });
                      text = `[User sent a voice message ${duration ? `(${Math.round(duration / 1000)}s)` : ""}]`;
                    }
                  }
                } else if (msgtype === "video") {
                  // Video message
                  const downloadCode = data.content?.downloadCode;
                  const duration = data.content?.duration;
                  if (downloadCode) {
                    const media = await downloadMedia(downloadCode);
                    if (media) {
                      videos.push({
                        data: media.data,
                        mimeType: media.mimeType || "video/mp4",
                        duration,
                      });
                      text = `[User sent a video ${duration ? `(${Math.round(duration / 1000)}s)` : ""}]`;
                    }
                  }
                } else if (msgtype === "location") {
                  // Location message
                  const loc = data.content;
                  if (loc) {
                    location = {
                      latitude: parseFloat(loc.latitude) || 0,
                      longitude: parseFloat(loc.longitude) || 0,
                      name: loc.title,
                      address: loc.address,
                    };
                    text = `[User shared a location: ${loc.title || loc.address || "Unknown location"}]`;
                  }
                } else if (msgtype === "richText") {
                  // Rich text may contain text, images, and files
                  const richText = data.content?.richText;
                  if (Array.isArray(richText)) {
                    for (const item of richText) {
                      if (item.text) {
                        text += item.text;
                      }
                      if (item.downloadCode) {
                        const media = await downloadMedia(item.downloadCode);
                        if (media) {
                          // Determine type based on mime type
                          if (media.mimeType.startsWith("image/")) {
                            images.push({
                              data: media.data,
                              mimeType: media.mimeType,
                            });
                          } else if (media.mimeType.startsWith("audio/")) {
                            audios.push({
                              data: media.data,
                              mimeType: media.mimeType,
                            });
                          } else if (media.mimeType.startsWith("video/")) {
                            videos.push({
                              data: media.data,
                              mimeType: media.mimeType,
                            });
                          } else {
                            files.push({
                              data: media.data,
                              mimeType: media.mimeType,
                              filename: item.fileName ?? "unknown",
                            });
                          }
                        }
                      }
                    }
                    text = text.replace(/@\S+/g, "").trim();
                    if (!text && (images.length > 0 || files.length > 0 || audios.length > 0 || videos.length > 0)) {
                      text = "[User sent media files]";
                    }
                  }
                } else {
                  // Unsupported message type - log and skip
                  console.log(`[dingtalk] Unsupported message type: ${msgtype}`);
                  return { status: DWClientDownStream.SUCCESS, message: "OK" };
                }

                if (!text && images.length === 0 && files.length === 0 && audios.length === 0 && videos.length === 0 && !location) {
                  return { status: DWClientDownStream.SUCCESS, message: "OK" };
                }

                // Intercept bind commands: /bind xxx
                const bindMatch = text.match(/^\/(?:bind)\s+(\d{6})$/);
                if (bindMatch && deps) {
                  const code = bindMatch[1];
                  const userId = deps.bindCodeStore.verifyCode(code);
                  if (userId) {
                    try {
                      deps.userStore.addBinding(userId, "dingtalk", senderStaffId);
                      const user = deps.userStore.getById(userId);
                      await plugin.outbound?.sendText?.({
                        to: conversationId,
                        text: `Binding successful! Linked to user "${user?.username ?? userId}". Future messages will be routed to this account.`,
                      });
                    } catch (err) {
                      await plugin.outbound?.sendText?.({
                        to: conversationId,
                        text: `Binding failed: ${err instanceof Error ? err.message : "Unknown error"}`,
                      });
                    }
                  } else {
                    await plugin.outbound?.sendText?.({
                      to: conversationId,
                      text: "Invalid or expired code. Please generate a new one from the web UI.",
                    });
                  }
                  return { status: DWClientDownStream.SUCCESS, message: "OK" };
                }

                const media: MediaInputs | undefined =
                  images.length > 0 || files.length > 0 || audios.length > 0 || videos.length > 0 || location
                    ? {
                        images: images.length > 0 ? images : undefined,
                        files: files.length > 0 ? files : undefined,
                        audios: audios.length > 0 ? audios : undefined,
                        videos: videos.length > 0 ? videos : undefined,
                        location,
                      }
                    : undefined;

                await channelBridge.handleInbound(
                  "dingtalk",
                  conversationId,
                  senderStaffId,
                  text,
                  media,
                );
              } catch (err) {
                console.error("[dingtalk] Error handling message:", err);
              }
              return { status: DWClientDownStream.SUCCESS, message: "OK" };
            },
          );

          await streamClient.connect();
          console.log("[dingtalk] Channel started (Stream mode)");
        } catch (err) {
          console.error("[dingtalk] Failed to start:", err);
        }
      },

      async stopAccount() {
        if (streamClient) {
          try {
            streamClient.disconnect();
          } catch {
            /* ignore */
          }
          streamClient = null;
          accessToken = "";
          tokenExpiresAt = 0;
          chatMeta.clear();
          console.log("[dingtalk] Channel stopped");
        }
      },
    },

    outbound: {
      async sendText({ to, text }) {
        if (!dingtalkConfig?.clientId) return;

        try {
          const token = await ensureAccessToken();
          const meta = chatMeta.get(to);
          const chunks = splitMessage(text, 1900);

          for (let i = 0; i < chunks.length; i++) {
            const msgBody = {
              msgParam: JSON.stringify({ content: chunks[i] }),
              msgKey: "sampleText",
              robotCode: dingtalkConfig.clientId,
            };

            if (meta?.type === "1") {
              // Single chat: send to user via OTO API
              await fetch(
                "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "x-acs-dingtalk-access-token": token,
                  },
                  body: JSON.stringify({
                    ...msgBody,
                    userIds: [meta.userId],
                  }),
                },
              );
            } else {
              // Group chat (default)
              await fetch(
                "https://api.dingtalk.com/v1.0/robot/groupMessages/send",
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "x-acs-dingtalk-access-token": token,
                  },
                  body: JSON.stringify({
                    ...msgBody,
                    openConversationId: to,
                  }),
                },
              );
            }

            if (i < chunks.length - 1) {
              await new Promise((r) => setTimeout(r, 100));
            }
          }
        } catch (err) {
          console.error(`[dingtalk] Failed to send to ${to}:`, err);
        }
      },

      async sendImageData({ to, image }) {
        if (!dingtalkConfig?.clientId) return;

        try {
          const token = await ensureAccessToken();
          const meta = chatMeta.get(to);

          // Upload image to get mediaId
          const buffer = Buffer.from(image.data, "base64");
          const formData = new FormData();
          formData.append("type", "image");
          formData.append(
            "media",
            new Blob([buffer], { type: image.mimeType }),
            image.filename ?? "image.png",
          );

          const uploadResp = await fetch(
            `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=image`,
            {
              method: "POST",
              body: formData,
            },
          );

          const uploadResult = (await uploadResp.json()) as {
            media_id?: string;
            errcode?: number;
            errmsg?: string;
          };

          if (uploadResult.errcode && uploadResult.errcode !== 0) {
            throw new Error(`Upload failed: ${uploadResult.errmsg}`);
          }

          const mediaId = uploadResult.media_id;
          if (!mediaId) {
            throw new Error("No media_id in upload response");
          }

          // Send image message
          const msgBody = {
            msgParam: JSON.stringify({ photoURL: `@lAD${mediaId}` }),
            msgKey: "sampleImageMsg",
            robotCode: dingtalkConfig.clientId,
          };

          if (meta?.type === "1") {
            await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                userIds: [meta.userId],
              }),
            });
          } else {
            await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                openConversationId: to,
              }),
            });
          }
        } catch (err) {
          console.error(`[dingtalk] Failed to send image to ${to}:`, err);
        }
      },

      async sendFile({ to, file }) {
        if (!dingtalkConfig?.clientId) return;

        try {
          const token = await ensureAccessToken();
          const meta = chatMeta.get(to);

          // Upload file to get mediaId
          const buffer = Buffer.from(file.data, "base64");
          const formData = new FormData();
          formData.append("type", "file");
          formData.append(
            "media",
            new Blob([buffer], { type: file.mimeType }),
            file.filename,
          );

          const uploadResp = await fetch(
            `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=file`,
            {
              method: "POST",
              body: formData,
            },
          );

          const uploadResult = (await uploadResp.json()) as {
            media_id?: string;
            errcode?: number;
            errmsg?: string;
          };

          if (uploadResult.errcode && uploadResult.errcode !== 0) {
            throw new Error(`Upload failed: ${uploadResult.errmsg}`);
          }

          const mediaId = uploadResult.media_id;
          if (!mediaId) {
            throw new Error("No media_id in upload response");
          }

          // Send file message
          const msgBody = {
            msgParam: JSON.stringify({
              mediaId,
              fileName: file.filename,
              fileType: file.mimeType.split("/")[1] || "unknown",
            }),
            msgKey: "sampleFile",
            robotCode: dingtalkConfig.clientId,
          };

          if (meta?.type === "1") {
            await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                userIds: [meta.userId],
              }),
            });
          } else {
            await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                openConversationId: to,
              }),
            });
          }
        } catch (err) {
          console.error(`[dingtalk] Failed to send file to ${to}:`, err);
        }
      },

      async sendMarkdown({ to, markdown, atUsers, atAll }) {
        if (!dingtalkConfig?.clientId) return;

        try {
          const token = await ensureAccessToken();
          const meta = chatMeta.get(to);

          // Build @ mentions for markdown
          let atText = "";
          if (atAll) {
            atText = "@All ";
          } else if (atUsers && atUsers.length > 0) {
            atText = atUsers.map((u) => `@${u}`).join(" ") + " ";
          }

          const msgBody = {
            msgParam: JSON.stringify({
              title: markdown.title ?? "Message",
              text: atText + markdown.content,
            }),
            msgKey: "sampleMarkdown",
            robotCode: dingtalkConfig.clientId,
          };

          if (meta?.type === "1") {
            await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                userIds: [meta.userId],
              }),
            });
          } else {
            await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                openConversationId: to,
              }),
            });
          }
        } catch (err) {
          console.error(`[dingtalk] Failed to send markdown to ${to}:`, err);
        }
      },

      async sendLink({ to, link }) {
        if (!dingtalkConfig?.clientId) return;

        try {
          const token = await ensureAccessToken();
          const meta = chatMeta.get(to);

          const msgBody = {
            msgParam: JSON.stringify({
              title: link.title,
              text: link.text ?? "",
              messageUrl: link.url,
              picUrl: link.picUrl ?? "",
            }),
            msgKey: "sampleLink",
            robotCode: dingtalkConfig.clientId,
          };

          if (meta?.type === "1") {
            await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                userIds: [meta.userId],
              }),
            });
          } else {
            await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                openConversationId: to,
              }),
            });
          }
        } catch (err) {
          console.error(`[dingtalk] Failed to send link to ${to}:`, err);
        }
      },

      async sendActionCard({ to, card }) {
        if (!dingtalkConfig?.clientId) return;

        try {
          const token = await ensureAccessToken();
          const meta = chatMeta.get(to);

          let msgKey: string;
          let msgParam: Record<string, unknown>;

          if (card.singleTitle && card.singleUrl) {
            // Single button action card
            msgKey = "sampleActionCard";
            msgParam = {
              title: card.title,
              text: card.text,
              singleTitle: card.singleTitle,
              singleURL: card.singleUrl,
            };
          } else if (card.buttons && card.buttons.length > 0) {
            // Multi-button action card
            const btnCount = Math.min(card.buttons.length, 5);
            msgKey = `sampleActionCard${btnCount > 1 ? btnCount : ""}`;
            msgParam = {
              title: card.title,
              text: card.text,
              btnOrientation: card.btnOrientation ?? "0",
            };
            // Add buttons dynamically
            card.buttons.slice(0, 5).forEach((btn, i) => {
              const idx = i + 1;
              msgParam[`actionTitle${idx}`] = btn.title;
              msgParam[`actionURL${idx}`] = btn.actionUrl ?? "";
            });
          } else {
            // Fallback to simple markdown
            return this.sendMarkdown?.({ to, markdown: { title: card.title, content: card.text } });
          }

          const msgBody = {
            msgParam: JSON.stringify(msgParam),
            msgKey,
            robotCode: dingtalkConfig.clientId,
          };

          if (meta?.type === "1") {
            await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                userIds: [meta.userId],
              }),
            });
          } else {
            await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                openConversationId: to,
              }),
            });
          }
        } catch (err) {
          console.error(`[dingtalk] Failed to send action card to ${to}:`, err);
        }
      },

      async sendAudio({ to, audio }) {
        if (!dingtalkConfig?.clientId) return;

        try {
          const token = await ensureAccessToken();
          const meta = chatMeta.get(to);

          // Upload audio
          const buffer = Buffer.from(audio.data, "base64");
          const formData = new FormData();
          formData.append("type", "voice");
          formData.append(
            "media",
            new Blob([buffer], { type: audio.mimeType }),
            audio.filename ?? "audio.amr",
          );

          const uploadResp = await fetch(
            `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=voice`,
            {
              method: "POST",
              body: formData,
            },
          );

          const uploadResult = (await uploadResp.json()) as {
            media_id?: string;
            errcode?: number;
            errmsg?: string;
          };

          if (uploadResult.errcode && uploadResult.errcode !== 0) {
            throw new Error(`Upload failed: ${uploadResult.errmsg}`);
          }

          const mediaId = uploadResult.media_id;
          if (!mediaId) {
            throw new Error("No media_id in upload response");
          }

          const msgBody = {
            msgParam: JSON.stringify({
              mediaId,
              duration: audio.duration ? String(Math.round(audio.duration * 1000)) : "0",
            }),
            msgKey: "sampleAudio",
            robotCode: dingtalkConfig.clientId,
          };

          if (meta?.type === "1") {
            await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                userIds: [meta.userId],
              }),
            });
          } else {
            await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                openConversationId: to,
              }),
            });
          }
        } catch (err) {
          console.error(`[dingtalk] Failed to send audio to ${to}:`, err);
        }
      },

      async sendVideo({ to, video }) {
        if (!dingtalkConfig?.clientId) return;

        try {
          const token = await ensureAccessToken();
          const meta = chatMeta.get(to);

          // Upload video
          const buffer = Buffer.from(video.data, "base64");
          const formData = new FormData();
          formData.append("type", "video");
          formData.append(
            "media",
            new Blob([buffer], { type: video.mimeType }),
            video.filename ?? "video.mp4",
          );

          const uploadResp = await fetch(
            `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=video`,
            {
              method: "POST",
              body: formData,
            },
          );

          const uploadResult = (await uploadResp.json()) as {
            media_id?: string;
            errcode?: number;
            errmsg?: string;
          };

          if (uploadResult.errcode && uploadResult.errcode !== 0) {
            throw new Error(`Upload failed: ${uploadResult.errmsg}`);
          }

          const mediaId = uploadResult.media_id;
          if (!mediaId) {
            throw new Error("No media_id in upload response");
          }

          const msgBody = {
            msgParam: JSON.stringify({
              mediaId,
              duration: video.duration ? String(Math.round(video.duration * 1000)) : "0",
              videoType: "mp4",
            }),
            msgKey: "sampleVideo",
            robotCode: dingtalkConfig.clientId,
          };

          if (meta?.type === "1") {
            await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                userIds: [meta.userId],
              }),
            });
          } else {
            await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": token,
              },
              body: JSON.stringify({
                ...msgBody,
                openConversationId: to,
              }),
            });
          }
        } catch (err) {
          console.error(`[dingtalk] Failed to send video to ${to}:`, err);
        }
      },
    },

    streaming: {
      async createCard({ to, title }): Promise<StreamingCard> {
        if (!dingtalkConfig?.clientId) {
          throw new Error("DingTalk client not initialized");
        }

        const token = await ensureAccessToken();
        const outTrackId = crypto.randomUUID();
        const meta = chatMeta.get(to);

        // Default AI card template for streaming
        const cardTemplateId = "382e4302-551d-4880-bf29-a30acfab2e71.schema";

        const body: Record<string, unknown> = {
          cardTemplateId,
          outTrackId,
          callbackType: "STREAM",
          cardData: {
            cardParamMap: {
              content: "...",
              title: title ?? "AI Response",
            },
          },
        };

        if (meta?.type === "1") {
          // Single chat
          body.imRobotOpenSpaceModel = { supportForward: true };
          body.imRobotOpenDeliverModel = {
            spaceType: "IM_ROBOT",
            robotCode: dingtalkConfig.clientId,
          };
        } else {
          // Group chat
          body.imGroupOpenSpaceModel = { supportForward: true };
          body.imGroupOpenDeliverModel = {
            robotCode: dingtalkConfig.clientId,
            openConversationId: to,
          };
        }

        const resp = await fetch(
          "https://api.dingtalk.com/v1.0/card/instances/createAndDeliver",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-acs-dingtalk-access-token": token,
            },
            body: JSON.stringify(body),
          },
        );

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(`Failed to create DingTalk card: ${JSON.stringify(errData)}`);
        }

        return { cardId: outTrackId, conversationId: to };
      },

      async updateCard({ card, content }): Promise<void> {
        if (!dingtalkConfig?.clientId) return;

        const token = await ensureAccessToken();

        await fetch("https://api.dingtalk.com/v1.0/card/streaming", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-acs-dingtalk-access-token": token,
          },
          body: JSON.stringify({
            outTrackId: card.cardId,
            key: "content",
            content: content || "...",
            isFinished: false,
            isError: false,
          }),
        });
      },

      async finalizeCard({ card, content }): Promise<void> {
        if (!dingtalkConfig?.clientId) return;

        const token = await ensureAccessToken();

        await fetch("https://api.dingtalk.com/v1.0/card/streaming", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-acs-dingtalk-access-token": token,
          },
          body: JSON.stringify({
            outTrackId: card.cardId,
            key: "content",
            content: content || "",
            isFinished: true,
            isError: false,
          }),
        });
      },
    },
  };

  return plugin;
}
