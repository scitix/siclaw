import { describe, expect, it } from "vitest";

import { resolveCapabilitySessionLlm } from "./session-config.js";

describe("resolveCapabilitySessionLlm", () => {
  it("treats the consumer LLM object as authoritative without field-level Runtime fallback", () => {
    const consumer = { base_url: "https://tenant.example/v1" };
    const resolved = resolveCapabilitySessionLlm(consumer, {
      ANTHROPIC_BASE_URL: "https://runtime.example/v1",
      ANTHROPIC_AUTH_TOKEN: "runtime-secret",
      ANTHROPIC_MODEL: "runtime-model",
    });

    expect(resolved).toBe(consumer);
    expect(resolved).toEqual({ base_url: "https://tenant.example/v1" });
  });

  it("uses the complete Runtime Helm fallback only when the consumer object is absent", () => {
    expect(resolveCapabilitySessionLlm(undefined, {
      ANTHROPIC_BASE_URL: "https://runtime.example/v1",
      ANTHROPIC_AUTH_TOKEN: "runtime-secret",
      ANTHROPIC_API_KEY: "lower-precedence-key",
      ANTHROPIC_MODEL: "runtime-model",
    })).toEqual({
      base_url: "https://runtime.example/v1",
      auth_token: "runtime-secret",
      api_key: undefined,
      model: "runtime-model",
    });
  });

  it("preserves API-key-only Runtime deployments without duplicating credential modes", () => {
    expect(resolveCapabilitySessionLlm(undefined, {
      ANTHROPIC_API_KEY: "runtime-api-key",
    })).toEqual({
      base_url: undefined,
      auth_token: undefined,
      api_key: "runtime-api-key",
      model: undefined,
    });
  });

  it("returns undefined when neither authority configured an LLM block", () => {
    expect(resolveCapabilitySessionLlm(undefined, {})).toBeUndefined();
  });
});
