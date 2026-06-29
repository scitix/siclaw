import type { Readable } from "node:stream";

/**
 * Prompt-text image URL ingestion — the SINGLE backend place that turns image
 * URLs found in a prompt's text into the `{ mimeType, data }` shape that
 * `PromptOptions.images` (AgentBox vision input) expects.
 *
 * Why it lives here, in the AgentBox client layer (not in each channel, not in
 * the AgentBox pod):
 *   - Every Gateway→AgentBox prompt funnels through `AgentBoxClient.prompt()`
 *     (Feishu directly; Portal Web chat / a2a / cron via the gateway `chat.send`
 *     RPC), so enriching here covers all front-ends with one implementation.
 *   - The outbound fetch + SSRF allowlist belong in the Gateway process, which
 *     already has an egress path. The AgentBox pod is network-isolated (only
 *     dials the Gateway over mTLS) — fetching arbitrary user URLs from inside it
 *     would breach that isolation and hand SSRF reach into the cluster.
 *
 * Native Lark images (the receive-side resource download) are channel-specific
 * and stay in `channels/inbound-image.ts`; they share the size/sniff helpers
 * below but cannot be generalised across front-ends.
 *
 * Whether to run this at all is a VISION decision made by the caller
 * (`AgentBoxClient`): only when the prompt's model/route can take image input do
 * we resolve URLs; otherwise the URL is left as plain text for the model to see.
 */

/** Same shape as AgentBox `PromptOptions.images[]` (base64, no `data:` prefix). */
export interface InboundImage {
  mimeType: string;
  data: string;
}

// AgentBox contract (src/agentbox/http-server.ts): MAX_PROMPT_MEDIA_ITEMS = 4
// (images + files share the budget), single item base64 ≤ 8MB, mime ∈
// {png,jpeg,webp}. Mirror the caps here to fail fast before hitting AgentBox.
export const MAX_INBOUND_IMAGES = 4;
// 6MiB raw → ≤8MiB base64, comfortably under AgentBox's 8MiB base64 item cap
// (so no separate base64-length check is needed anywhere downstream).
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
// Overall deadline for resolving ALL URLs in one prompt, so a slow-but-allowlisted
// host can't stall the turn (the per-fetch timeout alone bounds one hop, not the
// whole sequential/parallel batch).
const DEFAULT_TOTAL_TIMEOUT_MS = 8000;

// Extension-anchored: an OSS signed URL keeps its `.jpg` before the `?query`.
// Extensionless URLs are intentionally out of scope for v1 (no HEAD probe).
const IMAGE_URL_RE = /https?:\/\/[^\s<>"']+?\.(?:jpe?g|png|webp)(?:\?[^\s<>"']*)?/gi;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strip query for logging — a signed image URL may carry creds (Signature, AccessKeyId). */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

function fetchTimeoutMs(): number {
  const raw = process.env.SICLAW_IMAGE_URL_FETCH_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_FETCH_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_FETCH_TIMEOUT_MS;
}

function totalTimeoutMs(): number {
  const raw = process.env.SICLAW_IMAGE_URL_TOTAL_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TOTAL_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TOTAL_TIMEOUT_MS;
}

/**
 * Magic-byte sniff. The Content-Type from Lark/OSS is unreliable
 * (`application/octet-stream` is common), and AgentBox only accepts a strict
 * enum, so we derive the mime from the bytes and reject anything else.
 */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function imageUrlAllowlist(): string[] {
  const raw = process.env.SICLAW_IMAGE_URL_ALLOWLIST?.trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => {
    if (entry.startsWith("*.")) {
      // "*.siflow.cn" → any subdomain (mirrors dingtalk.ts isAllowedWebhookHost).
      return host.endsWith(entry.slice(1));
    }
    return host === entry;
  });
}

/**
 * SSRF guard for prompt-text image URLs. Aligns with `dingtalk.ts` (host
 * allowlist, no IP/CIDR logic): under undici's `fetch` the resolved IP is
 * neither exposed nor pinnable, so a DNS→IP netmask check is TOCTOU security
 * theatre. The allowlist is fail-closed — with no `SICLAW_IMAGE_URL_ALLOWLIST`
 * configured, every URL is rejected (text-URL ingestion disabled; native Lark
 * images unaffected). Throws on rejection.
 */
export function assertAllowedImageUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }
  const allowHttp = process.env.SICLAW_IMAGE_URL_ALLOW_HTTP === "true";
  const protoOk = parsed.protocol === "https:" || (allowHttp && parsed.protocol === "http:");
  if (!protoOk) throw new Error(`protocol not allowed: ${parsed.protocol}`);

  const allowlist = imageUrlAllowlist();
  if (allowlist.length === 0) {
    throw new Error("image URL allowlist not configured (fail-closed)");
  }
  const host = parsed.hostname.toLowerCase();
  if (!hostMatchesAllowlist(host, allowlist)) {
    throw new Error(`host not in allowlist: ${host}`);
  }
}

