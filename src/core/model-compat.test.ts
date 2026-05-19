import { describe, expect, it } from "vitest";
import { defaultProviderModelCompat } from "./model-compat.js";

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
