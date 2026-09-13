import { describe, it, expect } from "vitest";
import {
  resolveUsageStatus,
  outputNonReasoningTokens,
  inputTokensUncached,
  hasTrustworthyUsage,
  validateUsageConsistency,
  USAGE_FIELD_CONTRACTS,
  type LlmCallRecord,
  type UsageField,
} from "./llm-call-record.js";

/** What a healthy standard Responses call reports — note: no cache_write. */
const RESPONSES_FULL = USAGE_FIELD_CONTRACTS["openai-responses"].required as readonly UsageField[];

describe("resolveUsageStatus", () => {
  it("marks a full provider report as reported", () => {
    expect(resolveUsageStatus("openai-responses", RESPONSES_FULL, "provider")).toBe("reported");
  });

  it("marks a subset of the contract as partial", () => {
    expect(resolveUsageStatus("openai-responses", ["input", "output"], "provider")).toBe("partial");
  });

  it("does not demand all five fields of a protocol that reports four", () => {
    // anthropic-messages has no separate reasoning field; requiring it would
    // mark every healthy Claude call `partial` forever.
    expect(resolveUsageStatus("anthropic-messages", ["input", "output", "cache_read", "cache_write"], "provider"))
      .toBe("reported");
  });

  it("does not require cache_write from standard Responses", () => {
    // Standard OpenAI ResponseUsage has no cache-write figure at all. Demanding
    // one marked every ordinary call `partial`.
    expect(resolveUsageStatus("openai-responses", ["input", "output", "reasoning", "cache_read"], "provider"))
      .toBe("reported");
  });

  it("refuses to judge an api_type it has no contract for", () => {
    expect(resolveUsageStatus("some-future-api", ["input", "output"], "provider")).toBe("unknown");
  });

  it("treats the SDK's pre-request placeholder as missing, not as zeros", () => {
    expect(resolveUsageStatus("openai-responses", [], "sdk_default")).toBe("missing");
  });

  it("treats a rehydrated record as unknown even when fields look present", () => {
    // A rebuilt transcript can carry a complete-looking ZERO_USAGE object.
    expect(resolveUsageStatus("openai-responses", RESPONSES_FULL, "rehydrated")).toBe("unknown");
  });

  it("treats unmarked history as unknown", () => {
    expect(resolveUsageStatus("openai-responses", [], "unknown")).toBe("unknown");
  });
});

describe("outputNonReasoningTokens", () => {
  it("subtracts reasoning from the raw output total", () => {
    expect(outputNonReasoningTokens({ output_tokens_total: 900, reasoning_tokens: 400 })).toBe(500);
  });

  it("returns null when either input is unknown", () => {
    expect(outputNonReasoningTokens({ output_tokens_total: null, reasoning_tokens: 400 })).toBeNull();
    expect(outputNonReasoningTokens({ output_tokens_total: 900, reasoning_tokens: null })).toBeNull();
  });

  it("keeps a reported zero as a real value, not as unknown", () => {
    expect(outputNonReasoningTokens({ output_tokens_total: 900, reasoning_tokens: 0 })).toBe(900);
  });
});

