/**
 * Aggregation is where the write side's carefully preserved distinctions get
 * destroyed, so these run against a REAL database rather than a stub: the two
 * failures that matter (SUM skipping NULLs, and protocols disagreeing on what
 * `input_tokens` covers) are properties of the SQL, not of the TypeScript.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb, closeDb, getDb } from "../gateway/db.js";
import { runPortalMigrations } from "./migrate.js";
import { persistLlmCallMeasurements } from "./llm-call-repo.js";
import { usageByModel, usageByActor } from "./llm-usage-repo.js";
import type { LlmCallMeasurement, LlmCallAttribution } from "../shared/llm-call-record.js";

const WINDOW = { from: new Date("2026-09-01T00:00:00.000Z"), to: new Date("2026-09-30T00:00:00.000Z") };

const attribution = (over: Partial<LlmCallAttribution> = {}): LlmCallAttribution => ({
  session_id: "sess-1", org_id: "", user_id: "user-1",
  agent_id: "agent-1", agent_type: "sre", session_origin: "web",
  root_request_id: null, parent_call_id: null,
  ...over,
});

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

async function session(id: string, row: Partial<{
  user_id: string; origin: string; sender_external_id: string | null; parent_session_id: string | null;
}> = {}): Promise<void> {
  await getDb().query(
    `INSERT INTO chat_sessions (id, agent_id, user_id, origin, sender_external_id, parent_session_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, "agent-1", row.user_id ?? "user-1", row.origin ?? "web",
     row.sender_external_id ?? null, row.parent_session_id ?? null],
  );
}

describe("usageByModel", () => {
  beforeEach(async () => { initDb("sqlite::memory:"); await runPortalMigrations(); });
  afterEach(async () => { await closeDb(); });

  it("ranks provider × model by charged tokens, heaviest first", async () => {
    await persistLlmCallMeasurements(getDb(), attribution(), [
      measurement("c1", { model_id: "small", input_tokens_total: 100, output_tokens_total: 10 }),
      measurement("c2", { model_id: "big", input_tokens_total: 9_000, output_tokens_total: 900 }),
      measurement("c3", { model_id: "mid", input_tokens_total: 1_000, output_tokens_total: 100 }),
    ]);

    const { groups } = await usageByModel(getDb(), WINDOW);
    expect(groups.map((g) => g.modelId)).toEqual(["big", "mid", "small"]);
    expect(groups[0]).toMatchObject({ provider: "example-gateway", calls: 1, billable: 9_900 });
  });

  it("keeps each protocol's own arithmetic — cache is inside input on one, beside it on the other", async () => {
    // The same five numbers mean different totals per protocol. Summing the
    // columns uniformly would double-count 500 cached tokens on the first row.
    await persistLlmCallMeasurements(getDb(), attribution(), [
      measurement("c1", {
        api_type: "openai-responses", model_id: "m-a",
        input_tokens_total: 1_000, output_tokens_total: 100,
        cache_read_tokens: 500, cache_write_tokens: null,
      }),
      measurement("c2", {
        api_type: "anthropic-messages", model_id: "m-b",
        input_tokens_total: 1_000, output_tokens_total: 100,
        cache_read_tokens: 500, cache_write_tokens: 0,
      }),
    ]);

    const { groups } = await usageByModel(getDb(), WINDOW);
    const byModel = Object.fromEntries(groups.map((g) => [g.modelId, g.billable]));
    expect(byModel["m-a"]).toBe(1_100);   // cache already counted inside input
    expect(byModel["m-b"]).toBe(1_600);   // cache charged on top of input
  });

  it("reports the basis of every sum, because SUM silently skips what was never reported", async () => {
    await persistLlmCallMeasurements(getDb(), attribution(), [
      measurement("c1", { reasoning_tokens: 50 }),
      measurement("c2", { reasoning_tokens: null }), // provider never reported it
    ]);

    const [group] = (await usageByModel(getDb(), WINDOW)).groups;
    expect(group.calls).toBe(2);
    expect(group.reasoning.total).toBe(50);
    // The number is over ONE of two calls. Without this a reader would take 50
    // as the window's reasoning total.
    expect(group.reasoning.reportedCalls).toBe(1);
    expect(group.input.reportedCalls).toBe(2);
  });

  it("returns null, not zero, for a field no call reported", async () => {
    await persistLlmCallMeasurements(getDb(), attribution(), [measurement("c1", { cache_write_tokens: null })]);
    const [group] = (await usageByModel(getDb(), WINDOW)).groups;
    expect(group.cacheWrite.total).toBeNull();
    expect(group.cacheWrite.reportedCalls).toBe(0);
    // A reported zero stays a zero — the distinction the whole pipeline exists for.
    expect(group.cacheRead.total).toBe(0);
    expect(group.cacheRead.reportedCalls).toBe(1);
  });

  it("excludes untrustworthy rows from the sums and says how many it excluded", async () => {
    // An SDK-default row is all zeros. Summing it would quietly deflate the
    // averages and make coverage look complete.
    await persistLlmCallMeasurements(getDb(), attribution(), [
      measurement("c1", { input_tokens_total: 1_000, output_tokens_total: 100 }),
      measurement("c2", {
        usage_source: "sdk_default", usage_status: "missing", reported_fields: [],
        input_tokens_total: null, output_tokens_total: null, cache_read_tokens: null,
      }),
      measurement("c3", {
        usage_source: "unknown", usage_status: "unknown", reported_fields: [],
        input_tokens_total: null, output_tokens_total: null, cache_read_tokens: null,
      }),
    ]);

    const { groups, coverage } = await usageByModel(getDb(), WINDOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].calls).toBe(1);
    expect(coverage).toEqual({ trustworthy: 1, excluded: 2 });
  });

  it("sorts an unpriceable group last rather than treating unknown as zero", async () => {
    await persistLlmCallMeasurements(getDb(), attribution(), [
      measurement("c1", { model_id: "known", input_tokens_total: 10, output_tokens_total: 1 }),
      // Reported something, but not output — so the total cannot be computed.
      measurement("c2", {
        model_id: "unpriceable", usage_status: "partial", reported_fields: ["input"],
        input_tokens_total: 999_999, output_tokens_total: null, cache_read_tokens: null,
      }),
    ]);

    const { groups } = await usageByModel(getDb(), WINDOW);
    expect(groups.map((g) => g.modelId)).toEqual(["known", "unpriceable"]);
    expect(groups[1].billable).toBeNull();
  });

  it("honours the window", async () => {
    await persistLlmCallMeasurements(getDb(), attribution(), [
      measurement("c1", { request_at: "2026-08-01T00:00:00.000Z" }),
      measurement("c2", { request_at: "2026-09-13T00:00:00.000Z" }),
    ]);
    const { groups, coverage } = await usageByModel(getDb(), WINDOW);
    expect(groups[0].calls).toBe(1);
    expect(coverage.trustworthy).toBe(1);
  });
});

describe("usageByActor", () => {
  beforeEach(async () => { initDb("sqlite::memory:"); await runPortalMigrations(); });
  afterEach(async () => { await closeDb(); });

  it("attributes a channel turn to the sender, not to the owning account", async () => {
    await session("chan-1", { origin: "channel", sender_external_id: "ou_alice", user_id: "svc-account" });
    await persistLlmCallMeasurements(getDb(), attribution({ session_id: "chan-1" }), [
      measurement("c1", { input_tokens_total: 1_000, output_tokens_total: 100 }),
    ]);

    const { actors } = await usageByActor(getDb(), WINDOW);
    expect(actors).toHaveLength(1);
    expect(actors[0]).toMatchObject({ kind: "channel", id: "ou_alice", calls: 1, billable: 1_100 });
  });

  it("breaks each actor down by field, so a cache-heavy user is visible as such", async () => {
    await session("s-a", { user_id: "user-a" });
    await persistLlmCallMeasurements(getDb(), attribution({ session_id: "s-a" }), [
      measurement("c1", {
        input_tokens_total: 1_000, output_tokens_total: 100,
        cache_read_tokens: 400, cache_write_tokens: 600,
      }),
      measurement("c2", {
        input_tokens_total: 2_000, output_tokens_total: 200,
        cache_read_tokens: 100, cache_write_tokens: null, // never reported
      }),
    ]);

    const [actor] = (await usageByActor(getDb(), WINDOW)).actors;
    expect(actor.input).toEqual({ total: 3_000, reportedCalls: 2 });
    expect(actor.output).toEqual({ total: 300, reportedCalls: 2 });
    expect(actor.cacheRead).toEqual({ total: 500, reportedCalls: 2 });
    // Summed over ONE call — the count says so rather than the number pretending
    // to cover both.
    expect(actor.cacheWrite).toEqual({ total: 600, reportedCalls: 1 });
  });

  it("ranks by the requested metric, not always by the total", async () => {
    await session("s-a", { user_id: "heavy-total" });
    await session("s-b", { user_id: "heavy-cache-write" });
    await persistLlmCallMeasurements(getDb(), attribution({ session_id: "s-a" }), [
      measurement("c1", { input_tokens_total: 9_000, output_tokens_total: 900, cache_write_tokens: 1 }),
    ]);
    await persistLlmCallMeasurements(getDb(), attribution({ session_id: "s-b" }), [
      measurement("c2", { input_tokens_total: 100, output_tokens_total: 10, cache_write_tokens: 5_000 }),
    ]);

    const byTotal = await usageByActor(getDb(), WINDOW);
    expect(byTotal.actors.map((a) => a.id)).toEqual(["heavy-total", "heavy-cache-write"]);

    const byCacheWrite = await usageByActor(getDb(), { ...WINDOW, sort: "cacheWrite" });
    expect(byCacheWrite.actors.map((a) => a.id)).toEqual(["heavy-cache-write", "heavy-total"]);
  });

  it("applies the cap AFTER the requested ranking", async () => {
    // The reason sorting is server-side: with the cap applied first, "top by
    // cache write" would be computed over rows chosen by a different metric.
    await session("s-a", { user_id: "big-total" });
    await session("s-b", { user_id: "big-cache-write" });
    await persistLlmCallMeasurements(getDb(), attribution({ session_id: "s-a" }), [
      measurement("c1", { input_tokens_total: 9_000, output_tokens_total: 900, cache_write_tokens: 0 }),
    ]);
    await persistLlmCallMeasurements(getDb(), attribution({ session_id: "s-b" }), [
      measurement("c2", { input_tokens_total: 10, output_tokens_total: 1, cache_write_tokens: 7_000 }),
    ]);

    const top1 = await usageByActor(getDb(), { ...WINDOW, sort: "cacheWrite", limit: 1 });
    expect(top1.actors.map((a) => a.id)).toEqual(["big-cache-write"]);
  });

  it("bills a sub-agent's calls to the actor who asked, not to the child session", async () => {
    // This is the spend Portal never saw at all. A child session carries no
    // sender of its own, so without the parent hop it would vanish from every
    // channel figure the moment someone filtered by sender.
    await session("chan-1", { origin: "channel", sender_external_id: "ou_alice" });
    await session("child-1", { origin: "subagent", sender_external_id: null, parent_session_id: "chan-1" });
    await persistLlmCallMeasurements(getDb(), attribution({ session_id: "chan-1" }), [
      measurement("c1", { input_tokens_total: 1_000, output_tokens_total: 100 }),
    ]);
    await persistLlmCallMeasurements(getDb(), attribution({ session_id: "child-1" }), [
      measurement("c2", { input_tokens_total: 5_000, output_tokens_total: 500 }),
    ]);

    const { actors } = await usageByActor(getDb(), WINDOW);
    expect(actors).toHaveLength(1);
    expect(actors[0]).toMatchObject({ kind: "channel", id: "ou_alice", calls: 2, billable: 6_600 });
  });

  it("ranks actors by spend, heaviest first", async () => {
    await session("s-a", { user_id: "user-a" });
    await session("s-b", { user_id: "user-b" });
    await persistLlmCallMeasurements(getDb(), attribution({ session_id: "s-a" }), [
      measurement("c1", { input_tokens_total: 100, output_tokens_total: 10 }),
    ]);
    await persistLlmCallMeasurements(getDb(), attribution({ session_id: "s-b" }), [
      measurement("c2", { input_tokens_total: 9_000, output_tokens_total: 900 }),
    ]);

    const { actors } = await usageByActor(getDb(), WINDOW);
    expect(actors.map((a) => a.id)).toEqual(["user-b", "user-a"]);
  });

  it("marks an actor whose calls span protocols, and refuses a half-known total", async () => {
    await session("s-a", { user_id: "user-a" });
    await persistLlmCallMeasurements(getDb(), attribution({ session_id: "s-a" }), [
      measurement("c1", { api_type: "openai-responses", input_tokens_total: 1_000, output_tokens_total: 100 }),
      measurement("c2", {
        api_type: "anthropic-messages", input_tokens_total: 1_000, output_tokens_total: 100,
        cache_read_tokens: 500, cache_write_tokens: 0,
      }),
    ]);

    const { actors } = await usageByActor(getDb(), WINDOW);
    expect(actors[0]).toMatchObject({ id: "user-a", calls: 2, billable: 2_700, mixedProtocols: true });
  });

  it("does not invent an actor for a row whose session is gone", async () => {
    // No chat_sessions row at all: the join yields nothing, and an empty actor
    // id would otherwise collect every orphan under one meaningless bucket.
    await persistLlmCallMeasurements(getDb(), attribution({ session_id: "vanished" }), [measurement("c1")]);
    const { actors, coverage } = await usageByActor(getDb(), WINDOW);
    expect(actors).toEqual([]);
    // …but the call is still counted as observed, so coverage stays honest.
    expect(coverage.trustworthy).toBe(1);
  });
});
