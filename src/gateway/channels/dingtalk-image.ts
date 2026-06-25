/**
 * DingTalk image reply delivery (Phase 1, mechanism "B").
 *
 * Mirrors how Lark replies with images (`lark-image.ts` → separate image
 * message) rather than inlining into markdown: agent-produced image artifacts
 * are uploaded to DingTalk's media server (`dingtalk-api.ts` → media_id) and
 * then sent as standalone robot messages via the DingTalk OpenAPI:
 *
 *   - 1:1 chat  → POST /v1.0/robot/oToMessages/batchSend  (userIds)
 *   - group     → POST /v1.0/robot/groupMessages/send     (openConversationId)
 *
 * Both use the `sampleImageMsg` template with `photoURL` set to the uploaded
 * media_id. Unlike the markdown reply (which goes over the temporary
 * `sessionWebhook`), these calls are authenticated with an access token and
 * require the robot message-send permission plus `robotCode` (= the app's
 * ClientID / AppKey).
 *
 * Security: same trust boundary as `dingtalk-api.ts` — these calls run in the
 * trusted Runtime process against pinned DingTalk OpenAPI hosts, and the bytes
 * come from the agent's structured image blocks, not agent-authored URLs.
 *
 * Every function degrades gracefully (returns false / logs) instead of
 * throwing, so a failed image never breaks the primary text/markdown reply.
 */

import type { DingTalkChannelConfig } from "./dingtalk.js";
import type { RenderedReplyImage } from "./visual-image.js";
import { getAccessToken, uploadImageMedia, fetchWithTimeout, redactSecrets } from "./dingtalk-api.js";

const ROBOT_OTO_URL = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
const ROBOT_GROUP_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";

/** Where an image reply should be delivered, derived from the inbound frame. */
export interface DingTalkImageTarget {
  routeType: "user" | "group";
  /** Group chats: the inbound `conversationId` doubles as the openConversationId. */
  openConversationId?: string;
  /** 1:1 chats: the sender's staff id (only the sender can receive the reply). */
  senderStaffId?: string;
}

/**
 * Send one already-uploaded image (`mediaId`) to the conversation via the robot
 * OpenAPI. Returns true on success. `getToken` is injectable for testing.
 */
export async function sendImageMessage(
  config: DingTalkChannelConfig,
  target: DingTalkImageTarget,
  mediaId: string,
  getToken: (config: DingTalkChannelConfig) => Promise<string | null> = getAccessToken,
): Promise<boolean> {
  const isGroup = target.routeType === "group";
  if (isGroup && !target.openConversationId) {
    console.error("[dingtalk-image] group image reply missing openConversationId");
    return false;
  }
  if (!isGroup && !target.senderStaffId) {
    console.error("[dingtalk-image] 1:1 image reply missing senderStaffId");
    return false;
  }

  const token = await getToken(config);
  if (!token) return false;

  const payload: Record<string, unknown> = {
    robotCode: config.client_id,
    msgKey: "sampleImageMsg",
    msgParam: JSON.stringify({ photoURL: mediaId }),
  };
  if (isGroup) {
    payload.openConversationId = target.openConversationId;
  } else {
    payload.userIds = [target.senderStaffId];
  }

  const url = isGroup ? ROBOT_GROUP_URL : ROBOT_OTO_URL;
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[dingtalk-image] image send failed: HTTP ${res.status}`);
      return false;
    }
    // Success responses carry a processQueryKey; business errors carry code/message.
    const data = (await res.json().catch(() => ({}))) as { processQueryKey?: string; code?: string; message?: string };
    if (data.code) {
      console.error(`[dingtalk-image] image send rejected: code=${data.code} message=${data.message ?? ""}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[dingtalk-image] image send error: ${redactSecrets(msg)}`);
    return false;
  }
}

/**
 * Upload and deliver all collected reply images, in order. Best-effort: each
 * image is independent, and any failure is logged without aborting the rest or
 * the primary text reply. Returns the count successfully delivered.
 */
export async function deliverImages(
  config: DingTalkChannelConfig,
  target: DingTalkImageTarget,
  images: RenderedReplyImage[],
): Promise<number> {
  let delivered = 0;
  for (const { image, mimeType } of images) {
    const mediaId = await uploadImageMedia(config, image, mimeType);
    if (!mediaId) continue;
    if (await sendImageMessage(config, target, mediaId)) delivered += 1;
  }
  return delivered;
}
