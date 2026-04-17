import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEmbeddingProvider, vectorToBlob, blobToVector } from "./embeddings.js";

describe("vectorToBlob / blobToVector", () => {
  it("round-trips a simple vector losslessly (Float32 precision)", () => {
    const vec = [0.1, 0.2, -0.5, 3.14, -2.71];
    const blob = vectorToBlob(vec);
    const restored = blobToVector(blob);
    expect(restored.length).toBe(vec.length);
    for (let i = 0; i < vec.length; i++) {
      expect(restored[i]).toBeCloseTo(vec[i], 5);
    }
  });

  it("round-trips an empty vector", () => {
    const blob = vectorToBlob([]);
    expect(blob.length).toBe(0);
    expect(blobToVector(blob)).toEqual([]);
  });

  it("round-trips zero vector", () => {
    const vec = [0, 0, 0, 0];
    const restored = blobToVector(vectorToBlob(vec));
    expect(restored).toEqual(vec);
  });

  it("returns a Buffer from vectorToBlob", () => {
    const blob = vectorToBlob([1, 2, 3]);
    expect(Buffer.isBuffer(blob)).toBe(true);
    // Float32 -> 4 bytes per element
    expect(blob.length).toBe(12);
  });
});

describe("createEmbeddingProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns dimensions, model defaults when not overridden", () => {
    const p = createEmbeddingProvider();
    expect(p.dimensions).toBe(1024);
    expect(p.model).toBe("BAAI/bge-m3");
    expect(p.maxInputTokens).toBe(8192);
  });

  it("honors custom dimensions, model, maxInputTokens", () => {
    const p = createEmbeddingProvider({ dimensions: 512, model: "x", maxInputTokens: 1024 });
    expect(p.dimensions).toBe(512);
    expect(p.model).toBe("x");
    expect(p.maxInputTokens).toBe(1024);
  });

  it("returns [] when texts is empty", async () => {
    const p = createEmbeddingProvider({ baseUrl: "http://fake" });
    expect(await p.embed([])).toEqual([]);
  });

  it("returns [] when baseUrl is unset (no network call)", async () => {
    const p = createEmbeddingProvider();
    // Ensure no fetch is made
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await p.embed(["hello"])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls fetch with Bearer auth when apiKey given", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ data: [{ embedding: [1, 2, 3], index: 0 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const p = createEmbeddingProvider({ baseUrl: "http://fake", apiKey: "SECRET", dimensions: 3 });
    const result = await p.embed(["hi"]);
    expect(result).toEqual([[1, 2, 3]]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("http://fake/embeddings");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer SECRET");
  });

  it("omits Authorization header when apiKey not given", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.5], index: 0 }] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const p = createEmbeddingProvider({ baseUrl: "http://fake" });
    await p.embed(["x"]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("strips trailing slashes from baseUrl", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0], index: 0 }] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const p = createEmbeddingProvider({ baseUrl: "http://fake//" });
    await p.embed(["x"]);
    expect(fetchMock.mock.calls[0][0]).toBe("http://fake/embeddings");
  });

  it("preserves input order by sorting response data by index", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { embedding: [3, 3, 3], index: 2 },
            { embedding: [1, 1, 1], index: 0 },
            { embedding: [2, 2, 2], index: 1 },
          ],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const p = createEmbeddingProvider({ baseUrl: "http://fake" });
    const result = await p.embed(["a", "b", "c"]);
    expect(result).toEqual([[1, 1, 1], [2, 2, 2], [3, 3, 3]]);
  });

  it("sanitizes non-finite values to 0 in returned embeddings", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ embedding: [1, Number.NaN, Number.POSITIVE_INFINITY, 2], index: 0 }] }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const p = createEmbeddingProvider({ baseUrl: "http://fake" });
    const [vec] = await p.embed(["x"]);
    expect(vec).toEqual([1, 0, 0, 2]);
  });

  it("does not retry on 4xx errors (except 429)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("bad request", { status: 400 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const p = createEmbeddingProvider({ baseUrl: "http://fake" });
    await expect(p.embed(["x"])).rejects.toThrow(/API error 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("truncates oversized texts to fit maxInputTokens", async () => {
    let capturedBody: any = null;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ data: capturedBody.input.map((_: string, i: number) => ({ embedding: [0], index: i })) }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // 1 token ≈ 4 bytes. maxInputTokens=10 => cap ~40 bytes
    const p = createEmbeddingProvider({ baseUrl: "http://fake", maxInputTokens: 10 });
    const big = "a".repeat(1000);
    await p.embed([big]);
    expect(capturedBody.input[0].length).toBeLessThanOrEqual(40);
    expect(capturedBody.input[0].length).toBeGreaterThan(0);
  });

  it("splits many short texts into multiple batches (respects BATCH_MAX_ITEMS)", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ data: body.input.map((_: string, i: number) => ({ embedding: [i], index: i })) }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const p = createEmbeddingProvider({ baseUrl: "http://fake" });
    // 150 tiny texts should trigger at least 2 batches (cap is 100 items per batch)
    const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
    const out = await p.embed(texts);
    expect(out.length).toBe(150);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
