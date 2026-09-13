import { describe, it, expect } from "vitest";
import { validateMeasurementBatch, validateMeasurement, MAX_MEASUREMENTS_PER_BATCH } from "./llm-call-validation.js";

const valid = () => ({
  call_id: "c1", prompt_id: "p1", kind: "agent",
  round: 1, attempt: 1, network_attempts: 1,
  provider: "example-gateway", model_id: "gpt-5", api_type: "openai-responses",
  usage_status: "reported", usage_source: "provider",
  // A COMPLETE openai-responses report: the contract requires all four.
  reported_fields: ["input", "output", "reasoning", "cache_read"],
  input_tokens_total: 10, output_tokens_total: 5,
  reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: null,
  payload_bytes: 100, payload_tokens_estimated: 25,
  request_snapshot: { system_sha256: "s", tools_sha256: "t", history_prefix_sha256: "h", history_message_count: 1, model_settings: {} },
  request_at: "2026-09-13T00:00:00.000Z", response_end_at: "2026-09-13T00:00:01.000Z",
  since_prev_ms: null, cost_micros: null,
});

describe("validateMeasurement", () => {
  it("accepts a well-formed measurement", () => {
    expect(validateMeasurement(valid())).toBeNull();
  });

  it("accepts an all-null record when nothing claims to have been reported", () => {
    // The honest shape of "we could not observe this call".
    expect(validateMeasurement({
      ...valid(),
      usage_status: "unknown", usage_source: "unknown", reported_fields: [],
      input_tokens_total: null, output_tokens_total: null, reasoning_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null,
      payload_bytes: null, payload_tokens_estimated: null,
    })).toBeNull();
  });

  it("refuses the false-trustworthy-zero shape", () => {
    // provider + reported + nothing named + all zeros: individually well-typed,
    // collectively impossible, and `hasTrustworthyUsage` would have banked it.
    expect(validateMeasurement({
      ...valid(),
      usage_status: "reported", usage_source: "provider", reported_fields: [],
      input_tokens_total: 0, output_tokens_total: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0,
    })).toMatch(/at least one reported field/);
  });

  it("refuses a reported status whose source is not the provider", () => {
    expect(validateMeasurement({ ...valid(), usage_status: "reported", usage_source: "rehydrated" }))
      .toMatch(/requires usage_source=provider/);
  });

  it("validates every status, not only `reported`", () => {
    // `provider + [input]` filed as `missing` asserts the provider said nothing
    // about a call where it demonstrably spoke.
    expect(validateMeasurement({
      ...valid(), usage_status: "missing", reported_fields: ["input"],
      output_tokens_total: null, reasoning_tokens: null, cache_read_tokens: null,
    })).toMatch(/contradicts/);
    // An unreadable-stream evidence row filed as `missing` makes the same claim.
    expect(validateMeasurement({
      ...valid(), usage_status: "missing", usage_source: "unknown", reported_fields: [],
      input_tokens_total: 100, output_tokens_total: null, reasoning_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null,
    })).toMatch(/contradicts/);
  });

  it("refuses a field named as reported but carrying no value", () => {
    expect(validateMeasurement({ ...valid(), reported_fields: ["input", "output", "reasoning", "cache_read", "cache_write"] }))
      .toMatch(/cache_write is in reported_fields/);
  });

  it("refuses `reported` that does not satisfy the protocol contract", () => {
    // Responses requires input+output+reasoning+cache_read; naming only two and
    // calling it complete is how a partial report gets banked as a full one.
    expect(validateMeasurement({
      ...valid(), reported_fields: ["input", "output"], reasoning_tokens: null, cache_read_tokens: null,
    })).toMatch(/contradicts the openai-responses contract/);
  });

  it("accepts the observer's evidence row: values kept, read marked untrustworthy", () => {
    // A stream that broke part-way. The producer keeps what it read and marks it
    // `unknown`; rejecting this made the receiver refuse the whole batch.
    expect(validateMeasurement({
      ...valid(),
      usage_status: "unknown", usage_source: "unknown", reported_fields: [],
      input_tokens_total: 100, output_tokens_total: null, reasoning_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null,
    })).toBeNull();
  });



  it("refuses a numeric-looking STRING rather than coercing it", () => {
    // Coercion is how an unknown quietly becomes a number; this endpoint must
    // never be the place that invents a value.
    expect(validateMeasurement({ ...valid(), input_tokens_total: "10" })).toMatch(/input_tokens_total/);
  });

  it("refuses NaN, Infinity and negative counts", () => {
    expect(validateMeasurement({ ...valid(), output_tokens_total: NaN })).toMatch(/output_tokens_total/);
    expect(validateMeasurement({ ...valid(), output_tokens_total: Infinity })).toMatch(/output_tokens_total/);
    expect(validateMeasurement({ ...valid(), output_tokens_total: -1 })).toMatch(/output_tokens_total/);
  });

  it("refuses an undefined token field, which is not the same as null", () => {
    const m: Record<string, unknown> = valid();
    delete m.input_tokens_total;
    expect(validateMeasurement(m)).toMatch(/input_tokens_total/);
  });

  it("refuses unknown enum values", () => {
    expect(validateMeasurement({ ...valid(), usage_status: "probably" })).toMatch(/usage_status/);
    expect(validateMeasurement({ ...valid(), usage_source: "vibes" })).toMatch(/usage_source/);
    expect(validateMeasurement({ ...valid(), kind: "other" })).toMatch(/kind/);
    expect(validateMeasurement({ ...valid(), reported_fields: ["input", "made_up"] })).toMatch(/reported_fields/);
  });

  it("refuses a priced row — P0 stores no cost", () => {
    expect(validateMeasurement({ ...valid(), cost_micros: 1234 })).toMatch(/cost_micros/);
  });

  it("requires the identifiers a row cannot be filed without", () => {
    expect(validateMeasurement({ ...valid(), call_id: "" })).toMatch(/call_id/);
    expect(validateMeasurement({ ...valid(), prompt_id: "" })).toMatch(/prompt_id/);
  });
});

