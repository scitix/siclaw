import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import {
  assertAllowedImageUrl,
  enrichImagesFromText,
  extractImageUrls,
  redactImageUrlsInText,
  sniffImageMime,
  type InboundImage,
} from "./image-url-ingest.js";

// ── Fixtures: minimal valid image byte signatures ──────────────────────────
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
]);
const NOT_IMAGE = Buffer.from("hello world this is text", "utf8");

function imageResponse(buf: Buffer, contentType = "image/png", extraHeaders: Record<string, string> = {}) {
  const headers = new Headers({ "content-type": contentType, ...extraHeaders });
  return {
    ok: true,
    status: 200,
    headers,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  } as unknown as Response;
}

const ENV_KEYS = [
  "SICLAW_IMAGE_URL_ALLOWLIST",
  "SICLAW_IMAGE_URL_ALLOW_HTTP",
  "SICLAW_IMAGE_URL_FETCH_TIMEOUT_MS",
  "SICLAW_IMAGE_URL_TOTAL_TIMEOUT_MS",
];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── sniffImageMime ──────────────────────────────────────────────────────────
describe("sniffImageMime", () => {
  it("recognises png / jpeg / webp by magic bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });
  it("returns null for non-image bytes", () => {
    expect(sniffImageMime(NOT_IMAGE)).toBeNull();
    expect(sniffImageMime(Buffer.from([0x01, 0x02]))).toBeNull();
  });
});

// ── extractImageUrls ────────────────────────────────────────────────────────
describe("extractImageUrls", () => {
  it("extracts image URLs incl. OSS signed (ext before query)", () => {
    const text = "see https://oss.siflow.cn/a/b.jpg?OSSAccessKeyId=x&Signature=y here";
    expect(extractImageUrls(text)).toEqual(["https://oss.siflow.cn/a/b.jpg?OSSAccessKeyId=x&Signature=y"]);
  });
  it("dedups repeats and matches png/jpeg/webp", () => {
    const url = "https://oss.siflow.cn/x.png";
    expect(extractImageUrls(`${url} ${url}`)).toEqual([url]);
    expect(extractImageUrls("https://h.cn/a.webp https://h.cn/b.jpeg")).toHaveLength(2);
  });
  it("ignores non-image and extensionless URLs", () => {
    expect(extractImageUrls("https://h.cn/page.html https://h.cn/raw")).toEqual([]);
    expect(extractImageUrls("")).toEqual([]);
  });
});

// ── assertAllowedImageUrl (SSRF guard) ──────────────────────────────────────
describe("assertAllowedImageUrl", () => {
  it("is fail-closed when no allowlist configured", () => {
    expect(() => assertAllowedImageUrl("https://oss.siflow.cn/a.jpg")).toThrow(/fail-closed/);
  });
  it("allows exact and wildcard allowlist hosts", () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "oss.siflow.cn, *.example.com";
    expect(() => assertAllowedImageUrl("https://oss.siflow.cn/a.jpg")).not.toThrow();
    expect(() => assertAllowedImageUrl("https://img.example.com/a.jpg")).not.toThrow();
  });
  it("rejects hosts outside the allowlist", () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    expect(() => assertAllowedImageUrl("https://evil.com/a.jpg")).toThrow(/not in allowlist/);
    // apex is not a subdomain of *.siflow.cn
    expect(() => assertAllowedImageUrl("https://siflow.cn/a.jpg")).toThrow(/not in allowlist/);
  });
  it("rejects http by default, allows it only when opted in", () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "oss.siflow.cn";
    expect(() => assertAllowedImageUrl("http://oss.siflow.cn/a.jpg")).toThrow(/protocol/);
    process.env.SICLAW_IMAGE_URL_ALLOW_HTTP = "true";
    expect(() => assertAllowedImageUrl("http://oss.siflow.cn/a.jpg")).not.toThrow();
  });
  it("rejects private/metadata hosts (not on allowlist)", () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    expect(() => assertAllowedImageUrl("https://169.254.169.254/latest/meta-data")).toThrow(/not in allowlist/);
    expect(() => assertAllowedImageUrl("https://127.0.0.1/a.jpg")).toThrow(/not in allowlist/);
  });
});

