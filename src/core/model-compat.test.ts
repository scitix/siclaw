import { describe, expect, it } from "vitest";
import {
  buildProviderModelDescriptor,
  defaultProviderModelCompat,
  normalizeProviderApi,
  resolveModelApi,
  isValidMaxTokensField,
  looksLikeOpenAiReasoningModel,
  resolveMaxTokensField,
} from "./model-compat.js";

describe("defaultProviderModelCompat", () => {
  it("keeps developer-role messages for the official OpenAI API", () => {
    expect(defaultProviderModelCompat({
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    }, { id: "m" }).supportsDeveloperRole).toBe(true);
  });

  it("disables developer-role messages for OpenAI-compatible gateways", () => {
    expect(defaultProviderModelCompat({
      api: "openai-completions",
      baseUrl: "https://api.example.com/model-api",
    }, { id: "m" }).supportsDeveloperRole).toBe(false);
  });

  it("disables developer-role messages for Anthropic providers", () => {
    expect(defaultProviderModelCompat({
      api: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
    }, { id: "m" }).supportsDeveloperRole).toBe(false);
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

describe("looksLikeOpenAiReasoningModel", () => {
  it.each([
    "gpt-5", "gpt-5-mini", "gpt5", "GPT-5-Turbo",
    "o1", "o1-preview", "o3", "o3-mini", "o4-mini",
    "openai/gpt-5", "azure/o3-mini",
  ])("recognises %s", (id) => {
    expect(looksLikeOpenAiReasoningModel(id)).toBe(true);
  });

  // gpt-4o is the trap: it ends in "o" and predates the reasoning families.
  // Matching it would flip every GPT-4o deployment onto the wrong field.
  it.each([
    "gpt-4o", "gpt-4o-mini", "gpt-4", "gpt-4-turbo",
    "claude-sonnet-5", "DeepSeek-V3", "glm-4.6", "ollama-llama3", "qwen-max",
  ])("leaves %s alone", (id) => {
    expect(looksLikeOpenAiReasoningModel(id)).toBe(false);
  });
});

describe("resolveMaxTokensField", () => {
  const gateway = { api: "openai-completions", baseUrl: "https://api.scitix.ai/model-api" };
  const anthropic = { api: "anthropic", baseUrl: "https://api.anthropic.com/v1" };

  it("uses an explicit override", () => {
    expect(resolveMaxTokensField({ id: "gpt-4o", maxTokensField: "max_completion_tokens" }, gateway))
      .toBe("max_completion_tokens");
    expect(resolveMaxTokensField({ id: "gpt-5", maxTokensField: "max_tokens" }, gateway))
      .toBe("max_tokens");
  });

  it.each(["", "   ", null, undefined])("infers when the override is %j", (maxTokensField) => {
    expect(resolveMaxTokensField({ id: "gpt-5", maxTokensField }, gateway)).toBe("max_completion_tokens");
    expect(resolveMaxTokensField({ id: "DeepSeek-V3", maxTokensField }, gateway)).toBe("max_tokens");
  });

  // pi types this as a two-member union: an unrecognised value doesn't degrade,
  // it drops the model out of the registry. Falling back to inference keeps a
  // typo from silently deleting a model.
  it.each(["maxTokens", "max_completion_token", "1", "true"])("ignores the invalid value %j", (bad) => {
    expect(resolveMaxTokensField({ id: "gpt-5", maxTokensField: bad }, gateway))
      .toBe("max_completion_tokens");
    expect(isValidMaxTokensField(bad)).toBe(false);
  });

  // The messages API always names the field max_tokens and pi's anthropic path
  // ignores this setting entirely — inference must not fire there.
  it("never infers a switch on an anthropic provider", () => {
    expect(resolveMaxTokensField({ id: "gpt-5", maxTokensField: null }, anthropic)).toBe("max_tokens");
  });

  it("mixes both fields under one gateway", () => {
    expect(resolveMaxTokensField({ id: "gpt-5", maxTokensField: null }, gateway)).toBe("max_completion_tokens");
    expect(resolveMaxTokensField({ id: "claude-sonnet-5", maxTokensField: null }, gateway)).toBe("max_tokens");
  });
});

describe("buildProviderModelDescriptor — per-model max-tokens field", () => {
  const gateway = { api: "openai-completions", baseUrl: "https://api.scitix.ai/model-api" };
  const row = (model_id: string, max_tokens_field?: string | null) => ({
    model_id, context_window: 128000, max_tokens: 4096, max_tokens_field,
  });

  it("always emits one of the two valid field names", () => {
    // Omitting the key would hand the decision back to pi's own base-URL
    // heuristic — the value here is precisely what we mean to state.
    for (const v of ["", "   ", null, undefined, "garbage"]) {
      expect(isValidMaxTokensField(buildProviderModelDescriptor(row("m", v), gateway).compat.maxTokensField))
        .toBe(true);
    }
  });

  it("gives two models on the same gateway different fields", () => {
    expect(buildProviderModelDescriptor(row("gpt-5"), gateway).compat.maxTokensField)
      .toBe("max_completion_tokens");
    expect(buildProviderModelDescriptor(row("DeepSeek-V3"), gateway).compat.maxTokensField)
      .toBe("max_tokens");
  });

  it("lets an explicit override beat the naming convention", () => {
    // The escape hatch for renamed ids on aggregator gateways, and for
    // reasoning families that ship after this code does.
    expect(buildProviderModelDescriptor(row("scitix-reasoner-1", "max_completion_tokens"), gateway)
      .compat.maxTokensField).toBe("max_completion_tokens");
    expect(buildProviderModelDescriptor(row("gpt-5", "max_tokens"), gateway)
      .compat.maxTokensField).toBe("max_tokens");
  });
});