describe("the optional request correlation", () => {
  it("accepts absent, null and an id — an older box must keep working", () => {
    expect(validateMeasurement(valid())).toBeNull();
    expect(validateMeasurement({ ...valid(), root_request_id: null })).toBeNull();
    expect(validateMeasurement({ ...valid(), root_request_id: "turn-abc" })).toBeNull();
  });

  it("refuses a value the column cannot hold, rather than letting it be truncated", () => {
    // A silently shortened id would correlate calls from different requests.
    expect(validateMeasurement({ ...valid(), root_request_id: "x".repeat(65) })).toMatch(/root_request_id/);
  });

  it("refuses an empty string — neither an id nor an absence", () => {
    expect(validateMeasurement({ ...valid(), root_request_id: "" })).toMatch(/root_request_id/);
    expect(validateMeasurement({ ...valid(), root_request_id: 7 })).toMatch(/root_request_id/);
  });

  it("holds parent_call_id to the same rules, and names the offending field", () => {
    expect(validateMeasurement({ ...valid(), parent_call_id: null })).toBeNull();
    expect(validateMeasurement({ ...valid(), parent_call_id: "call-1" })).toBeNull();
    expect(validateMeasurement({ ...valid(), parent_call_id: "" })).toMatch(/parent_call_id/);
    expect(validateMeasurement({ ...valid(), parent_call_id: "x".repeat(65) })).toMatch(/parent_call_id/);
  });
});

describe("the workload tag", () => {
  it("accepts absent and every registered value", () => {
    expect(validateMeasurement(valid())).toBeNull();
    for (const workload of ["conversation", "analysis", "knowledge_compile", "unattributed"]) {
      expect(validateMeasurement({ ...valid(), workload })).toBeNull();
    }
  });

  it("refuses an unregistered value instead of storing it", () => {
    // A second spelling splits an aggregate silently: the total still adds up,
    // one bucket is short, and nothing errors. Refusing at the boundary is the
    // only place that shows up.
    expect(validateMeasurement({ ...valid(), workload: "kb-compile" })).toMatch(/workload/);
    expect(validateMeasurement({ ...valid(), workload: "" })).toMatch(/workload/);
    expect(validateMeasurement({ ...valid(), workload: 3 })).toMatch(/workload/);
  });

  it("names the registered values, so a rejected producer can be fixed", () => {
    expect(validateMeasurement({ ...valid(), workload: "nope" })).toContain("knowledge_compile");
  });
});

describe("validateMeasurementBatch", () => {
  it("accepts a batch and hands back the typed value", () => {
    const result = validateMeasurementBatch({ session_id: "s1", measurements: [valid()] });
    expect(result.ok).toBe(true);
    expect(result.batch?.measurements).toHaveLength(1);
  });

  it("refuses a batch without a session", () => {
    expect(validateMeasurementBatch({ measurements: [valid()] }).error).toMatch(/session_id/);
  });

  it("refuses an oversized batch instead of truncating it", () => {
    const measurements = Array.from({ length: MAX_MEASUREMENTS_PER_BATCH + 1 }, () => valid());
    expect(validateMeasurementBatch({ session_id: "s1", measurements }).error).toMatch(/at most/);
  });

  it("names the offending index so a skewed sender is diagnosable", () => {
    const result = validateMeasurementBatch({
      session_id: "s1",
      measurements: [valid(), { ...valid(), usage_status: "nope" }],
    });
    expect(result.error).toMatch(/measurements\[1\]/);
  });

  it("refuses an empty batch and a non-object body", () => {
    expect(validateMeasurementBatch({ session_id: "s1", measurements: [] }).ok).toBe(false);
    expect(validateMeasurementBatch(null).ok).toBe(false);
    expect(validateMeasurementBatch("{}").ok).toBe(false);
  });
});