// ── enrichImagesFromText (text image URLs) ─────────────────────────────────
describe("enrichImagesFromText", () => {
  it("returns existing untouched when text has no image URL", async () => {
    const existing: InboundImage[] = [{ mimeType: "image/png", data: "AAAA" }];
    const out = await enrichImagesFromText("plain text, no urls", existing);
    expect(out).toEqual(existing);
    expect(out).not.toBe(existing); // new array
  });

  it("fetches an allowlisted url image", async () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(PNG, "image/png")));
    const out = await enrichImagesFromText("look https://oss.siflow.cn/a.png", []);
    expect(out).toEqual([{ mimeType: "image/png", data: PNG.toString("base64") }]);
  });

  it("skips a url rejected by the SSRF guard (no allowlist)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await enrichImagesFromText("https://oss.siflow.cn/a.png", []);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled(); // guard throws before fetch
  });

  it("skips a non-image content-type", async () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(NOT_IMAGE, "text/html")));
    const out = await enrichImagesFromText("https://oss.siflow.cn/a.png", []);
    expect(out).toEqual([]);
  });

  it("skips an oversize image (declared content-length)", async () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse(PNG, "image/png", { "content-length": String(50 * 1024 * 1024) })),
    );
    const out = await enrichImagesFromText("https://oss.siflow.cn/a.png", []);
    expect(out).toEqual([]);
  });

  it("skips an oversize url image even with no/lying content-length (streamed)", async () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    const huge = Buffer.alloc(7 * 1024 * 1024, 0x89); // > 6MiB raw cap
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/png" }), // no content-length
        body: Readable.from([huge]),
      }) as unknown as Response),
    );
    const out = await enrichImagesFromText("https://oss.siflow.cn/a.png", []);
    expect(out).toEqual([]);
  });

  it("re-validates the allowlist on redirect (rejects off-allowlist hop)", async () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    const fetchMock = vi.fn(async () => ({
      status: 302,
      ok: false,
      headers: new Headers({ location: "https://evil.com/a.png" }),
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const out = await enrichImagesFromText("https://oss.siflow.cn/a.png", []);
    expect(out).toEqual([]); // off-allowlist redirect target rejected on next hop
  });

  it("appends url images AFTER existing, sharing the 4-image budget", async () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(JPEG, "image/jpeg")));
    const existing: InboundImage[] = [{ mimeType: "image/png", data: PNG.toString("base64") }];
    const out = await enrichImagesFromText("https://oss.siflow.cn/a.jpeg", existing);
    expect(out.map((i) => i.mimeType)).toEqual(["image/png", "image/jpeg"]);
  });

  it("does not exceed 4 images when existing already fills the budget", async () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    const fetchMock = vi.fn(async () => imageResponse(JPEG, "image/jpeg"));
    vi.stubGlobal("fetch", fetchMock);
    const existing: InboundImage[] = Array.from({ length: 4 }, () => ({ mimeType: "image/png", data: "x" }));
    const out = await enrichImagesFromText("https://oss.siflow.cn/a.jpeg", existing);
    expect(out).toHaveLength(4);
    expect(fetchMock).not.toHaveBeenCalled(); // budget full → never fetches
  });

  it("bounds the whole step by a total timeout and fetches in parallel (hanging host doesn't stall)", async () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    process.env.SICLAW_IMAGE_URL_TOTAL_TIMEOUT_MS = "100";
    // fetch that honours the abort signal but otherwise never resolves
    const fetchMock = vi.fn((_url: any, init: any) => new Promise((_res, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const start = Date.now();
    const out = await enrichImagesFromText("https://oss.siflow.cn/a.png https://oss.siflow.cn/b.png", []);
    expect(out).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // both fired in parallel, not gated one-by-one
    // bounded by the ~100ms total budget, NOT 2×(per-hop 5s) run sequentially
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("bounds the parallel fan-out to the media budget (does not fetch every URL)", async () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    const fetchMock = vi.fn(async () => imageResponse(PNG));
    vi.stubGlobal("fetch", fetchMock);
    const manyUrls = Array.from({ length: 50 }, (_, i) => `https://oss.siflow.cn/img${i}.png`).join(" ");
    const out = await enrichImagesFromText(manyUrls, []);
    expect(out).toHaveLength(4); // capped at MAX_INBOUND_IMAGES
    expect(fetchMock).toHaveBeenCalledTimes(4); // only 4 fetches fired, not 50 — bounded BEFORE fan-out
  });

  it("bounds the fan-out by the remaining budget when existing images are present", async () => {
    process.env.SICLAW_IMAGE_URL_ALLOWLIST = "*.siflow.cn";
    const fetchMock = vi.fn(async () => imageResponse(PNG));
    vi.stubGlobal("fetch", fetchMock);
    const existing: InboundImage[] = [{ mimeType: "image/png", data: "x" }, { mimeType: "image/png", data: "y" }];
    const out = await enrichImagesFromText("https://oss.siflow.cn/a.png https://oss.siflow.cn/b.png https://oss.siflow.cn/c.png", existing);
    expect(out).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 4 - 2 existing = 2 slots → only 2 fetches
  });
});

describe("redactImageUrlsInText", () => {
  it("strips signed-URL query (Signature/AccessKeyId) but keeps host+path", () => {
    expect(
      redactImageUrlsInText("see https://oss.siflow.cn/a.jpg?Signature=secret&AccessKeyId=key here"),
    ).toBe("see https://oss.siflow.cn/a.jpg here");
  });
  it("redacts multiple image URLs and leaves other text intact", () => {
    expect(
      redactImageUrlsInText("a https://h.cn/x.png?s=1 b https://h.cn/y.webp?t=2"),
    ).toBe("a https://h.cn/x.png b https://h.cn/y.webp");
  });
  it("leaves non-image / extensionless URLs and empty text untouched", () => {
    expect(redactImageUrlsInText("hello https://h.cn/page")).toBe("hello https://h.cn/page");
    expect(redactImageUrlsInText("")).toBe("");
  });
});
