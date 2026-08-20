import { describe, expect, it } from "vitest";
import {
  buildProviderModelDescriptor,
  defaultProviderModelCompat,
  normalizeProviderApi,
  resolveModelApi,
  isValidMaxTokensField,
  looksLikeOpenAiReasoningModel,
  resolveMaxTokensField,
  DEFAULT_MAX_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  builtinAnthropicCompat,
  looksLikeLegacyAnthropicThinking,
  parseAnthropicCompatOverrides,
  resolveAnthropicCompat,
  withResolvedModelCompat,
} from "./model-compat.js";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";

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

describe("model field defaults", () => {
  it("matches the defaults pi applies to a model definition of its own", () => {
    // pi's config path builds a model with `maxTokens ?? 16384` and
    // `contextWindow ?? 128000`; its registerProvider path — the one every
    // Portal-managed provider takes — omits them. Using pi's own numbers keeps
    // an unset field behaving the same on both paths.
    expect(DEFAULT_MAX_TOKENS).toBe(16384);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128000);
  });

  it("stays under the smallest ceiling among models in use", () => {
    // pi's Anthropic table puts claude-haiku-4-5, claude-opus-4-5 and
    // claude-sonnet-4-5 at 64000, and the Claude protocol rejects a request
    // whose max_tokens exceeds the model's ceiling instead of clamping it. The
    // previous default (65536) was above that line.
    expect(DEFAULT_MAX_TOKENS).toBeLessThan(64000);
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

describe("Anthropic thinking compat", () => {
  const anthropic = { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" };
  const row = (model_id: string, compat_overrides?: string | null) => ({
    model_id, context_window: 200000, max_tokens: 64000, reasoning: true, compat_overrides,
  });
  const compatOf = (model_id: string, overrides?: string | null) =>
    buildProviderModelDescriptor(row(model_id, overrides), anthropic).compat;

  // The failure this exists for: pi sends thinking:{type:"enabled"} unless
  // compat.forceAdaptiveThinking is true, and Claude 4.6+ / the 5 family answer
  // that with `"thinking.type.enabled" is not supported for this model`. Our
  // descriptor never set the key, so every Portal-configured reasoning model on
  // those generations 400s the moment thinking is switched on.
  it("forces adaptive thinking for the model that produced the 400", () => {
    expect(compatOf("claude-opus-5").forceAdaptiveThinking).toBe(true);
  });

  // The reason a plain table lookup does not solve this: pi's table is a release
  // snapshot, and the id that broke is not in it. The lag window is exactly when
  // a model is newest — when someone is most likely to add it.
  it("does not rely on pi knowing the id", () => {
    expect(ANTHROPIC_MODELS["claude-opus-5" as keyof typeof ANTHROPIC_MODELS]).toBeUndefined();
    expect(builtinAnthropicCompat("claude-opus-5")).toBeUndefined();
    // …and an id nobody has seen yet resolves the same way.
    expect(resolveAnthropicCompat("claude-opus-7-20270101").forceAdaptiveThinking).toBe(true);
  });

  it("takes pi's answer where pi has one", () => {
    expect(compatOf("claude-opus-4-6").forceAdaptiveThinking).toBe(true);
    expect(compatOf("claude-opus-4-7").supportsTemperature).toBe(false);
    // A table entry with no compat at all means pi's defaults, which for these
    // legacy models are the correct ones — a miss is not the same as "unknown".
    expect(compatOf("claude-sonnet-4-5").forceAdaptiveThinking).toBe(false);
    expect(compatOf("claude-haiku-4-5-20251001").forceAdaptiveThinking).toBe(false);
  });

  // A generation rule, not a mirror of pi's table: nothing is added here when a
  // model ships, and it covers the ids pi's snapshot never had.
  it("reads a generation older than adaptive thinking as legacy", () => {
    // claude-opus-4 / claude-sonnet-4 are the sharp case: real, pre-adaptive, and
    // absent from pi 0.80.7's table, so ONLY this rule answers for them. A bare
    // minor is .0, not "unknown" — reading it as the current generation would
    // force adaptive and 400 them the other way.
    for (const id of ["claude-3-7-sonnet-ourgw", "claude-3-5-sonnet-20240620", "claude-2.1",
                      "claude-instant-1", "claude-opus-4", "claude-sonnet-4"]) {
      expect(looksLikeLegacyAnthropicThinking(id)).toBe(true);
      expect(resolveAnthropicCompat(id).forceAdaptiveThinking).toBe(false);
    }
    for (const id of ["claude-opus-4-6", "claude-sonnet-5", "claude-opus-5", "claude-opus-4-10"]) {
      expect(looksLikeLegacyAnthropicThinking(id)).toBe(false);
    }
  });

  // "I cannot tell WHICH Claude" must not be answered with the shape being
  // retired — but that only applies to a Claude id.
  it("defaults an unrecognised CLAUDE id to the latest generation", () => {
    expect(resolveAnthropicCompat("claude-neo-preview")).toEqual({
      forceAdaptiveThinking: true, supportsTemperature: false,
    });
  });

  // anthropic-messages is a PROTOCOL other vendors implement. Handing a MiniMax
  // model the newest Claude shape is not a cautious guess, it is a guess about a
  // different product — and adaptive thinking is exactly what such an endpoint
  // would reject. Resolving to nothing leaves pi's own defaults in place.
  it("says nothing about a model that is not Claude", () => {
    for (const id of ["minimax-m2.1", "glm-4.6", "our-internal-proxy-model", "deepseek-v3"]) {
      expect(resolveAnthropicCompat(id)).toEqual({});
    }
    const cfg = withResolvedModelCompat({
      api: "anthropic-messages",
      models: [{ id: "minimax-m2.1", reasoning: true }],
    });
    expect((cfg.models[0] as any).compat).toBeUndefined();
    expect(compatOf("minimax-m2.1").forceAdaptiveThinking).toBeUndefined();
  });

  // The cost of the rule above, stated: a Claude model renamed past recognition
  // is indistinguishable from a MiniMax id, so it needs the override rather than
  // a guess.
  it("still lets an override speak for an unrecognisable id", () => {
    expect(resolveAnthropicCompat("opus-5-fast", '{"forceAdaptiveThinking":true}'))
      .toEqual({ forceAdaptiveThinking: true });
  });

  it("lets a per-model override win, one key at a time", () => {
    // The escape hatch for a pre-4.6 model renamed so neither the table nor the
    // generation rule recognises it — pi's own docstring documents `false` as
    // the way to opt out.
    expect(compatOf("mystery-claude", '{"forceAdaptiveThinking":false}').forceAdaptiveThinking).toBe(false);
    // Overriding one key must not discard the resolved value of the other.
    expect(compatOf("claude-opus-4-7", '{"forceAdaptiveThinking":false}').supportsTemperature).toBe(false);
  });

  it("ignores unknown keys and non-booleans on the READ path", () => {
    // A write is rejected (see siclaw-api), but a value written by a NEWER build
    // must not take a model out of service here.
    expect(parseAnthropicCompatOverrides('{"somethingNew":true}')).toEqual({});
    expect(parseAnthropicCompatOverrides('{"forceAdaptiveThinking":"yes"}')).toEqual({});
    expect(parseAnthropicCompatOverrides("not json")).toEqual({});
    expect(parseAnthropicCompatOverrides(null)).toEqual({});
    expect(parseAnthropicCompatOverrides('["a"]')).toEqual({});
  });

  // pi reads both keys only on the anthropic-messages path. Emitting them on an
  // OpenAI model is noise that also invites the wrong question of it.
  it("emits nothing thinking-related for a non-Anthropic protocol", () => {
    const openai = buildProviderModelDescriptor(row("gpt-5"), {
      api: "openai-completions", baseUrl: "https://api.openai.com/v1",
    }).compat;
    expect("forceAdaptiveThinking" in openai).toBe(false);
    expect("supportsTemperature" in openai).toBe(false);
  });

  it("resolves through the legacy provider alias too", () => {
    // A row written before api aliases were normalised says "anthropic".
    expect(buildProviderModelDescriptor(row("claude-opus-5"), { api: "anthropic", baseUrl: "x" })
      .compat.forceAdaptiveThinking).toBe(true);
  });
});

describe("withResolvedModelCompat (control-plane configs)", () => {
  // The reason this exists as well as the descriptor: a control plane that
  // answers config.getModelBinding supplies the whole modelConfig and the runtime
  // forwards it verbatim, so the descriptor never runs on that path. Fixing the
  // descriptor alone left the 400 exactly as it was — which is what happened.
  const cfg = (overrides?: Record<string, unknown>) => ({
    name: "sicore-custom", baseUrl: "https://api.x/v1", apiKey: "sk", api: "anthropic-messages",
    models: [{ id: "claude-opus-5", name: "Opus 5", reasoning: true, contextWindow: 200000, maxTokens: 64000, ...overrides }],
  });

  it("fills in the thinking shape a control plane never stated", () => {
    const out = withResolvedModelCompat(cfg());
    expect(out.models[0].compat).toEqual({ forceAdaptiveThinking: true, supportsTemperature: false });
  });

  it("never overrides a value the control plane did state", () => {
    // pi documents `false` as the way to opt out; a caller that says so owns the
    // decision, and this must not quietly reverse it.
    const out = withResolvedModelCompat(cfg({ compat: { forceAdaptiveThinking: false } }));
    expect(out.models[0].compat.forceAdaptiveThinking).toBe(false);
    // …while still answering the key the caller left open.
    expect(out.models[0].compat.supportsTemperature).toBe(false);
  });

  it("keeps unrelated compat keys the control plane sent", () => {
    const out = withResolvedModelCompat(cfg({ compat: { supportsEagerToolInputStreaming: true } }));
    expect(out.models[0].compat.supportsEagerToolInputStreaming).toBe(true);
    expect(out.models[0].compat.forceAdaptiveThinking).toBe(true);
  });

  it("leaves a non-Anthropic model, and the caller's object, alone", () => {
    const openai = { api: "openai-completions", models: [{ id: "gpt-5" }] };
    expect(withResolvedModelCompat(openai)).toBe(openai);
    // A per-model api beats the provider's, both ways.
    const mixed = withResolvedModelCompat({
      api: "openai-completions",
      models: [{ id: "claude-opus-5", api: "anthropic-messages" }, { id: "gpt-5" }],
    });
    expect((mixed.models[0] as any).compat.forceAdaptiveThinking).toBe(true);
    expect((mixed.models[1] as any).compat).toBeUndefined();
  });

  it("does not mutate the caller's config", () => {
    const input = cfg();
    const before = JSON.stringify(input);
    withResolvedModelCompat(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("survives shapes a control plane should not send but might", () => {
    expect(withResolvedModelCompat(undefined)).toBeUndefined();
    expect(withResolvedModelCompat({ api: "anthropic-messages" })).toEqual({ api: "anthropic-messages" });
    const junk = { api: "anthropic-messages", models: [null, { name: "no id" }, "x"] };
    expect(withResolvedModelCompat(junk)).toBe(junk);
  });
});
