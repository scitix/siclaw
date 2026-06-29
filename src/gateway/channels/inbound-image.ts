import type { Readable } from "node:stream";
import {
  type InboundImage,
  MAX_INBOUND_IMAGES,
  MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGE_BYTES,
  sniffImageMime,
  streamToBuffer,
} from "../agentbox/image-url-ingest.js";

/**
 * Native Lark/Feishu image download — the channel-specific half of inbound
 * image handling.
 *
 * A native Lark image (or a post-embedded image) is downloaded via the
 * receive-side `im.messageResource.get` API (NOT `im.images`, which only serves
 * resources THIS app uploaded). This needs the Lark SDK + the message id, so it
 * cannot be generalised across front-ends and stays here.
 *
 * The OTHER inbound source — image URLs in the message text — is NOT handled
 * here. It is generic across every front-end and lives in
 * `agentbox/image-url-ingest.ts`, applied once at the `AgentBoxClient.prompt()`
 * boundary so Feishu, Portal Web chat, a2a and cron all share one implementation.
 */

export type { InboundImage } from "../agentbox/image-url-ingest.js";

/** Lightweight reference to a Lark-hosted image, resolved at download time. */
export interface LarkImageRef {
  imageKey: string;
}

export interface CollectInboundImagesOptions {
  /** Native Lark image refs already parsed from the message in the handler. */
  imageRefs: LarkImageRef[];
  /** Lazily-imported `@larksuiteoapi/node-sdk` client. */
  larkClient: any;
  /** Needed by the receive-side resource API. */
  messageId: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Download a Lark-hosted image via the receive-side resource API. */
async function fetchLarkResource(
  larkClient: any,
  messageId: string,
  imageKey: string,
): Promise<InboundImage> {
  const resourceApi = larkClient?.im?.messageResource ?? larkClient?.im?.v1?.messageResource;
  if (!resourceApi?.get) {
    throw new Error("im.messageResource.get is unavailable");
  }
  // MUST be the receive-side resource endpoint; `im.images.get` only serves
  // resources THIS app uploaded. file_key === the message's image_key.
  const resp = await resourceApi.get({
    path: { message_id: messageId, file_key: imageKey },
    params: { type: "image" },
  });
  const stream: Readable | undefined = resp?.getReadableStream?.();
  if (!stream) {
    throw new Error("messageResource.get returned no readable stream");
  }
  const buf = await streamToBuffer(stream, MAX_IMAGE_BYTES);
  const mime = sniffImageMime(buf);
  if (!mime) throw new Error(`unrecognized image bytes for image_key=${imageKey}`);
  return { mimeType: mime, data: buf.toString("base64") };
}

/**
 * Collect native Lark images for one Feishu turn. The total is capped at the
 * AgentBox media budget; a single failure (bad key, oversize, non-image bytes)
 * is skipped with a warning and never aborts the turn. Text image URLs are
 * appended later, generically, at the `AgentBoxClient.prompt()` boundary.
 */
export async function collectInboundImages(
  opts: CollectInboundImagesOptions,
): Promise<InboundImage[]> {
  const { imageRefs, larkClient, messageId } = opts;
  const out: InboundImage[] = [];

  for (const ref of imageRefs) {
    if (out.length >= MAX_INBOUND_IMAGES) break;
    try {
      const img = await fetchLarkResource(larkClient, messageId, ref.imageKey);
      if (img.data.length > MAX_IMAGE_BASE64_CHARS) {
        console.warn(`[lark-inbound-image] skip oversize image (image_key=${ref.imageKey}): ${img.data.length} base64 chars`);
        continue;
      }
      out.push(img);
    } catch (err) {
      console.warn(`[lark-inbound-image] lark resource failed image_key=${ref.imageKey}: ${errMsg(err)}`);
    }
  }

  return out;
}
