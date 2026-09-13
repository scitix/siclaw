import { describe, it, expect } from "vitest";
import {
  extractUsageFields,
  findUsageInBody,
  instrumentFetchForUsage,
  readRequestCacheFacts,
} from "./raw-usage-observer.js";

const sse = (...events: unknown[]): string =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

const streamOf = (body: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream({
    start(controller) {
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("extractUsageFields", () => {
  it("records only keys the server actually sent", () => {
    const observation = extractUsageFields({ input_tokens: 17 });
    expect(observation.outcome).toBe("reported");
    expect(observation.reported_fields).toEqual(["input"]);
    expect(observation.values).toEqual({ input: 17 });
    // The decisive property: unreported fields are ABSENT, not zero.
    expect(observation.values.output).toBeUndefined();
    expect(observation.values.reasoning).toBeUndefined();
  });

  it("keeps an explicitly reported zero", () => {
    const observation = extractUsageFields({
      input_tokens: 500,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 0 },
    });
    expect(observation.reported_fields.sort()).toEqual(["cache_read", "input", "output"]);
    expect(observation.values.cache_read).toBe(0);
  });

  it("reads the nested Responses shape", () => {
    const observation = extractUsageFields({
      input_tokens: 1_000,
      output_tokens: 300,
      input_tokens_details: { cached_tokens: 800 },
      output_tokens_details: { reasoning_tokens: 120 },
    });
    expect(observation.values).toEqual({ input: 1_000, output: 300, cache_read: 800, reasoning: 120 });
  });

  it("reads the flat Anthropic shape", () => {
    const observation = extractUsageFields({
      input_tokens: 50,
      output_tokens: 10,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 40,
    });
    expect(observation.values.cache_read).toBe(900);
    expect(observation.values.cache_write).toBe(40);
  });

  it("reports no_usage — not failure — for a payload carrying none", () => {
    expect(extractUsageFields({}).outcome).toBe("no_usage");
    expect(extractUsageFields(undefined).outcome).toBe("no_usage");
    expect(extractUsageFields({ input_tokens: "17" }).outcome).toBe("no_usage");
  });
});

describe("findUsageInBody", () => {
  it("reads usage from a plain JSON response", () => {
    expect(findUsageInBody(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 6 } })).values)
      .toEqual({ input: 5, output: 6 });
  });

  it("reads usage from the terminal SSE event", () => {
    const body = sse(
      { type: "response.created", response: {} },
      { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 3 } } },
    );
    expect(findUsageInBody(body).values).toEqual({ input: 9, output: 3 });
  });

  it("MERGES Anthropic's split usage instead of letting the last event win", () => {
    // message_start carries input + both cache figures; message_delta carries
    // only the running output. Replacing wholesale threw input and cache away.
    const body = sse(
      { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200 } } },
      { type: "content_block_delta", delta: { text: "hi" } },
      { type: "message_delta", usage: { output_tokens: 20 } },
    );
    const observation = findUsageInBody(body);
    expect(observation.outcome).toBe("reported");
    expect(observation.values).toEqual({ input: 100, cache_read: 1_000, cache_write: 200, output: 20 });
  });

  it("lets a later cumulative value win for the same field", () => {
    const body = sse(
      { type: "message_delta", usage: { output_tokens: 5 } },
      { type: "message_delta", usage: { output_tokens: 42 } },
    );
    expect(findUsageInBody(body).values.output).toBe(42);
  });

  it("distinguishes a readable stream with no usage from an unreadable body", () => {
    // Read it, found none → a positive finding.
    expect(findUsageInBody(sse({ type: "response.output_text.delta", delta: "hi" })).outcome).toBe("no_usage");
    // Could not parse anything → we do not know.
    expect(findUsageInBody("<html>502 Bad Gateway</html>").outcome).toBe("failed");
    expect(findUsageInBody("{not json").outcome).toBe("failed");
  });

  it("parses a legitimately multi-line data frame", () => {
    // SSE joins several `data:` lines within ONE frame into a single document.
    // Splitting per line turned this valid event into unparseable fragments.
    const body = 'data: {"type":"response.completed",\ndata: "response":{"usage":{"input_tokens":8}}}\n\n';
    const observation = findUsageInBody(body);
    expect(observation.outcome).toBe("reported");
    expect(observation.values.input).toBe(8);
  });

  it("does not call a partially unreadable stream `no_usage`", () => {
    // A valid opening event followed by a broken one: part of the stream is
    // unaccounted for, so we cannot assert the provider reported nothing.
    const body = 'data: {"type":"response.created","response":{}}\n\ndata: {"type":"response.compl\n\n';
    expect(findUsageInBody(body).outcome).toBe("failed");
  });

  it("keeps usage seen before a broken frame, but does NOT call the read complete", () => {
    // Protocols that send running totals (Anthropic) make an early snapshot
    // indistinguishable from the final figure, so a broken later frame means we
    // may be holding a partial count. Keep it as evidence; refuse to bank it.
    const body =
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":4}}}\n\ndata: {"brok\n\n';
    const observation = findUsageInBody(body);
    expect(observation.outcome).toBe("failed");
    expect(observation.values.input).toBe(4);   // preserved as evidence
  });

  it("does not call a stream complete when its final cumulative frame broke", () => {
    // Anthropic's shape: opening totals arrive, the closing usage frame is cut.
    const body =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n' +
      'data: {"type":"message_delta","usage":{"output_toke\n\n';
    const observation = findUsageInBody(body);
    expect(observation.outcome).toBe("failed");
    expect(observation.values.input).toBe(100);
  });

  it("ignores comment and event-only frames without calling them failures", () => {
    const body = ': keep-alive\n\nevent: ping\n\ndata: {"usage":{"input_tokens":2}}\n\ndata: [DONE]\n\n';
    expect(findUsageInBody(body)).toMatchObject({ outcome: "reported", values: { input: 2 } });
  });

  it("does not call a stream complete when it ends without a terminal marker", () => {
    // pi reports this as a missing message_stop. The opening usage object looks
    // complete on its own, which is exactly why the marker has to be checked.
    const body =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0}}}\n\n' +
      'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n';
    const observation = findUsageInBody(body);
    expect(observation.outcome).toBe("failed");
    expect(observation.values.input).toBe(100);   // kept as evidence
  });

  it("accepts a stream closed by its protocol's terminal event", () => {
    const body =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100}}}\n\n' +
      'data: {"type":"message_delta","usage":{"output_tokens":20}}\n\n' +
      'data: {"type":"message_stop"}\n\n';
    expect(findUsageInBody(body)).toMatchObject({ outcome: "reported", values: { input: 100, output: 20 } });
  });

  it("survives a truncated trailing event", () => {
    const body = `data: {"type":"response.completed","response":{"usage":{"input_tokens":7}}}\n\ndata: {"trunca`;
    expect(findUsageInBody(body).values).toEqual({ input: 7 });
  });
});

