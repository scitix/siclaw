import { describe, expect, it, vi } from "vitest";
import {
  buildProbeRequest,
  isFieldRejection,
  probeModelOnce,
  redactSecret,
  siblingMaxTokensField,
  testModelWireConfig,
  usesAnthropicMessages,
  type FetchLike,
  type ProbeTarget,
} from "./model-probe.js";


function target(over: Partial<ProbeTarget> = {}): ProbeTarget {
  return {
    modelId: "gpt-5",
    baseUrl: "https://api.example.com/model-api",
    apiKey: "sk-secret-key-value",
    apiType: "openai-completions",
    maxTokensField: null,
    ...over,
  };
}

function reply(status: number, body = "{}"): Response {
  return new Response(body, { status });
}

/**
 * Answers a scripted sequence of statuses and records the [protocol, field] of
 * every attempt — inferred from the request itself, so the assertions describe
 * what actually went on the wire rather than what we passed in.
 */
function scriptedFetch(statuses: number[], body = '{"error":"nope"}') {
  const calls: Array<[string, string]> = [];
  let call = 0;
  const impl: FetchLike = async (url, init) => {
    const parsed = JSON.parse(String(init.body));
    const headers = (init.headers ?? {}) as Record<string, string>;
    const api = url.endsWith("/messages") && headers["x-api-key"]
      ? "anthropic-messages"
      : String(headers["X-Probe-Api"] ?? "openai-completions");
    calls.push([api, "max_completion_tokens" in parsed ? "max_completion_tokens" : "max_tokens"]);
    return reply(statuses[Math.min(call++, statuses.length - 1)], body);
  };
  return { impl, calls };
}

describe("buildProbeRequest", () => {
  it("targets chat/completions with the requested field for OpenAI-compatible providers", () => {
    const r = buildProbeRequest(target(), "openai-completions", "max_completion_tokens");
    expect(r.url).toBe("https://api.example.com/model-api/chat/completions");
    expect(r.headers.Authorization).toBe("Bearer sk-secret-key-value");
    expect(r.body).toMatchObject({ model: "gpt-5", max_completion_tokens: 16 });
    expect(r.body).not.toHaveProperty("max_tokens");
  });

  it("targets the messages API and ignores the field for anthropic providers", () => {
    const r = buildProbeRequest(target(), "anthropic-messages", "max_completion_tokens");
    expect(r.url).toBe("https://api.example.com/model-api/messages");
    expect(r.headers["x-api-key"]).toBe("sk-secret-key-value");
    expect(r.headers["anthropic-version"]).toBe("2023-06-01");
    expect(r.body).toMatchObject({ max_tokens: 16 });
  });

  it("does not double the slash on a base URL with a trailing one", () => {
    expect(buildProbeRequest(target({ baseUrl: "https://api.example.com/v1/" }), "openai-completions", "max_tokens").url)
      .toBe("https://api.example.com/v1/chat/completions");
  });

  // The probe caps output at 16 because OpenAI's reasoning models reject
  // anything smaller — and those are the models this exists to diagnose.
  it("asks for at least 16 output tokens", () => {
    expect(buildProbeRequest(target(), "openai-completions", "max_completion_tokens").body.max_completion_tokens).toBe(16);
  });
});

describe("redactSecret", () => {
  it("scrubs an echoed api key", () => {
    expect(redactSecret("bad header Bearer sk-secret-key-value", "sk-secret-key-value"))
      .toBe("bad header Bearer [redacted]");
  });

  it("leaves text alone when there is no key, or the key is too short to be one", () => {
    expect(redactSecret("plain error", null)).toBe("plain error");
    expect(redactSecret("a short a", "a")).toBe("a short a");
  });
});

