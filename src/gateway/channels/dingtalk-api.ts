/**
 * DingTalk OpenAPI helpers shared by the channel handler.
 *
 * Phase 1 scope: an access-token cache plus image media upload, which together
 * let the handler turn an agent-produced image (a binary artifact, NOT an
 * agent-authored URL) into a DingTalk `media_id`. That `media_id` is then
 * embedded into the `sessionWebhook` markdown reply (`![alt](media_id)`) the
 * same way the upstream `@soimy/dingtalk` plugin's `sendBySession` does.
 *
 * Security note: every call here runs in the trusted Runtime process (inside
 * the cluster), never in the agent sandbox. We only ever talk to the pinned
 * DingTalk OpenAPI hosts (`api.dingtalk.com` for the token, `oapi.dingtalk.com`
 * for media upload). The bytes we upload come from the agent's structured image
 * blocks collected by `collectChannelResponse`, so this path does not reopen
 * the prompt-injection / data-exfiltration hole that markdown image-stripping
 * closes — arbitrary agent-authored image URLs are still stripped.
 */

import type { DingTalkChannelConfig } from "./dingtalk.js";

/** DingTalk OpenAPI endpoints (pinned — do not accept these from frame data). */
const TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const MEDIA_UPLOAD_URL = "https://oapi.dingtalk.com/media/upload";

/** DingTalk hard limit for image media uploads. */
const IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** Network timeout for OpenAPI calls (token + upload). */
const OPENAPI_TIMEOUT_MS = 10_000;

/** Supported outbound image MIME types and the filename extension we tag them with. */
const IMAGE_MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

interface TokenCacheEntry {
  accessToken: string;
  /** Epoch ms at which the cached token should be considered stale. */
  expiresAt: number;
}

/**
 * Access-token cache keyed by clientId so multiple DingTalk channels (each a
 * distinct app) keep independent tokens. In-memory only: a Runtime restart
 * simply re-fetches on first use.
 */
const tokenCache = new Map<string, TokenCacheEntry>();

/** Test-only helper to clear the token cache between cases. */
export function resetDingTalkTokenCacheForTest(): void {
  tokenCache.clear();
}

/**
 * Redact secrets from any string before it reaches a log collector. The token
 * endpoint takes the AppSecret in the request body and the upload endpoint puts
 * the access token in the query string, so a naive error dump could leak both.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/(appSecret|appsecret|access_token|accessToken)["=:\s]+[^"&\s,}]+/gi, "$1=***");
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = OPENAPI_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch (or return a cached) DingTalk access token for the given channel app.
 * Refreshes one minute before expiry to avoid near-boundary failures. Returns
 * `null` on any failure so callers degrade gracefully (text/markdown reply
 * without the image) rather than throwing into the message handler.
 */
export async function getAccessToken(
  config: DingTalkChannelConfig,
): Promise<string | null> {
  const cacheKey = config.client_id;
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.accessToken;
  }

  try {
    const res = await fetchWithTimeout(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey: config.client_id, appSecret: config.client_secret }),
    });
    if (!res.ok) {
      console.error(`[dingtalk-api] accessToken request failed: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { accessToken?: string; expireIn?: number };
    if (!data.accessToken || typeof data.accessToken !== "string") {
      console.error("[dingtalk-api] accessToken response missing accessToken");
      return null;
    }
    const expireInMs = (typeof data.expireIn === "number" ? data.expireIn : 7200) * 1000;
    tokenCache.set(cacheKey, { accessToken: data.accessToken, expiresAt: now + expireInMs });
    return data.accessToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[dingtalk-api] accessToken error: ${redactSecrets(msg)}`);
    return null;
  }
}

/**
 * Upload one image to DingTalk's media server and return its `media_id`.
 * Returns `null` on any failure (unsupported type, oversize, network/API
 * error) so the caller can fall back to a text-only reply.
 *
 * `getToken` is injectable for unit testing; it defaults to {@link getAccessToken}.
 */
export async function uploadImageMedia(
  config: DingTalkChannelConfig,
  image: Buffer,
  mimeType: string,
  getToken: (config: DingTalkChannelConfig) => Promise<string | null> = getAccessToken,
): Promise<string | null> {
  const ext = IMAGE_MIME_EXTENSION[mimeType.toLowerCase()];
  if (!ext) {
    console.error(`[dingtalk-api] unsupported image mime type for upload: ${mimeType}`);
    return null;
  }
  if (image.length === 0) {
    console.error("[dingtalk-api] refusing to upload empty image buffer");
    return null;
  }
  if (image.length > IMAGE_UPLOAD_MAX_BYTES) {
    const mb = (image.length / (1024 * 1024)).toFixed(2);
    console.error(`[dingtalk-api] image too large to upload: ${mb}MB exceeds 20MB`);
    return null;
  }

  const token = await getToken(config);
  if (!token) return null;

  try {
    const form = new FormData();
    form.append("media", new Blob([new Uint8Array(image)], { type: mimeType }), `image.${ext}`);

    const url = `${MEDIA_UPLOAD_URL}?access_token=${encodeURIComponent(token)}&type=image`;
    const res = await fetchWithTimeout(url, { method: "POST", body: form });
    if (!res.ok) {
      console.error(`[dingtalk-api] media upload failed: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { errcode?: number; media_id?: string; errmsg?: string };
    if (data.errcode === 0 && typeof data.media_id === "string" && data.media_id) {
      return data.media_id;
    }
    console.error(`[dingtalk-api] media upload rejected: errcode=${data.errcode} errmsg=${data.errmsg ?? ""}`);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[dingtalk-api] media upload error: ${redactSecrets(msg)}`);
    return null;
  }
}