describe("readRequestCacheFacts", () => {
  it("reads the key and each retention shape as actually sent", () => {
    expect(readRequestCacheFacts(JSON.stringify({ prompt_cache_key: "k", prompt_cache_retention: "24h" })))
      .toEqual({ prompt_cache_key: "k", cache_retention_sent: "24h" });
    expect(readRequestCacheFacts(JSON.stringify({ prompt_cache_options: { ttl: "30m" } })))
      .toEqual({ prompt_cache_key: null, cache_retention_sent: "ttl_30m" });
    // pi's default `short` sends neither field — null, having looked.
    expect(readRequestCacheFacts(JSON.stringify({ model: "gpt-5" })))
      .toEqual({ prompt_cache_key: null, cache_retention_sent: null });
  });

  it("returns undefined when there was no body to inspect", () => {
    expect(readRequestCacheFacts(undefined)).toBeUndefined();
    expect(readRequestCacheFacts("{not json")).toBeUndefined();
  });
});

describe("instrumentFetchForUsage", () => {
  it("passes the body through byte-exact while observing usage", async () => {
    const body = sse({ type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 2 } } });
    let seen: any;
    const wrapped = instrumentFetchForUsage(
      async () => new Response(streamOf(body), { status: 200, headers: { "content-type": "text/event-stream" } }),
      (o) => { seen = o; },
    );

    const response = await wrapped("https://example.invalid/v1/responses");
    expect(await response.text()).toBe(body);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await settle();
    expect(seen).toMatchObject({ outcome: "reported", values: { input: 11, output: 2 } });
  });

  it("does not corrupt multi-byte characters split across chunks", async () => {
    const body = `data: {"type":"response.completed","response":{"usage":{"input_tokens":3},"text":"排障中文——测试"}}\n\n`;
    const wrapped = instrumentFetchForUsage(async () => new Response(streamOf(body), { status: 200 }), () => {});
    expect(await (await wrapped("https://example.invalid")).text()).toBe(body);
  });

  it("composes on top of a caller-supplied fetch instead of replacing it", async () => {
    let calledBase = false;
    const wrapped = instrumentFetchForUsage(
      async () => { calledBase = true; return new Response(JSON.stringify({ usage: { input_tokens: 1 } })); },
      () => {},
    );
    await wrapped("https://example.invalid");
    expect(calledBase).toBe(true);
  });

  it("reports no_usage for a readable stream that carries none", async () => {
    let seen: any;
    const wrapped = instrumentFetchForUsage(
      async () => new Response(streamOf(sse({ type: "response.output_text.delta", delta: "x" })), { status: 200 }),
      (o) => { seen = o; },
    );
    await (await wrapped("https://example.invalid")).text();
    await settle();
    expect(seen.outcome).toBe("no_usage");
  });

  it("never lets an observer error escape into the call", async () => {
    const wrapped = instrumentFetchForUsage(
      async () => new Response(JSON.stringify({ usage: { input_tokens: 1 } })),
      () => { throw new Error("sink exploded"); },
    );
    const response = await wrapped("https://example.invalid");
    await expect(response.text()).resolves.toContain("input_tokens");
  });

  it("observes EVERY attempt made through the SAME wrapper", async () => {
    // The real retry path: pi retries inside one logical call, reusing the fetch
    // it was given. A wrapper-level latch silently dropped attempt 2 onwards.
    const observations: any[] = [];
    const attempts: number[] = [];
    let n = 0;
    const wrapped = instrumentFetchForUsage(
      async () => {
        n += 1;
        return n === 1
          ? new Response("upstream unavailable", { status: 503 })
          : new Response(JSON.stringify({ usage: { input_tokens: 77 } }), { status: 200 });
      },
      (o) => { observations.push(o); },
      () => { attempts.push(1); },
    );

    await (await wrapped("https://example.invalid")).text();   // 503
    await (await wrapped("https://example.invalid")).text();   // 200
    await settle();

    expect(attempts).toHaveLength(2);
    expect(observations).toHaveLength(2);
    // The successful retry's numbers must survive, not be masked by the 503.
    expect(observations[1]).toMatchObject({ outcome: "reported", values: { input: 77 } });
  });

  it("counts an attempt even when the transport throws", async () => {
    const attempts: number[] = [];
    const observations: any[] = [];
    const wrapped = instrumentFetchForUsage(
      async () => { throw new Error("ECONNRESET"); },
      (o) => { observations.push(o); },
      () => { attempts.push(1); },
    );
    await expect(wrapped("https://example.invalid")).rejects.toThrow("ECONNRESET");
    expect(attempts).toHaveLength(1);
    expect(observations[0].outcome).toBe("failed");
  });

  it("carries request bytes and cache facts from the outgoing body", async () => {
    let seen: any;
    const body = JSON.stringify({ model: "gpt-5", prompt_cache_key: "sess-1", prompt_cache_retention: "24h" });
    const wrapped = instrumentFetchForUsage(
      async () => new Response(JSON.stringify({ usage: { input_tokens: 1 } })),
      (o) => { seen = o; },
    );
    await (await wrapped("https://example.invalid", { method: "POST", body })).text();
    await settle();

    expect(seen.request_bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(seen.request_cache).toEqual({ prompt_cache_key: "sess-1", cache_retention_sent: "24h" });
  });
});