describe("probeModelOnce", () => {
  it("blocks cloud metadata even though loopback is permitted", async () => {
    const fetchImpl = vi.fn();
    const r = await probeModelOnce(
      target({ baseUrl: "http://169.254.169.254/v1" }), "openai-completions", "max_tokens",
      fetchImpl as unknown as FetchLike,
    );
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // http://127.0.0.1:11434/v1 is a legitimate Ollama provider that the runtime
  // already dials on every turn.
  it("permits loopback", async () => {
    const { impl } = scriptedFetch([200]);
    const r = await probeModelOnce(target({ baseUrl: "http://127.0.0.1:11434/v1" }), "openai-completions", "max_tokens", impl);
    expect(r.ok).toBe(true);
  });

  it("reports the status and a bounded, redacted body on failure", async () => {
    const impl: FetchLike = async () => reply(400, `denied for key sk-secret-key-value ${"x".repeat(500)}`);
    const r = await probeModelOnce(target(), "openai-completions", "max_tokens", impl);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.message).not.toContain("sk-secret-key-value");
    expect(r.message).toContain("[redacted]");
    expect(r.message.length).toBeLessThan(360);
  });

  it("surfaces the underlying cause of a network failure", async () => {
    const impl: FetchLike = async () => {
      throw Object.assign(new Error("fetch failed"), { cause: new Error("ECONNREFUSED") });
    };
    const r = await probeModelOnce(target(), "openai-completions", "max_tokens", impl);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("ECONNREFUSED");
  });
});

describe("testModelWireConfig", () => {
  const oai = (over = {}) => target({ apiType: "openai-completions", ...over });
  const anth = (over = {}) => target({ apiType: "anthropic-messages", ...over });

  it("passes on the first try, correcting nothing", async () => {
    const { impl, calls } = scriptedFetch([200]);
    const r = await testModelWireConfig(oai({ modelId: "DeepSeek-V3" }), impl);
    expect(r).toMatchObject({
      ok: true, correctedApiType: false, correctedMaxTokensField: false,
      apiType: "openai-completions", maxTokensField: "max_tokens",
    });
    expect(calls).toEqual([["openai-completions", "max_tokens"]]);
  });

  // The motivating case: claude-sonnet-5 sitting on an OpenAI-protocol gateway.
  // Protocol is tried FIRST — the endpoint and body are both wrong, so nothing
  // about the field name could have been learned from that failure.
  it("corrects the protocol before touching the field name", async () => {
    const { impl, calls } = scriptedFetch([400, 200]);
    const r = await testModelWireConfig(oai({ modelId: "claude-sonnet-5" }), impl);
    expect(r.ok).toBe(true);
    expect(r.correctedApiType).toBe(true);
    expect(r.apiType).toBe("anthropic-messages");
    expect(r.message).toContain("auto-corrected");
    expect(calls).toEqual([
      ["openai-completions", "max_tokens"],
      ["anthropic-messages", "max_tokens"],
    ]);
  });

  it("falls through to the field name when the protocol was already right", async () => {
    // gpt-5 infers max_completion_tokens; a gateway that only speaks the legacy
    // field rejects it, and the anthropic attempt in between also fails.
    const { impl, calls } = scriptedFetch([400, 400, 200]);
    const r = await testModelWireConfig(oai({ modelId: "gpt-5" }), impl);
    expect(r.ok).toBe(true);
    expect(r.correctedApiType).toBe(false);
    expect(r.correctedMaxTokensField).toBe(true);
    expect(r.maxTokensField).toBe("max_tokens");
    expect(calls).toEqual([
      ["openai-completions", "max_completion_tokens"],
      ["anthropic-messages", "max_tokens"],
      ["openai-completions", "max_tokens"],
    ]);
  });

  // The messages API names its cap max_tokens unconditionally, so the sibling
  // protocol must bring its own field rather than inherit one that only means
  // something under chat-completions.
  it("probes the sibling protocol with that protocol's own field", async () => {
    const { impl, calls } = scriptedFetch([400, 200]);
    await testModelWireConfig(oai({ modelId: "gpt-5" }), impl);
    expect(calls[1]).toEqual(["anthropic-messages", "max_tokens"]);
  });

  it("corrects an anthropic model back to chat-completions", async () => {
    const { impl } = scriptedFetch([400, 200]);
    const r = await testModelWireConfig(anth({ modelId: "claude-x" }), impl);
    expect(r).toMatchObject({ ok: true, correctedApiType: true, apiType: "openai-completions" });
  });

  it.each([
    ["a timeout", 0],
    ["a rate limit", 429],
    ["an outage", 503],
    ["a bad key", 401],
  ])("does not retry or persist on %s", async (_label, status) => {
    // The regression this guards: a healthy gpt-4o times out once, a sibling
    // probe lands a second later against a recovered gateway and returns 200,
    // and the endpoint writes a correction for a model that never needed one —
    // leaving it worse than before the operator pressed Test.
    let call = 0;
    const impl: FetchLike = async () => (call++ === 0 ? reply(status, "nope") : reply(200));
    const r = await testModelWireConfig(oai({ modelId: "gpt-4o" }), impl);
    expect(r.ok).toBe(false);
    expect(r.correctedApiType).toBe(false);
    expect(r.correctedMaxTokensField).toBe(false);
    expect(call).toBe(1);
  });

  it("reports the original failure, not a hypothesis, when nothing works", async () => {
    // The siblings were our guesses, not the operator's configuration — leading
    // with their errors sends them chasing a setting they never touched.
    let call = 0;
    const impl: FetchLike = async () => reply(call++ === 0 ? 422 : 400, "later");
    const r = await testModelWireConfig(oai(), impl);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.correctedApiType).toBe(false);
    expect(r.correctedMaxTokensField).toBe(false);
    expect(call).toBe(3);
  });

  it("changes nothing for an api id it does not know", async () => {
    // pi gains api ids without a siclaw release, and buildProbeRequest sends
    // everything non-anthropic to /chat/completions — so an openai-responses
    // model is probed on an endpoint its real turns never touch. One attempt,
    // no sibling protocol (no known pairing), no field retry, nothing written:
    // a bad diagnosis is recoverable, a persisted correction inferred from the
    // wrong endpoint is not.
    const { impl, calls } = scriptedFetch([400, 200]);
    const r = await testModelWireConfig(target({ apiType: "openai-responses", modelId: "gpt-5" }), impl);
    expect(r.ok).toBe(false);
    expect(r.correctedApiType).toBe(false);
    expect(r.correctedMaxTokensField).toBe(false);
    expect(r.apiType).toBe("openai-responses");
    expect(calls).toHaveLength(1);
  });

  it("re-resolves the max-tokens field under the sibling protocol", async () => {
    // Coming FROM anthropic the field is always max_tokens (the messages API
    // has no choice), so inheriting it would probe an o-series model on
    // chat-completions with the field that family rejects — a failure caused by
    // our own second guess rather than by the operator's configuration.
    const { impl, calls } = scriptedFetch([400, 200]);
    const r = await testModelWireConfig(anth({ modelId: "o3-mini" }), impl);
    expect(calls).toEqual([
      ["anthropic-messages", "max_tokens"],
      ["openai-completions", "max_completion_tokens"],
    ]);
    expect(r).toMatchObject({
      ok: true, correctedApiType: true, apiType: "openai-completions",
      maxTokensField: "max_completion_tokens", correctedMaxTokensField: true,
    });
  });
});

describe("isFieldRejection", () => {
  it.each([400, 404, 422])("treats %d as a shape rejection", (s) => {
    expect(isFieldRejection(s)).toBe(true);
  });

  // Everything here fails for a reason unrelated to the field name, and the
  // probe PERSISTS a sibling success — so retrying on these would pin a correct
  // model to the wrong field the moment the gateway hiccups.
  it.each([0, 401, 403, 429, 500, 502, 503, 504, 200])("does not retry on %d", (s) => {
    expect(isFieldRejection(s)).toBe(false);
  });
});

describe("helpers", () => {
  it("pairs the two field names", () => {
    expect(siblingMaxTokensField("max_tokens")).toBe("max_completion_tokens");
    expect(siblingMaxTokensField("max_completion_tokens")).toBe("max_tokens");
  });

  it("recognises anthropic api ids, including the canonical pi form", () => {
    expect(usesAnthropicMessages("anthropic")).toBe(true);
    expect(usesAnthropicMessages("anthropic-messages")).toBe(true);
    expect(usesAnthropicMessages("openai-completions")).toBe(false);
    expect(usesAnthropicMessages(null)).toBe(false);
  });
});