describe("inputTokensUncached", () => {
  it("subtracts both cache figures under openai-responses", () => {
    // That protocol's input_tokens INCLUDES cached and cache-write tokens.
    expect(inputTokensUncached({
      api_type: "openai-responses",
      input_tokens_total: 10_000,
      cache_read_tokens: 7_000,
      cache_write_tokens: 1_000,
    })).toBe(2_000);
  });

  it("passes the anthropic figure through, since it already excludes cache", () => {
    expect(inputTokensUncached({
      api_type: "anthropic-messages",
      input_tokens_total: 2_000,
      cache_read_tokens: 7_000,
      cache_write_tokens: 1_000,
    })).toBe(2_000);
  });

  it("returns null for a protocol whose convention is unknown", () => {
    expect(inputTokensUncached({
      api_type: "some-future-api",
      input_tokens_total: 10_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    })).toBeNull();
  });

  it("propagates null rather than treating a missing cache figure as zero", () => {
    expect(inputTokensUncached({
      api_type: "openai-responses",
      input_tokens_total: 10_000,
      cache_read_tokens: null,
      cache_write_tokens: 0,
    })).toBeNull();
  });

  it("distinguishes a reported cache_read of 0 from an unreported one", () => {
    const reportedZero = inputTokensUncached({
      api_type: "openai-responses",
      input_tokens_total: 500,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    const unreported = inputTokensUncached({
      api_type: "openai-responses",
      input_tokens_total: 500,
      cache_read_tokens: null,
      cache_write_tokens: null,
    });
    expect(reportedZero).toBe(500);
    expect(unreported).toBeNull();
  });
});

describe("impossible figures are unknown, never clamped to zero", () => {
  it("reports null when reasoning exceeds output", () => {
    // Clamping to 0 would assert "no non-reasoning output" as fact and destroy
    // the only evidence that the two figures disagree.
    expect(outputNonReasoningTokens({ output_tokens_total: 10, reasoning_tokens: 20 })).toBeNull();
  });

  it("reports null when cached input exceeds the input total", () => {
    expect(inputTokensUncached({
      api_type: "openai-responses",
      input_tokens_total: 100,
      cache_read_tokens: 120,
      cache_write_tokens: 0,
    })).toBeNull();
  });

  it("surfaces both contradictions as inconsistencies", () => {
    const problems = validateUsageConsistency({
      api_type: "openai-responses",
      input_tokens_total: 100,
      output_tokens_total: 10,
      reasoning_tokens: 20,
      cache_read_tokens: 120,
      cache_write_tokens: 0,
    });
    expect(problems.map((p) => p.field).sort()).toEqual(["cache_vs_input", "reasoning_vs_output"]);
  });

  it("reports nothing for internally consistent figures", () => {
    expect(validateUsageConsistency({
      api_type: "openai-responses",
      input_tokens_total: 1_000,
      output_tokens_total: 500,
      reasoning_tokens: 200,
      cache_read_tokens: 800,
      cache_write_tokens: null,
    })).toEqual([]);
  });
});

describe("extension fields do not poison derivation", () => {
  it("derives uncached input for standard Responses without any cache_write", () => {
    // cache_write is an extension there, so its absence means "not applicable",
    // not "unknown" — treating it as unknown returned null for healthy calls.
    expect(inputTokensUncached({
      api_type: "openai-responses",
      input_tokens_total: 10_000,
      cache_read_tokens: 7_000,
      cache_write_tokens: null,
    })).toBe(3_000);
  });

  it("still returns null when a REQUIRED cache figure is unreported", () => {
    expect(inputTokensUncached({
      api_type: "openai-responses",
      input_tokens_total: 10_000,
      cache_read_tokens: null,
      cache_write_tokens: 1_000,
    })).toBeNull();
  });
});

describe("hasTrustworthyUsage", () => {
  it("accepts provider-reported records", () => {
    expect(hasTrustworthyUsage({ usage_status: "reported", usage_source: "provider" })).toBe(true);
    expect(hasTrustworthyUsage({ usage_status: "partial", usage_source: "provider" })).toBe(true);
  });

  it("rejects placeholders and rebuilt history", () => {
    expect(hasTrustworthyUsage({ usage_status: "missing", usage_source: "sdk_default" })).toBe(false);
    expect(hasTrustworthyUsage({ usage_status: "unknown", usage_source: "rehydrated" })).toBe(false);
    expect(hasTrustworthyUsage({ usage_status: "unknown", usage_source: "unknown" })).toBe(false);
  });
});

// ── The five counter-examples the design is built around ────────────────────
// Each one makes a naive implementation record a zero it should have recorded
// as "unknown" — i.e. silently understate spend in exactly the direction that
// hides the problem we are hunting.
describe("counter-examples that must not be read as zero usage", () => {
  const base = {
    api_type: "openai-responses",
    input_tokens_total: 0,
    output_tokens_total: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  } satisfies Pick<LlmCallRecord,
    "api_type" | "input_tokens_total" | "output_tokens_total" | "reasoning_tokens" | "cache_read_tokens" | "cache_write_tokens">;

  it("1. a call that settled as `stop` but never got usage back", () => {
    // The stop reason is NOT the discriminator: pi can finish normally while the
    // provider reported nothing, leaving its pre-request zeros in place.
    const status = resolveUsageStatus(base.api_type, [], "sdk_default");
    expect(status).toBe("missing");
    expect(hasTrustworthyUsage({ usage_status: status, usage_source: "sdk_default" })).toBe(false);
  });

  it("2. initialisation zeros left behind by a failed or aborted call", () => {
    const status = resolveUsageStatus(base.api_type, [], "sdk_default");
    expect(status).toBe("missing");
  });

  it("3. history rebuilt without any handoff (eviction / missing local history)", () => {
    const status = resolveUsageStatus(base.api_type, RESPONSES_FULL, "rehydrated");
    expect(status).toBe("unknown");
  });

  it("4. rebuilt and real calls coexisting in one session are judged per record", () => {
    const rebuilt = resolveUsageStatus(base.api_type, RESPONSES_FULL, "rehydrated");
    const real = resolveUsageStatus(base.api_type, RESPONSES_FULL, "provider");
    expect(rebuilt).toBe("unknown");
    expect(real).toBe("reported");
  });

  it("5. an explicitly reported cache_read of 0 stays a real zero", () => {
    const status = resolveUsageStatus(base.api_type, RESPONSES_FULL, "provider");
    expect(status).toBe("reported");
    expect(hasTrustworthyUsage({ usage_status: status, usage_source: "provider" })).toBe(true);
    // and it survives derivation rather than collapsing to null
    expect(inputTokensUncached({ ...base, input_tokens_total: 120 })).toBe(120);
  });
});
