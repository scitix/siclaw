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
  const row = (api_type?: string | null) => ({
    model_id: "m", context_window: 1000, max_tokens: 100, api_type,
  });

  it("uses the model's own protocol", () => {
    expect(resolveModelApi(row("anthropic-messages"), { api: "openai-completions" }))
      .toBe("anthropic-messages");
  });

  it("normalizes a legacy value", () => {
    expect(resolveModelApi(row("anthropic"), {})).toBe("anthropic-messages");
  });

  // The column is NOT NULL on fresh installs and backfilled on upgrade, so an
  // empty value only reaches here from a legacy SQLite file where the
  // constraint could not be applied. Fall back to the provider, which is what
  // those rows meant.
  it.each(["", "   ", null, undefined])("falls back to the provider for %j", (api_type) => {
    expect(resolveModelApi(row(api_type), { api: "anthropic-messages" })).toBe("anthropic-messages");
  });

  it("falls back to openai-completions when neither is set", () => {
    expect(resolveModelApi(row(null), {})).toBe("openai-completions");
  });
});

describe("buildProviderModelDescriptor — per-model protocol", () => {
  const row = (api_type?: string | null) => ({
    model_id: "m", context_window: 1000, max_tokens: 100, api_type,
  });

  // Always emitted, never omitted: pi would fall back to the provider if the
  // key were absent, but protocol is a per-model property here and stating it
  // explicitly is what keeps the layers from disagreeing.
  it("always emits api", () => {
    expect(buildProviderModelDescriptor(row("anthropic-messages"), { api: "openai-completions" }).api)
      .toBe("anthropic-messages");
    expect(buildProviderModelDescriptor(row(null), { api: "anthropic-messages" }).api)
      .toBe("anthropic-messages");
  });

  it("never emits an empty api", () => {
    // pi's parseModels does `if (!api) continue` — an empty string would drop
    // the model from the registry entirely ("model not found").
    for (const v of ["", "   ", null, undefined]) {
      expect(buildProviderModelDescriptor(row(v), {}).api).toBeTruthy();
    }
  });

  // The production case: one aggregator gateway, mixed protocols.
  it("lets models on one gateway speak different protocols", () => {
    const gateway = { api: "openai-completions", baseUrl: "https://api.scitix.ai/model-api" };
    expect(buildProviderModelDescriptor(
      { ...row("anthropic-messages"), model_id: "claude-sonnet-5" }, gateway,
    ).api).toBe("anthropic-messages");
    expect(buildProviderModelDescriptor(
      { ...row("openai-completions"), model_id: "DeepSeek-V4-Pro" }, gateway,
    ).api).toBe("openai-completions");
  });

  it("derives compat from the model's protocol, not the provider's", () => {
    expect(buildProviderModelDescriptor(
      row("anthropic-messages"),
      { api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
    ).compat.supportsDeveloperRole).toBe(false);

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
