import { describe, expect, it } from "vitest";
import {
  buildProviderModelDescriptor,
  defaultProviderModelCompat,
  normalizeProviderApi,
  resolveModelApi,
} from "./model-compat.js";

describe("defaultProviderModelCompat", () => {
  it("keeps developer-role messages for the official OpenAI API", () => {
    expect(defaultProviderModelCompat({
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    }).supportsDeveloperRole).toBe(true);
  });

  it("disables developer-role messages for OpenAI-compatible gateways", () => {
    expect(defaultProviderModelCompat({
      api: "openai-completions",
      baseUrl: "https://api.example.com/model-api",
    }).supportsDeveloperRole).toBe(false);
  });

  it("disables developer-role messages for Anthropic providers", () => {
    expect(defaultProviderModelCompat({
      api: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
    }).supportsDeveloperRole).toBe(false);
  });
});

describe("buildProviderModelDescriptor", () => {
  const provider = { api: "anthropic", baseUrl: "https://api.anthropic.com/v1" };

  it("maps vision=1 to text+image input capability", () => {
    const d = buildProviderModelDescriptor(
      { model_id: "claude-vision", name: "Claude Vision", reasoning: 1, vision: 1, context_window: 200000, max_tokens: 8192 },
      provider,
    );
    expect(d.input).toEqual(["text", "image"]);
    expect(d.id).toBe("claude-vision");
    expect(d.name).toBe("Claude Vision");
    expect(d.reasoning).toBe(true);
    expect(d.contextWindow).toBe(200000);
    expect(d.maxTokens).toBe(8192);
  });

  it("maps vision=0 to text-only input capability", () => {
    const d = buildProviderModelDescriptor(
      { model_id: "gpt-text", reasoning: 0, vision: 0, context_window: 128000, max_tokens: 4096 },
      provider,
    );
    expect(d.input).toEqual(["text"]);
    expect(d.reasoning).toBe(false);
    // name falls back to model_id when absent
    expect(d.name).toBe("gpt-text");
  });

  it("treats missing/falsy vision as text-only", () => {
    const d = buildProviderModelDescriptor(
      { model_id: "m", context_window: 1000, max_tokens: 100 },
      provider,
    );
    expect(d.input).toEqual(["text"]);
  });
});

describe("resolveModelApi", () => {
  const anthropicProvider = { api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" };
  const row = (api_type?: string | null) => ({
    model_id: "m", context_window: 1000, max_tokens: 100, api_type,
  });

  it("inherits the provider api when the model does not override", () => {
    expect(resolveModelApi(row(undefined), anthropicProvider))
      .toEqual({ api: "anthropic-messages", isOverride: false });
  });

  // The empty-string trap: normalizeProviderApi("") is "openai-completions", so
  // a `row.api_type ?? provider.api` implementation would report a hard OpenAI
  // override here and silently un-inherit the Anthropic provider.
  it.each(["", "   ", null])("inherits (never openai-completions) for %j", (api_type) => {
    expect(resolveModelApi(row(api_type), anthropicProvider))
      .toEqual({ api: "anthropic-messages", isOverride: false });
  });

  it("normalizes a legacy override value", () => {
    expect(resolveModelApi(row("anthropic"), { api: "openai-completions" }))
      .toEqual({ api: "anthropic-messages", isOverride: true });
  });

  it("falls back to openai-completions when neither model nor provider sets an api", () => {
    expect(resolveModelApi(row(null), {})).toEqual({ api: "openai-completions", isOverride: false });
  });
});

describe("buildProviderModelDescriptor — per-model api override", () => {
  const row = (api_type?: string | null) => ({
    model_id: "m", context_window: 1000, max_tokens: 100, api_type,
  });

  it("omits the api key entirely when the model inherits", () => {
    const d = buildProviderModelDescriptor(row(undefined), { api: "anthropic-messages" });
    expect("api" in d).toBe(false);
  });

  // An emitted `api: ""` is worse than a wrong protocol: pi's parseModels does
  // `if (!api) continue`, dropping the model from the registry ("model not
  // found") instead of erroring on the protocol.
  it.each(["", "   ", null])("emits no api key for %j — never an empty string", (api_type) => {
    const d = buildProviderModelDescriptor(row(api_type), { api: "anthropic-messages" });
    expect("api" in d).toBe(false);
    expect((d as { api?: string }).api).not.toBe("");
    expect((d as { api?: string }).api).not.toBe("openai-completions");
  });

  // The production case this feature exists for: one aggregator gateway hosting
  // OpenAI-protocol and Claude-protocol models side by side.
  it("emits the override for a Claude model on an OpenAI-protocol gateway", () => {
    const gateway = { api: "openai-completions", baseUrl: "https://api.scitix.ai/model-api" };
    expect(buildProviderModelDescriptor(
      { ...row("anthropic-messages"), model_id: "claude-sonnet-5" }, gateway,
    ).api).toBe("anthropic-messages");
    // sibling models on the same provider keep inheriting
    expect("api" in buildProviderModelDescriptor(
      { ...row(null), model_id: "DeepSeek-V4-Pro" }, gateway,
    )).toBe(false);
  });

  it("derives compat from the effective api, not the provider api", () => {
    // Provider says chat-completions on the official OpenAI host (which alone
    // would yield supportsDeveloperRole: true) — the model's override wins.
    expect(buildProviderModelDescriptor(
      row("anthropic-messages"),
      { api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
    ).compat.supportsDeveloperRole).toBe(false);

    // And the reverse: an anthropic-messages provider with a model overriding
    // back to chat-completions on the official host.
    expect(buildProviderModelDescriptor(
      row("openai-completions"),
      { api: "anthropic-messages", baseUrl: "https://api.openai.com/v1" },
    ).compat.supportsDeveloperRole).toBe(true);
  });
});

describe("normalizeProviderApi", () => {
  it("maps the legacy 'anthropic' api_type to pi's registered api id", () => {
    // "anthropic" is a pi provider slug, not an api — feeding it to a model
    // config fails the turn with "No API provider registered for api: anthropic".
    expect(normalizeProviderApi("anthropic")).toBe("anthropic-messages");
  });

  it("maps the legacy 'openai' api_type to openai-completions", () => {
    expect(normalizeProviderApi("openai")).toBe("openai-completions");
  });

  it("passes canonical and unknown api ids through unchanged", () => {
    expect(normalizeProviderApi("anthropic-messages")).toBe("anthropic-messages");
    expect(normalizeProviderApi("openai-completions")).toBe("openai-completions");
    expect(normalizeProviderApi("openai-responses")).toBe("openai-responses");
    expect(normalizeProviderApi("some-custom-api")).toBe("some-custom-api");
  });

  it("is case/whitespace tolerant on legacy values", () => {
    expect(normalizeProviderApi(" Anthropic ")).toBe("anthropic-messages");
  });

  it("falls back to openai-completions for empty/null", () => {
    expect(normalizeProviderApi("")).toBe("openai-completions");
    expect(normalizeProviderApi(null)).toBe("openai-completions");
    expect(normalizeProviderApi(undefined)).toBe("openai-completions");
  });
});
