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
  resolveModelApi,
  type MaxTokensField,
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
  /** The MODEL's own api_type. Protocol is per-model; the provider's value is
   *  only a read-time floor for legacy rows (see `resolveModelApi`). */
  apiType: string | null;
  providerApiType?: string | null;
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
  /** The protocol the model actually answered on (or the last one tried). */
  apiType: string;
  /** The field the model actually answered on (or the last one tried). */
  maxTokensField: MaxTokensField;
  /** Set when a sibling attempt worked — the caller persists that column. */
  correctedApiType: boolean;
  correctedMaxTokensField: boolean;
}

/**
 * The other protocol to try. Only the two siclaw supports are paired; an
 * unrecognised api id (pi gains new ones without a siclaw release) has no
 * known sibling, so it is left alone rather than guessed at.
 */
export function siblingApiType(api: string): string | undefined {
  if (api === "openai-completions") return "anthropic-messages";
  if (api === "anthropic-messages") return "openai-completions";
  return undefined;
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
  api: string,
  field: MaxTokensField,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const base = target.baseUrl.replace(/\/+$/, "");
  const key = target.apiKey ?? "";
  const messages = [{ role: "user", content: "ping" }];

  if (usesAnthropicMessages(api)) {
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
  api: string,
  field: MaxTokensField,
  fetchImpl: FetchLike = fetch,
): Promise<ProbeAttempt> {
  const guard = outboundProbeUrlGuard(target.baseUrl, { allowLoopback: true });
  if (!guard.ok) return { ok: false, status: 0, message: guard.error ?? "Blocked URL", latencyMs: 0 };

  const { url, headers, body } = buildProbeRequest(target, api, field);
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
 * Probe the model and, on a shape rejection, try the siblings once each.
 *
 * Two attributes decide whether a request is even well-formed, and neither is
 * discoverable from configuration: the wire protocol, and the name of the
 * output-token field. Both are per-model, both are settable in Portal, and both
 * are wrong often enough that "read the error and work it out" is the operator
 * experience we are trying to delete.
 *
 * The ladder tries the PROTOCOL first: it decides the endpoint and the whole
 * body shape, so a protocol mismatch makes the field name moot. Deliberately no
 * error-message parsing at any step — gateways word these rejections
 * differently and inconsistently, whereas "the other one works" is unambiguous.
 * (Same conclusion sicore reached against this same gateway.)
 *
 * Pure with respect to storage: it reports which attribute was corrected and
 * leaves persistence to the caller.
 */
export async function testModelWireConfig(
  target: ProbeTarget,
  fetchImpl: FetchLike = fetch,
): Promise<ModelTestResult> {
  const api = resolveModelApi(
    { model_id: target.modelId, api_type: target.apiType, context_window: 0, max_tokens: 0 },
    { api: target.providerApiType },
  );
  const field = resolveMaxTokensField(
    { id: target.modelId, maxTokensField: target.maxTokensField },
    { api },
  );
  const unchanged = { apiType: api, maxTokensField: field, correctedApiType: false, correctedMaxTokensField: false };

  const attempt = await probeModelOnce(target, api, field, fetchImpl);
  if (attempt.ok) return { ...attempt, ...unchanged };

  // Only a request the provider REJECTED tells us anything about how it was
  // shaped. A timeout, a refused connection, a 429 or a 5xx says nothing — and
  // because a successful sibling is PERSISTED, retrying on those turns a
  // transient blip into a permanent mis-configuration: the second attempt lands
  // a moment later against a recovered gateway and pins a model that was
  // already correct.
  if (!isFieldRejection(attempt.status)) return { ...attempt, ...unchanged };

  // 1. Wrong protocol. `claude-sonnet-5` on an OpenAI-protocol gateway is the
  //    motivating case: the endpoint and body are both wrong, so nothing about
  //    the field name could have been learned from that failure.
  const altApi = siblingApiType(api);
  if (altApi) {
    // The messages API names its cap `max_tokens` unconditionally, so the
    // sibling protocol brings its own natural field rather than inheriting one
    // that only means something under chat-completions.
    const altField: MaxTokensField = usesAnthropicMessages(altApi) ? "max_tokens" : field;
    const viaAltApi = await probeModelOnce(target, altApi, altField, fetchImpl);
    if (viaAltApi.ok) {
      return {
        ...viaAltApi,
        apiType: altApi,
        maxTokensField: altField,
        correctedApiType: true,
        correctedMaxTokensField: altField !== field,
        message: `Model responded on ${altApi} (auto-corrected from ${api})`,
      };
    }
  }

  // 2. Right protocol, wrong field name. Only chat-completions has a choice.
  if (!usesAnthropicMessages(api)) {
    const altField = siblingMaxTokensField(field);
    const viaAltField = await probeModelOnce(target, api, altField, fetchImpl);
    if (viaAltField.ok) {
      return {
        ...viaAltField,
        apiType: api,
        maxTokensField: altField,
        correctedApiType: false,
        correctedMaxTokensField: true,
        message: `Model responded on ${altField} (auto-corrected from ${field})`,
      };
    }
  }

  // Nothing worked: report the ORIGINAL failure. The siblings were our
  // hypotheses, not the operator's configuration, so their errors are noise.
  return { ...attempt, ...unchanged };
}
