import { describe, expect, it, vi } from "vitest";
import {
  buildProbeRequest,
  probeModelOnce,
  redactSecret,
  siblingMaxTokensField,
  testModelWireConfig,
  usesAnthropicMessages,
  type FetchLike,
  type ProbeTarget,
} from "./model-probe.js";

const GATEWAY = { api: "openai-completions", baseUrl: "https://api.example.com/model-api" };
const ANTHROPIC = { api: "anthropic", baseUrl: "https://api.anthropic.com/v1" };

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

/** Records the max-tokens field of every attempt, answering per a script. */
function scriptedFetch(statuses: number[], body = '{"error":"nope"}') {
  const fields: string[] = [];
  let call = 0;
  const impl: FetchLike = async (_url, init) => {
    const parsed = JSON.parse(String(init.body));
    fields.push("max_completion_tokens" in parsed ? "max_completion_tokens" : "max_tokens");
    return reply(statuses[Math.min(call++, statuses.length - 1)], body);
  };
  return { impl, fields };
}

describe("buildProbeRequest", () => {
  it("targets chat/completions with the requested field for OpenAI-compatible providers", () => {
    const r = buildProbeRequest(target(), "max_completion_tokens");
    expect(r.url).toBe("https://api.example.com/model-api/chat/completions");
    expect(r.headers.Authorization).toBe("Bearer sk-secret-key-value");
    expect(r.body).toMatchObject({ model: "gpt-5", max_completion_tokens: 16 });
    expect(r.body).not.toHaveProperty("max_tokens");
  });

  it("targets the messages API and ignores the field for anthropic providers", () => {
    const r = buildProbeRequest(target({ apiType: "anthropic" }), "max_completion_tokens");
    expect(r.url).toBe("https://api.example.com/model-api/messages");
    expect(r.headers["x-api-key"]).toBe("sk-secret-key-value");
    expect(r.headers["anthropic-version"]).toBe("2023-06-01");
    expect(r.body).toMatchObject({ max_tokens: 16 });
  });

  it("does not double the slash on a base URL with a trailing one", () => {
    expect(buildProbeRequest(target({ baseUrl: "https://api.example.com/v1/" }), "max_tokens").url)
      .toBe("https://api.example.com/v1/chat/completions");
  });

  // The probe caps output at 16 because OpenAI's reasoning models reject
  // anything smaller — and those are the models this exists to diagnose.
  it("asks for at least 16 output tokens", () => {
    expect(buildProbeRequest(target(), "max_completion_tokens").body.max_completion_tokens).toBe(16);
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
      target({ baseUrl: "http://169.254.169.254/v1" }), "max_tokens", fetchImpl as unknown as FetchLike,
    );
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // http://127.0.0.1:11434/v1 is a legitimate Ollama provider that the runtime
  // already dials on every turn.
  it("permits loopback", async () => {
    const { impl } = scriptedFetch([200]);
    const r = await probeModelOnce(target({ baseUrl: "http://127.0.0.1:11434/v1" }), "max_tokens", impl);
    expect(r.ok).toBe(true);
  });

  it("reports the status and a bounded, redacted body on failure", async () => {
    const impl: FetchLike = async () => reply(400, `denied for key sk-secret-key-value ${"x".repeat(500)}`);
    const r = await probeModelOnce(target(), "max_tokens", impl);
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
    const r = await probeModelOnce(target(), "max_tokens", impl);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("ECONNREFUSED");
  });
});

describe("testModelWireConfig", () => {
  it("passes on the first try without correcting", async () => {
    const { impl, fields } = scriptedFetch([200]);
    const r = await testModelWireConfig(target({ modelId: "DeepSeek-V3" }), GATEWAY, impl);
    expect(r).toMatchObject({ ok: true, corrected: false, maxTokensField: "max_tokens" });
    expect(fields).toEqual(["max_tokens"]);
  });

  // The whole point: the operator configured (or inherited) the wrong field and
  // never has to work out which one is right.
  it("retries on the sibling field and reports the correction", async () => {
    const { impl, fields } = scriptedFetch([400, 200]);
    const r = await testModelWireConfig(
      target({ modelId: "scitix-reasoner-1", maxTokensField: "max_tokens" }), GATEWAY, impl,
    );
    expect(r.ok).toBe(true);
    expect(r.corrected).toBe(true);
    expect(r.maxTokensField).toBe("max_completion_tokens");
    expect(r.message).toContain("auto-corrected");
    expect(fields).toEqual(["max_tokens", "max_completion_tokens"]);
  });

  it("corrects in the other direction too", async () => {
    const { impl, fields } = scriptedFetch([400, 200]);
    // gpt-5 infers max_completion_tokens; a gateway that only speaks the legacy
    // field pushes it back.
    const r = await testModelWireConfig(target({ modelId: "gpt-5" }), GATEWAY, impl);
    expect(r).toMatchObject({ ok: true, corrected: true, maxTokensField: "max_tokens" });
    expect(fields).toEqual(["max_completion_tokens", "max_tokens"]);
  });

  it("reports the original failure, not the hypothesis, when both fail", async () => {
    // The sibling attempt was our guess, not the operator's configuration —
    // leading with its error sends them chasing a field they never set.
    let call = 0;
    const impl: FetchLike = async () => reply(call++ === 0 ? 401 : 400, "second");
    const r = await testModelWireConfig(target(), GATEWAY, impl);
    expect(r.ok).toBe(false);
    expect(r.corrected).toBe(false);
    expect(r.status).toBe(401);
    expect(r.maxTokensField).toBe("max_completion_tokens");
  });

  // Anthropic's messages API names the field max_tokens unconditionally, so the
  // sibling request would be byte-identical and its failure meaningless.
  it("does not retry on an anthropic provider", async () => {
    const { impl, fields } = scriptedFetch([400]);
    const r = await testModelWireConfig(target({ apiType: "anthropic" }), ANTHROPIC, impl);
    expect(r.ok).toBe(false);
    expect(r.corrected).toBe(false);
    expect(fields).toHaveLength(1);
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
