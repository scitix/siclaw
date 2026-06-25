import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Keep the real fetchWithTimeout/redactSecrets, but control token + upload.
const getAccessTokenMock = vi.fn();
const uploadImageMediaMock = vi.fn();

vi.mock("./dingtalk-api.js", async () => {
  const actual = await vi.importActual<typeof import("./dingtalk-api.js")>("./dingtalk-api.js");
  return {
    ...actual,
    getAccessToken: (...args: unknown[]) => getAccessTokenMock(...args),
    uploadImageMedia: (...args: unknown[]) => uploadImageMediaMock(...args),
  };
});

import { sendImageMessage, deliverImages } from "./dingtalk-image.js";
import type { DingTalkChannelConfig } from "./dingtalk.js";
import type { RenderedReplyImage } from "./visual-image.js";

const config: DingTalkChannelConfig = { client_id: "robot-1", client_secret: "sec" };

function okResponse(body: unknown = { processQueryKey: "q-1" }): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  getAccessTokenMock.mockReset().mockResolvedValue("tok-1");
  uploadImageMediaMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendImageMessage", () => {
  const token = async () => "tok-1";

  it("sends a 1:1 image via oToMessages/batchSend with userIds + sampleImageMsg", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());

    const ok = await sendImageMessage(
      config,
      { routeType: "user", senderStaffId: "staff-42" },
      "@media-1",
      token,
    );

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.robotCode).toBe("robot-1");
    expect(body.userIds).toEqual(["staff-42"]);
    expect(body.msgKey).toBe("sampleImageMsg");
    expect(JSON.parse(body.msgParam)).toEqual({ photoURL: "@media-1" });
    expect((init as RequestInit).headers).toMatchObject({ "x-acs-dingtalk-access-token": "tok-1" });
  });

  it("sends a group image via groupMessages/send with openConversationId", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());

    const ok = await sendImageMessage(
      config,
      { routeType: "group", openConversationId: "cidGROUP" },
      "@media-2",
      token,
    );

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.dingtalk.com/v1.0/robot/groupMessages/send");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.openConversationId).toBe("cidGROUP");
    expect(body.userIds).toBeUndefined();
  });

  it("returns false when a 1:1 reply has no senderStaffId (no network call)", async () => {
    const ok = await sendImageMessage(config, { routeType: "user" }, "@media-3", token);
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false when a group reply has no openConversationId (no network call)", async () => {
    const ok = await sendImageMessage(config, { routeType: "group" }, "@media-4", token);
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false when token resolution fails", async () => {
    const ok = await sendImageMessage(
      config,
      { routeType: "group", openConversationId: "cidGROUP" },
      "@media-5",
      async () => null,
    );
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false on HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const ok = await sendImageMessage(config, { routeType: "group", openConversationId: "c" }, "@m", token);
    expect(ok).toBe(false);
  });

  it("returns false on a business error payload (code present)", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ code: "Forbidden", message: "no permission" }));
    const ok = await sendImageMessage(config, { routeType: "group", openConversationId: "c" }, "@m", token);
    expect(ok).toBe(false);
  });
});

describe("deliverImages", () => {
  const images: RenderedReplyImage[] = [
    { kind: "image", mimeType: "image/png", image: Buffer.from([1]) },
    { kind: "image", mimeType: "image/png", image: Buffer.from([2]) },
  ];

  it("uploads and sends each image, returning the delivered count", async () => {
    uploadImageMediaMock.mockResolvedValueOnce("@m-1").mockResolvedValueOnce("@m-2");
    fetchMock.mockResolvedValue(okResponse());

    const count = await deliverImages(config, { routeType: "group", openConversationId: "cidG" }, images);

    expect(count).toBe(2);
    expect(uploadImageMediaMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips an image whose upload fails but still delivers the rest", async () => {
    uploadImageMediaMock.mockResolvedValueOnce(null).mockResolvedValueOnce("@m-2");
    fetchMock.mockResolvedValue(okResponse());

    const count = await deliverImages(config, { routeType: "group", openConversationId: "cidG" }, images);

    expect(count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
