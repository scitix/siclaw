#!/usr/bin/env node
/**
 * Gateway cache probe — the online half of the P0 metering verification.
 *
 * Sends a FIXED synthetic prompt through the real gateway several times and
 * reports what the provider says about caching each time. No cluster, no SRE
 * scenario, no model-quality judgement: the payload is deliberately boring and
 * identical across runs, because the only variable under study is the cache.
 *
 * It answers three questions the offline fixtures structurally cannot:
 *
 *   1. Which cache-retention shape does this deployment actually send?
 *      pi's default `short` sends NEITHER field; `long` may send
 *      `prompt_cache_retention: "24h"` OR `prompt_cache_options.ttl=30m`,
 *      depending on a compat branch. Guessing is not allowed — we read the body.
 *   2. Does a warm repeat actually report cache reads, i.e. is the gateway's
 *      cache path wired at all?
 *   3. Does appending to the history keep the prefix warm, and does rewriting
 *      an old message kill it?
 *
 * ⚠️ A 200 means the gateway ACCEPTED the request. It does not mean the cache
 * worked, and a warm hit minutes apart does not prove a long TTL was honoured —
 * that needs a probe separated by longer than the short-TTL window.
 *
 * Usage:
 *   SICLAW_PROBE_BASE_URL=https://gateway.example/v1 \
 *   SICLAW_PROBE_API_KEY=...                          \
 *   SICLAW_PROBE_MODEL=gpt-5                          \
 *   node scripts/smoke/token-cache-probe.mjs [--json out.json]
 *
 * Exits non-zero only on a transport/config failure — an absent cache is a
 * RESULT to be reported, not an error.
 */

const BASE_URL = process.env.SICLAW_PROBE_BASE_URL;
const API_KEY = process.env.SICLAW_PROBE_API_KEY;
const MODEL = process.env.SICLAW_PROBE_MODEL ?? "gpt-5";
const RETENTION = process.env.SICLAW_PROBE_RETENTION ?? "";

if (!BASE_URL || !API_KEY) {
  console.error("Set SICLAW_PROBE_BASE_URL and SICLAW_PROBE_API_KEY. Nothing was sent.");
  process.exit(2);
}

/** Padding large enough to clear the minimum any prefix cache will bother with. */
const FILLER = "The quick brown fox jumps over the lazy dog. ".repeat(200);

const baseInput = [
  { role: "system", content: `You are a fixture. Reply with the single word OK.\n${FILLER}` },
  { role: "user", content: "Say OK." },
];

/**
 * Build the retention fields exactly as pi would for a given mode, so the probe
 * measures the shapes the runtime can actually emit rather than invented ones.
 */
function retentionFields(mode) {
  if (mode === "24h") return { prompt_cache_retention: "24h" };
  if (mode === "ttl_30m") return { prompt_cache_options: { ttl: "30m" } };
  return {}; // pi's default `short` sends neither
}

async function probe(label, { input, cacheKey, retentionMode }) {
  const body = {
    model: MODEL,
    input,
    store: false,
    max_output_tokens: 16,
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    ...retentionFields(retentionMode),
  };
  const startedAt = Date.now();
  const response = await fetch(`${BASE_URL.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let usage = null;
  try {
    usage = JSON.parse(text)?.usage ?? null;
  } catch { /* keep raw below */ }

  const cachedTokens = usage?.input_tokens_details?.cached_tokens;
  return {
    label,
    ok: response.ok,
    status: response.status,
    elapsed_ms: Date.now() - startedAt,
    sent_retention_fields: Object.keys(retentionFields(retentionMode)),
    prompt_cache_key: cacheKey ?? null,
    // Absent is recorded as null, never 0 — the same rule the records follow.
    input_tokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : null,
    output_tokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : null,
    cached_tokens: typeof cachedTokens === "number" ? cachedTokens : null,
    usage_reported: usage !== null,
    ...(response.ok ? {} : { error_excerpt: text.slice(0, 300) }),
  };
}

const results = [];
const key = `siclaw-probe-${Date.now()}`;

// 1. Cold: first time this prefix is seen.
results.push(await probe("cold", { input: baseInput, cacheKey: key, retentionMode: RETENTION }));
// 2. Warm: byte-identical repeat — the only run that can show a cache read.
results.push(await probe("warm_identical", { input: baseInput, cacheKey: key, retentionMode: RETENTION }));
// 3. Append: prefix unchanged, one message added.
results.push(await probe("warm_appended", {
  input: [...baseInput, { role: "user", content: "And again." }],
  cacheKey: key,
  retentionMode: RETENTION,
}));
// 4. Rewrite: an OLD message changed — the prefix should be dead.
results.push(await probe("rewritten_prefix", {
  input: [{ role: "system", content: `Different system prompt.\n${FILLER}` }, ...baseInput.slice(1)],
  cacheKey: key,
  retentionMode: RETENTION,
}));
// 5. No cache key at all — isolates what the key itself contributes.
results.push(await probe("no_cache_key", { input: baseInput, cacheKey: null, retentionMode: RETENTION }));

const warm = results.find((r) => r.label === "warm_identical");
const report = {
  probed_at: new Date().toISOString(),
  model: MODEL,
  retention_mode: RETENTION || "default(short: sends neither field)",
  results,
  findings: {
    gateway_reports_usage: results.some((r) => r.usage_reported),
    // Explicitly three-valued: null means the gateway never reported the field,
    // which is different from reporting a zero.
    cache_read_observed: warm?.cached_tokens === null ? null : (warm?.cached_tokens ?? 0) > 0,
    caveat: "A 200 only means the request was accepted. A warm hit here does NOT prove a long TTL was honoured; that needs a repeat separated by more than the short-TTL window.",
  },
};

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.argv[jsonFlag + 1], JSON.stringify(report, null, 2));
  console.log(`Wrote ${process.argv[jsonFlag + 1]}`);
} else {
  console.log(JSON.stringify(report, null, 2));
}

if (!results.every((r) => r.ok)) process.exit(1);
