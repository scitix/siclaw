import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { collectInboundImages } from "./inbound-image.js";

// Native-Lark image download. The text-URL path and the shared byte helpers
// moved to `agentbox/image-url-ingest.ts` — see image-url-ingest.test.ts.

// ── Fixtures: minimal valid image byte signatures ──────────────────────────
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const NOT_IMAGE = Buffer.from("hello world this is text", "utf8");

function makeLarkClient(getImpl: (payload: any) => any) {
  return { im: { messageResource: { get: vi.fn(getImpl) } } };
}

function resourceResponse(buf: Buffer) {
  return { getReadableStream: () => Readable.from([buf]), writeFile: vi.fn(), headers: {} };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collectInboundImages — native lark images", () => {
  it("downloads a lark image and returns {mimeType,data}", async () => {
    const larkClient = makeLarkClient(() => resourceResponse(PNG));
    const out = await collectInboundImages({
      imageRefs: [{ imageKey: "img_k1" }],
      larkClient,
      messageId: "m1",
    });
    expect(out).toEqual([{ mimeType: "image/png", data: PNG.toString("base64") }]);
    expect(larkClient.im.messageResource.get).toHaveBeenCalledWith({
      path: { message_id: "m1", file_key: "img_k1" },
      params: { type: "image" },
    });
  });

  it("falls back to im.v1.messageResource", async () => {
    const get = vi.fn(() => resourceResponse(JPEG));
    const larkClient = { im: { v1: { messageResource: { get } } } };
    const out = await collectInboundImages({ imageRefs: [{ imageKey: "k" }], larkClient, messageId: "m" });
    expect(out).toEqual([{ mimeType: "image/jpeg", data: JPEG.toString("base64") }]);
  });

  it("skips a bad image_key but keeps the rest", async () => {
    const larkClient = makeLarkClient((p: any) =>
      p.path.file_key === "bad" ? Promise.reject(new Error("boom")) : resourceResponse(PNG),
    );
    const out = await collectInboundImages({
      imageRefs: [{ imageKey: "bad" }, { imageKey: "good" }],
      larkClient,
      messageId: "m",
    });
    expect(out).toHaveLength(1);
    expect(out[0].mimeType).toBe("image/png");
  });

  it("skips non-image bytes from a lark resource", async () => {
    const larkClient = makeLarkClient(() => resourceResponse(NOT_IMAGE));
    const out = await collectInboundImages({ imageRefs: [{ imageKey: "k" }], larkClient, messageId: "m" });
    expect(out).toEqual([]);
  });

  it("caps total images at 4", async () => {
    const larkClient = makeLarkClient(() => resourceResponse(PNG));
    const refs = Array.from({ length: 6 }, (_, i) => ({ imageKey: `k${i}` }));
    const out = await collectInboundImages({ imageRefs: refs, larkClient, messageId: "m" });
    expect(out).toHaveLength(4);
  });

  it("skips an oversize lark image (stream exceeds the byte cap)", async () => {
    // 7MiB > 6MiB raw cap → streamToBuffer aborts mid-stream.
    const huge = Buffer.alloc(7 * 1024 * 1024, 0x89);
    const larkClient = makeLarkClient(() => resourceResponse(huge));
    const out = await collectInboundImages({ imageRefs: [{ imageKey: "big" }], larkClient, messageId: "m" });
    expect(out).toEqual([]);
  });
});
