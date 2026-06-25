import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getAccessToken,
  uploadImageMedia,
  resetDingTalkTokenCacheForTest,
} from "./dingtalk-api.js";
import type { DingTalkChannelConfig } from "./dingtalk.js";

const config: DingTalkChannelConfig = { client_id: "app-key-1", client_secret: "app-secret-1" };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetDingTalkTokenCacheForTest();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getAccessToken", () => {
  it("fetches a token and caches it for subsequent calls", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accessToken: "tok-abc", expireIn: 7200 }));

    const first = await getAccessToken(config);
    const second = await getAccessToken(config);

    expect(first).toBe("tok-abc");
    expect(second).toBe("tok-abc");
    // Cached: only one network call for two getAccessToken invocations.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.dingtalk.com/v1.0/oauth2/accessToken");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      appKey: "app-key-1",
      appSecret: "app-secret-1",
    });
  });

  it("returns null on HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 401));
    expect(await getAccessToken(config)).toBeNull();
  });

  it("returns null when the response has no accessToken", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ expireIn: 7200 }));
    expect(await getAccessToken(config)).toBeNull();
  });

  it("returns null on network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await getAccessToken(config)).toBeNull();
  });
});

describe("uploadImageMedia", () => {
  // Plain function (not a vi.fn) so afterEach's restoreAllMocks can't wipe its
  // implementation between cases.
  const getToken = async () => "tok-xyz";

  it("uploads a PNG and returns its media_id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errcode: 0, media_id: "@media-123" }));

    const mediaId = await uploadImageMedia(config, Buffer.from([1, 2, 3]), "image/png", getToken);

    expect(mediaId).toBe("@media-123");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("https://oapi.dingtalk.com/media/upload");
    expect(url).toContain("type=image");
    expect(url).toContain("access_token=tok-xyz");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
  });

  it("rejects an unsupported mime type without calling the network", async () => {
    const mediaId = await uploadImageMedia(config, Buffer.from([1]), "image/gif", getToken);
    expect(mediaId).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty buffer without calling the network", async () => {
    const mediaId = await uploadImageMedia(config, Buffer.alloc(0), "image/png", getToken);
    expect(mediaId).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversize buffer without calling the network", async () => {
    const big = Buffer.alloc(20 * 1024 * 1024 + 1);
    const mediaId = await uploadImageMedia(config, big, "image/png", getToken);
    expect(mediaId).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when token resolution fails", async () => {
    const noToken = vi.fn().mockResolvedValue(null);
    const mediaId = await uploadImageMedia(config, Buffer.from([1]), "image/png", noToken);
    expect(mediaId).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when DingTalk rejects the upload (errcode != 0)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errcode: 40078, errmsg: "invalid media" }));
    const mediaId = await uploadImageMedia(config, Buffer.from([1]), "image/png", getToken);
    expect(mediaId).toBeNull();
  });
});
