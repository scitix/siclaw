import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb, closeDb, getDb } from "../gateway/db.js";
import { runPortalMigrations } from "./migrate.js";
import { persistLlmCallMeasurements } from "./llm-call-repo.js";
import type { LlmCallMeasurement, LlmCallAttribution } from "../shared/llm-call-record.js";

const attribution: LlmCallAttribution = {
  session_id: "sess-1", org_id: "org-1", user_id: "user-1",
  agent_id: "agent-1", agent_type: "sre", session_origin: "web",
  root_request_id: null, parent_call_id: null,
};

const measurement = (callId: string, over: Partial<LlmCallMeasurement> = {}): LlmCallMeasurement => ({
  call_id: callId, prompt_id: "p1", kind: "agent",
  round: 1, attempt: 1, network_attempts: 1,
  provider: "example-gateway", model_id: "gpt-5", api_type: "openai-responses",
  usage_status: "reported", usage_source: "provider",
  reported_fields: ["input", "output"],
  input_tokens_total: 1_000, output_tokens_total: 200,
  reasoning_tokens: null, cache_read_tokens: 0, cache_write_tokens: null,
  payload_bytes: 900, payload_tokens_estimated: 225,
  request_snapshot: {
    model_settings: {}, system_sha256: "s", tools_sha256: "t",
    history_prefix_sha256: "h", history_message_count: 3,
  },
  request_at: "2026-09-13T00:00:00.000Z", response_end_at: "2026-09-13T00:00:01.000Z",
  since_prev_ms: null, cost_micros: null, inconsistencies: [],
  ...over,
});