/** Extract dedup'd image URLs from prompt text. Exported for tests. */
export function extractImageUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(IMAGE_URL_RE) ?? [];
  return [...new Set(matches)];
}

/**
 * Strip the query (signed-URL creds like `Signature` / `AccessKeyId`) from any
 * image URL in the text, keeping host+path. Used before the text is persisted or
 * sent to the model — the fetch itself uses the full URL, so this never affects
 * resolution. Mirrors `safeUrl()` on the logging path.
 */
export function redactImageUrlsInText(text: string): string {
  if (!text) return text;
  return text.replace(IMAGE_URL_RE, (m) => safeUrl(m));
}

/** Aggregate a readable stream into a Buffer, aborting past `maxBytes`. */
export async function streamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error(`image exceeds ${maxBytes} bytes`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

async function readLimitedBody(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`image exceeds ${maxBytes} bytes (declared ${declared})`);
  }
  // Stream incrementally and abort on overflow — a missing/lying content-length
  // must not let an unbounded body buffer into memory (mirrors streamToBuffer).
  if (!res.body) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) throw new Error(`image exceeds ${maxBytes} bytes (actual ${ab.byteLength})`);
    return Buffer.from(ab);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const b = Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) {
      exceeded = true;
      break; // breaking the async-iterator cancels the underlying stream
    }
    chunks.push(b);
  }
  if (exceeded) throw new Error(`image exceeds ${maxBytes} bytes`);
  return Buffer.concat(chunks);
}

/**
 * Fetch an image URL behind the SSRF guard, following redirects manually.
 * `overallSignal` (optional) is the caller's batch-wide deadline, combined with
 * the per-hop timeout so one slow hop can't outlive the whole resolution budget.
 */
export async function fetchUrlImage(url: string, overallSignal?: AbortSignal): Promise<InboundImage> {
  const timeoutMs = fetchTimeoutMs();
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedImageUrl(current); // re-validate every hop (redirect can't escape the allowlist)
    const perHop = AbortSignal.timeout(timeoutMs);
    const signal = overallSignal ? AbortSignal.any([perHop, overallSignal]) : perHop;
    const res = await fetch(current, { redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`redirect without location: ${safeUrl(current)}`);
      // Drain the redirect body so undici releases the connection instead of
      // holding it until GC.
      await res.body?.cancel().catch(() => {});
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${safeUrl(current)}`);
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new Error(`non-image content-type: ${contentType || "(none)"}`);
    }
    const buf = await readLimitedBody(res, MAX_IMAGE_BYTES);
    const mime = sniffImageMime(buf);
    if (!mime) throw new Error(`unrecognized image bytes for ${safeUrl(current)}`);
    return { mimeType: mime, data: buf.toString("base64") };
  }
  throw new Error(`too many redirects: ${safeUrl(url)}`);
}

/**
 * Append images parsed from prompt-text URLs to any pre-existing images (e.g.
 * native Lark images a channel already downloaded). The combined total is
 * capped at the AgentBox media budget; a single URL failure (SSRF rejection,
 * timeout, oversize, non-image bytes) is skipped with a warning and never
 * aborts the turn. Returns the merged list (a new array; `existing` untouched).
 *
 * The caller decides WHETHER to call this (vision-capability gate); this only
 * decides WHICH URLs resolve.
 */
export async function enrichImagesFromText(
  text: string,
  existing: InboundImage[] = [],
): Promise<InboundImage[]> {
  const out: InboundImage[] = [...existing];
  const budget = MAX_INBOUND_IMAGES - out.length;
  if (budget <= 0) return out;
  // Bound the fan-out BEFORE firing requests: at most `budget` concurrent fetches,
  // not one per extracted URL. extractImageUrls dedups but does not cap count, so
  // a message with many URLs would otherwise open N outbound connections at once
  // (transient memory / DoS / SSRF amplification).
  const urls = extractImageUrls(text).slice(0, budget);
  if (urls.length === 0) return out;

  // One deadline for the whole step (a slow allowlisted host must not stall the
  // turn), and fetch the URLs in parallel rather than sequentially. The raw-byte
  // cap in fetchUrlImage (MAX_IMAGE_BYTES) already bounds each image's size.
  const overall = AbortSignal.timeout(totalTimeoutMs());
  const settled = await Promise.all(
    urls.map(async (url) => {
      try {
        return await fetchUrlImage(url, overall);
      } catch (err) {
        console.warn(`[image-url-ingest] url image failed url=${safeUrl(url)}: ${errMsg(err)}`);
        return null;
      }
    }),
  );
  for (const img of settled) if (img) out.push(img);
  return out;
}
