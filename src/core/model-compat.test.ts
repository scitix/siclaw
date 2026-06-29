import { describe, expect, it } from "vitest";
import { buildProviderModelDescriptor, defaultProviderModelCompat } from "./model-compat.js";

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
