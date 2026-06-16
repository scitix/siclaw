import { describe, expect, it, vi } from "vitest";
import { replyImageToLark } from "./lark-image.js";

function makeLarkClient(uploadResponse: unknown = { image_key: "img-123" }) {
  return {
    im: {
      image: {
        create: vi.fn().mockResolvedValue(uploadResponse),
      },
      message: {
        reply: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe("replyImageToLark", () => {
  it("uploads a message image and replies with the returned image_key", async () => {
    const lark = makeLarkClient();
    const image = Buffer.from([1, 2, 3]);

    await expect(replyImageToLark(lark, "mid-1", image)).resolves.toBe(true);

    expect(lark.im.image.create).toHaveBeenCalledWith({
      data: {
        image_type: "message",
        image,
      },
    });
    expect(lark.im.message.reply).toHaveBeenCalledWith({
      path: { message_id: "mid-1" },
      data: {
        msg_type: "image",
        content: JSON.stringify({ image_key: "img-123" }),
      },
    });
  });

  it("accepts SDK responses where image_key is nested under data", async () => {
    const lark = makeLarkClient({ data: { image_key: "img-nested" } });

    await expect(replyImageToLark(lark, "mid-1", Buffer.from([1]))).resolves.toBe(true);

    const replyArg = lark.im.message.reply.mock.calls[0][0];
    expect(JSON.parse(replyArg.data.content)).toEqual({ image_key: "img-nested" });
  });

  it("falls back to the im.v1.image namespace when needed", async () => {
    const lark = {
      im: {
        v1: {
          image: {
            create: vi.fn().mockResolvedValue({ image_key: "img-v1" }),
          },
        },
        message: {
          reply: vi.fn().mockResolvedValue({}),
        },
      },
    };

    await expect(replyImageToLark(lark, "mid-1", Buffer.from([1]))).resolves.toBe(true);

    expect(lark.im.v1.image.create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lark.im.message.reply.mock.calls[0][0].data.content)).toEqual({ image_key: "img-v1" });
  });

  it("logs and returns false when upload returns no image_key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lark = makeLarkClient({});

    await expect(replyImageToLark(lark, "mid-1", Buffer.from([1]))).resolves.toBe(false);

    expect(lark.im.message.reply).not.toHaveBeenCalled();
  });

  it("logs and returns false on upload or reply failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lark = makeLarkClient();
    lark.im.image.create.mockRejectedValueOnce(new Error("forbidden"));

    await expect(replyImageToLark(lark, "mid-1", Buffer.from([1]))).resolves.toBe(false);
    expect(lark.im.message.reply).not.toHaveBeenCalled();
  });
});
