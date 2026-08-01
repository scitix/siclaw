/**
 * Admin "test this model" probe, with sibling-field self-correction.
 *
 * A model's max-tokens field name is not discoverable from configuration: the
 * same gateway accepts `max_tokens` for one model and rejects it for the next.
 * `resolveMaxTokensField` guesses from the model id, which covers today's
 * naming conventions and nothing else — a renamed id on an aggregator, or a
 * reasoning family that ships after this code, guesses wrong.
 *
 * So the probe tries the resolved field and, on failure, tries the other one.
 * It deliberately does NOT parse the error message to decide: gateways word
 * protocol rejections differently and inconsistently, whereas "the other one
 * works" is unambiguous. (Same conclusion sicore reached for the same gateway.)
 */

import {
  resolveMaxTokensField,
  type MaxTokensField,
  type ProviderCompatInput,
} from "../core/model-compat.js";
import { outboundProbeUrlGuard } from "./tracing-exporters.js";

const PROBE_TIMEOUT_MS = 15_000;
/**
 * OpenAI's reasoning models reject an output cap below 16 — and those are
 * precisely the models this probe exists to diagnose, so a smaller "cheap"
 * value would fail for a reason unrelated to the field name.
 */
const PROBE_MAX_TOKENS = 16;
/** Enough of the provider's error to act on, bounded so a chatty gateway can't flood the response. */
const MAX_ERROR_CHARS = 300;

export interface ProbeTarget {
  modelId: string;
  baseUrl: string;
  apiKey: string | null;
  apiType: string | null;
  /** Persisted override, or null for the inferred value. */
  maxTokensField: string | null;
}

export interface ProbeAttempt {
  ok: boolean;
  status: number;
  message: string;
  latencyMs: number;
}

export interface ModelTestResult extends ProbeAttempt {
  /** The field the model actually answered on (or the last one tried). */
  maxTokensField: MaxTokensField;
  /** True when the first choice failed and the sibling worked — caller should persist. */
  corrected: boolean;
}

export function usesAnthropicMessages(apiType: string | null | undefined): boolean {
  return (apiType ?? "").trim().toLowerCase().startsWith("anthropic");
}

export function siblingMaxTokensField(field: MaxTokensField): MaxTokensField {
  return field === "max_tokens" ? "max_completion_tokens" : "max_tokens";
}

/**
 * Whether `status` is the provider saying "this request was malformed" — the
 * only class of failure from which the field name can be inferred.
 *
 * `status: 0` (timeout / DNS / connection refused) is excluded because no
 * request was ever judged. 401/403 are excluded because a bad key rejects both
 * field names identically. 429 and 5xx are excluded because they are about
 * load, not shape, and are exactly when a second attempt is most likely to
 * succeed for a reason that has nothing to do with what we changed.
 */
export function isFieldRejection(status: number): boolean {
  if (status < 400 || status >= 500) return false;
  return status !== 401 && status !== 403 && status !== 429;
}

/**
 * Strip the provider's own credential out of echoed text. The key rides in a
 * header rather than the URL, so it should never appear — but some gateways
 * reflect request headers into their error payloads, and this response goes
 * straight to a browser.
 */
export function redactSecret(text: string, secret: string | null): string {
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join("[redacted]");
}

export function buildProbeRequest(
  target: ProbeTarget,
  field: MaxTokensField,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const base = target.baseUrl.replace(/\/+$/, "");
  const key = target.apiKey ?? "";
  const messages = [{ role: "user", content: "ping" }];

  if (usesAnthropicMessages(target.apiType)) {
    // The messages API names this field `max_tokens` unconditionally; `field`
    // is not consulted, which is why the caller skips the sibling retry here.
    return {
      url: `${base}/messages`,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: { model: target.modelId, max_tokens: PROBE_MAX_TOKENS, messages },
    };
  }

  return {
    url: `${base}/chat/completions`,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: { model: target.modelId, messages, [field]: PROBE_MAX_TOKENS },
  };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function probeModelOnce(
  target: ProbeTarget,
  field: MaxTokensField,
  fetchImpl: FetchLike = fetch,
): Promise<ProbeAttempt> {
  const guard = outboundProbeUrlGuard(target.baseUrl, { allowLoopback: true });
  if (!guard.ok) return { ok: false, status: 0, message: guard.error ?? "Blocked URL", latencyMs: 0 };

  const { url, headers, body } = buildProbeRequest(target, field);
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual",
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    if (resp.ok) return { ok: true, status: resp.status, message: "OK", latencyMs };

    let detail = "";
    try {
      detail = (await resp.text()).slice(0, MAX_ERROR_CHARS);
    } catch {
      // Body unreadable — the status alone is still actionable.
    }
    const suffix = detail ? `: ${redactSecret(detail, target.apiKey)}` : "";
    return { ok: false, status: resp.status, message: `HTTP ${resp.status}${suffix}`, latencyMs };
  } catch (err: any) {
    const latencyMs = Math.round(performance.now() - startedAt);
    // Node's fetch rejects every network failure as a bare "fetch failed"; the
    // actionable part (ENOTFOUND, ECONNREFUSED) hangs off .cause.
    const detail = err?.cause?.message ?? err?.message ?? String(err);
    const message = err?.name === "AbortError" ? "Request timed out" : detail;
    return { ok: false, status: 0, message: redactSecret(String(message), target.apiKey), latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the model, retrying once on the sibling max-tokens field.
 *
 * Pure with respect to storage: it reports `corrected` and leaves persistence
 * to the caller.
 */
export async function testModelWireConfig(
  target: ProbeTarget,
  provider: ProviderCompatInput,
  fetchImpl: FetchLike = fetch,
): Promise<ModelTestResult> {
  const first = resolveMaxTokensField(
    { id: target.modelId, maxTokensField: target.maxTokensField },
    provider,
  );
  const attempt = await probeModelOnce(target, first, fetchImpl);
  if (attempt.ok) return { ...attempt, maxTokensField: first, corrected: false };

  // Anthropic's field name is fixed, so there is no sibling to try — retrying
  // would send the identical request and report a misleading second failure.
  if (usesAnthropicMessages(target.apiType)) {
    return { ...attempt, maxTokensField: first, corrected: false };
  }

  // Only a request the provider REJECTED tells us anything about the field
  // name. A timeout, a refused connection, a 429 or a 5xx says nothing — and
  // because this probe PERSISTS a success, retrying on those turns a transient
  // blip into a permanent mis-configuration: the sibling attempt lands a second
  // later, the gateway is healthy again, and a model that was correct gets
  // pinned to the wrong field for every future turn.
  if (!isFieldRejection(attempt.status)) {
    return { ...attempt, maxTokensField: first, corrected: false };
  }

  const sibling = siblingMaxTokensField(first);
  const retry = await probeModelOnce(target, sibling, fetchImpl);
  if (retry.ok) {
    return {
      ...retry,
      maxTokensField: sibling,
      corrected: true,
      message: `Model responded on ${sibling} (auto-corrected from ${first})`,
    };
  }
  // Both failed: report the ORIGINAL failure. The sibling attempt was our
  // hypothesis, not the operator's configuration, so its error is noise.
  return { ...attempt, maxTokensField: first, corrected: false };
}