describe("persistLlmCallMeasurements", () => {
  beforeEach(async () => {
    initDb("sqlite::memory:");
    await runPortalMigrations();
  });
  afterEach(async () => { await closeDb(); });

  it("writes a row per call", async () => {
    const result = await persistLlmCallMeasurements(getDb(), attribution, [measurement("c1"), measurement("c2")]);
    expect(result).toEqual({ inserted: 2, duplicates: 0 });
  });

  it("is idempotent on call_id — a redelivery cannot double-count", async () => {
    // The sender holds no "already delivered" state, so this is the only place
    // a retried batch can be made harmless.
    await persistLlmCallMeasurements(getDb(), attribution, [measurement("c1")]);
    const again = await persistLlmCallMeasurements(getDb(), attribution, [measurement("c1")]);
    expect(again).toEqual({ inserted: 0, duplicates: 1 });

    const [rows] = await getDb().query<Array<{ n: number }>>("SELECT COUNT(*) AS n FROM llm_calls");
    expect(Number(rows[0].n)).toBe(1);
  });

  it("preserves NULL and 0 as different values", async () => {
    // The whole pipeline exists to keep these apart: 0 is a reported zero,
    // NULL is "the provider never said".
    await persistLlmCallMeasurements(getDb(), attribution, [
      measurement("c1", { cache_read_tokens: 0, cache_write_tokens: null, reasoning_tokens: null }),
    ]);
    const [rows] = await getDb().query<Array<Record<string, unknown>>>(
      "SELECT cache_read_tokens, cache_write_tokens, reasoning_tokens FROM llm_calls WHERE call_id = 'c1'",
    );
    expect(Number(rows[0].cache_read_tokens)).toBe(0);
    expect(rows[0].cache_write_tokens).toBeNull();
    expect(rows[0].reasoning_tokens).toBeNull();
  });

  it("stores attribution the box was not allowed to assert", async () => {
    await persistLlmCallMeasurements(getDb(), attribution, [measurement("c1")]);
    const [rows] = await getDb().query<Array<Record<string, unknown>>>(
      "SELECT session_id, user_id, agent_id FROM llm_calls WHERE call_id = 'c1'",
    );
    expect(rows[0]).toMatchObject({ session_id: "sess-1", user_id: "user-1", agent_id: "agent-1" });
  });

  it("never writes a cost while prices are unverified", async () => {
    await persistLlmCallMeasurements(getDb(), attribution, [measurement("c1")]);
    const [rows] = await getDb().query<Array<{ cost_micros: unknown }>>(
      "SELECT cost_micros FROM llm_calls WHERE call_id = 'c1'",
    );
    expect(rows[0].cost_micros).toBeNull();
  });

  it("keeps inconsistencies as evidence, and omits them when there are none", async () => {
    await persistLlmCallMeasurements(getDb(), attribution, [
      measurement("c1", { inconsistencies: [{ field: "cache_vs_input", detail: "cached 120 exceeds input total 100" }] }),
      measurement("c2"),
    ]);
    const [rows] = await getDb().query<Array<{ call_id: string; inconsistencies: string | null }>>(
      "SELECT call_id, inconsistencies FROM llm_calls ORDER BY call_id",
    );
    expect(rows[0].inconsistencies).toContain("cache_vs_input");
    expect(rows[1].inconsistencies).toBeNull();
  });

  it("takes the request correlation from the producer, not from attribution", async () => {
    // Only the box knows which turn a call served. The attribution carried by the
    // receiver cannot tell one request from the next within a conversation, so a
    // measurement that names its own request must win over it.
    await persistLlmCallMeasurements(getDb(), attribution, [
      measurement("c1", { root_request_id: "turn-abc" }),
    ]);
    const [rows] = await getDb().query<Array<{ root_request_id: unknown }>>(
      "SELECT root_request_id FROM llm_calls WHERE call_id = 'c1'",
    );
    expect(rows[0].root_request_id).toBe("turn-abc");
  });

  it("stores NULL when an older box sends no correlation", async () => {
    await persistLlmCallMeasurements(getDb(), attribution, [measurement("c1")]);
    const [rows] = await getDb().query<Array<{ root_request_id: unknown; parent_call_id: unknown }>>(
      "SELECT root_request_id, parent_call_id FROM llm_calls WHERE call_id = 'c1'",
    );
    expect(rows[0].root_request_id).toBeNull();
    expect(rows[0].parent_call_id).toBeNull();
  });

  it("keeps which call dispatched a sub-agent, separately from which request it served", async () => {
    // A shared root says the calls belong to one request; it cannot say WHICH of
    // the parent's calls spawned the child. Both come from the producer.
    await persistLlmCallMeasurements(getDb(), attribution, [
      measurement("c1", { root_request_id: "turn-abc", parent_call_id: "call-round-2" }),
    ]);
    const [rows] = await getDb().query<Array<{ root_request_id: unknown; parent_call_id: unknown }>>(
      "SELECT root_request_id, parent_call_id FROM llm_calls WHERE call_id = 'c1'",
    );
    expect(rows[0]).toMatchObject({ root_request_id: "turn-abc", parent_call_id: "call-round-2" });
  });

  it("records an untagged producer as unattributed, not as conversation", async () => {
    // Folding an un-taught producer into conversation would let a whole new
    // subsystem's spend show up as chat growth, with nothing to notice.
    await persistLlmCallMeasurements(getDb(), attribution, [
      measurement("c1"),                                  // older box: no tag
      measurement("c2", { workload: "knowledge_compile" }),
    ]);
    const [rows] = await getDb().query<Array<{ call_id: string; workload: string }>>(
      "SELECT call_id, workload FROM llm_calls ORDER BY call_id",
    );
    expect(rows[0]).toMatchObject({ call_id: "c1", workload: "unattributed" });
    expect(rows[1]).toMatchObject({ call_id: "c2", workload: "knowledge_compile" });
  });

  it("keeps the request fingerprint for cache-stability analysis", async () => {
    await persistLlmCallMeasurements(getDb(), attribution, [
      measurement("c1", {
        request_snapshot: {
          model_settings: { model: "gpt-5" }, system_sha256: "sys", tools_sha256: "tools",
          history_prefix_sha256: "prefix", history_message_count: 3, payload_sha256: "payload",
          prompt_cache_key: "key-1", cache_retention_sent: "24h",
        },
      }),
    ]);
    const [rows] = await getDb().query<Array<{ request_snapshot: string }>>(
      "SELECT request_snapshot FROM llm_calls WHERE call_id = 'c1'",
    );
    const snapshot = JSON.parse(rows[0].request_snapshot);
    expect(snapshot).toMatchObject({ payload_sha256: "payload", prompt_cache_key: "key-1", cache_retention_sent: "24h" });
  });
});
