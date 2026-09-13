/**
 * Observes the provider's RAW usage report at the HTTP boundary.
 *
 * Why this exists: pi normalises usage into an object whose input/output/
 * cacheRead/cacheWrite are REQUIRED and zero-filled before the request goes
 * out. By the time a response reaches the streamFn boundary, "the provider
 * reported 0" and "the provider reported nothing" are byte-identical, and the
 * optional `reasoning` field is not a usable discriminator either (a fixture
 * reporting only `input_tokens` came back with reasoning set to 0).
 *
 * The only place the truth still exists is the wire. pi accepts a per-call
 * `options.fetch` (`FetchFunction`, a public input), so this module composes
 * one: it tees the response body, hands the SDK the original bytes untouched,
 * and parses its own copy.
 *
 * Three contracts this file must never break:
 *
 *   1. PASSTHROUGH IS EXACT. The SDK receives the original byte stream. We never
 *      re-encode or re-chunk it — decoding happens only on our own branch of the
 *      tee, with a streaming decoder.
 *   2. OBSERVATION NEVER FAILS THE CALL. Any error yields an observation marked
 *      `failed` and the request proceeds.
 *   3. FAILURE IS NOT SILENCE. "We could not read the response" and "the server
 *      reported no usage" are different facts and must not collapse into one:
 *      only the latter licenses `missing`, the former is `unknown`.
 */

import { createHash } from "node:crypto";
import type { UsageField } from "../shared/llm-call-record.js";

/**
 * What happened when we tried to read one response.
 *
 * `no_usage` is a POSITIVE finding — we read the body and it genuinely carried
 * no usage. `failed` means we do not know, and the caller must not conclude the
 * provider stayed silent.
 */
export type ObservationOutcome = "reported" | "no_usage" | "failed";

/** What the server actually put on the wire for one HTTP attempt. */
export interface RawUsageObservation {
  outcome: ObservationOutcome;
  /** Usage keys genuinely present — the basis for `reported_fields`. */
  reported_fields: UsageField[];
  /** Values as sent. A key absent here was not reported; it is NOT zero. */
  values: Partial<Record<UsageField, number>>;
  /** Bytes of the request body, when it could be measured. */
  request_bytes?: number;
  /** Cache-control fields as actually sent — evidence, not assumption. */
  request_cache?: RequestCacheFacts;
  /** Fingerprints of the request as it actually went out (hashes only). */
  request_fingerprint?: ReturnType<typeof fingerprintRequestBody>;
}

/** Cache-related fields read off the OUTGOING request body. */
export interface RequestCacheFacts {
  /** `prompt_cache_key` as sent, or null when the field was absent. */
  prompt_cache_key: string | null;
  /** Which retention shape went out; null means neither field was present. */
  cache_retention_sent: "none" | "24h" | "ttl_30m" | null;
}

export const OBSERVATION_FAILED: RawUsageObservation = Object.freeze({
  outcome: "failed",
  reported_fields: [],
  values: {},
});

export const OBSERVATION_NO_USAGE: RawUsageObservation = Object.freeze({
  outcome: "no_usage",
  reported_fields: [],
  values: {},
});

type FetchLike = (input: any, init?: any) => Promise<Response>;

/**
 * Merge usage fields from one event into an accumulator.
 *
 * Merging per FIELD rather than replacing wholesale is required by Anthropic's
 * event protocol: `message_start` carries input and both cache figures while
 * `message_delta` carries only the running output total. Taking "the last usage
 * object" therefore threw input and cache away entirely.
 *
 * Later values win per field, since a cumulative counter's final reading is the
 * one that counts.
 */
function mergeUsageInto(
  target: Partial<Record<UsageField, number>>,
  usage: unknown,
): boolean {
  if (!usage || typeof usage !== "object") return false;
  const u = usage as Record<string, any>;
  let found = false;

  const take = (field: UsageField, ...candidates: unknown[]): void => {
    for (const candidate of candidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        target[field] = candidate;
        found = true;
        return;
      }
    }
  };

  take("input", u.input_tokens, u.prompt_tokens);
  take("output", u.output_tokens, u.completion_tokens);
  take("reasoning", u.output_tokens_details?.reasoning_tokens, u.completion_tokens_details?.reasoning_tokens);
  take("cache_read",
    u.input_tokens_details?.cached_tokens,
    u.prompt_tokens_details?.cached_tokens,
    u.cache_read_input_tokens);
  take("cache_write", u.cache_creation_input_tokens, u.input_tokens_details?.cache_write_tokens);
  return found;
}

/** Read usage out of a single payload. Exposed for tests and direct callers. */
export function extractUsageFields(usage: unknown): RawUsageObservation {
  const values: Partial<Record<UsageField, number>> = {};
  const found = mergeUsageInto(values, usage);
  if (!found) return OBSERVATION_NO_USAGE;
  return { outcome: "reported", reported_fields: Object.keys(values) as UsageField[], values };
}

/**
 * Pull usage out of one decoded body.
 *
 * Handles a plain JSON response and an SSE stream without needing to know which
 * was used. Across SSE events the fields are ACCUMULATED (see `mergeUsageInto`),
 * not overwritten.
 *
 * A body we cannot make sense of at all returns `failed`, never `no_usage` —
 * asserting the server said nothing requires having actually read it.
 */
export function findUsageInBody(body: string): RawUsageObservation {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, any>;
      return extractUsageFields(parsed.usage ?? parsed.response?.usage);
    } catch {
      return OBSERVATION_FAILED;
    }
  }

  const values: Partial<Record<UsageField, number>> = {};
  let sawUsage = false;
  let parsedFrames = 0;
  let badFrames = 0;
  let sawTerminal = false;

  for (const frame of splitSseFrames(body)) {
    const payload = frameData(frame);
    if (payload === null) continue;
    if (payload === "[DONE]") { sawTerminal = true; continue; }
    let event: Record<string, any>;
    try {
      event = JSON.parse(payload) as Record<string, any>;
    } catch {
      // A frame we could not parse is EVIDENCE OF A GAP, not something to skip.
      // Ignoring it let a stream that broke mid-way read as "server said nothing".
      badFrames += 1;
      continue;
    }
    parsedFrames += 1;
    // Anthropic nests opening totals under message_start.message.usage; OpenAI
    // Responses puts them on response.usage. Merge from every known shape.
    const merged =
      mergeUsageInto(values, event.response?.usage) ||
      mergeUsageInto(values, event.message?.usage) ||
      mergeUsageInto(values, event.usage);
    if (merged) sawUsage = true;
    // The protocol's own end-of-stream marker. Without one the transport cut out
    // mid-stream, and whatever totals we hold are an intermediate snapshot —
    // which on Anthropic looks complete on its own, because message_start alone
    // carries a full-looking usage object.
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "message_stop" || type === "response.completed" || type === "response.incomplete") {
      sawTerminal = true;
    }
  }

  if (sawUsage) {
    // Having SOME usage does not license `reported` when part of the stream was
    // unreadable: Anthropic sends running totals, so a broken final frame means
    // the figures we hold are an early snapshot, not the call's totals. Keep the
    // values as evidence, but mark the read as failed so nothing banks them.
    // Two ways a read can be incomplete, neither of which licenses `reported`:
    //   - a frame we could not parse (a gap we can point at), or
    //   - no terminal marker at all (the stream simply stopped; pi surfaces this
    //     as a missing message_stop).
    if (badFrames > 0 || !sawTerminal) {
      return { outcome: "failed", reported_fields: Object.keys(values) as UsageField[], values };
    }
    return { outcome: "reported", reported_fields: Object.keys(values) as UsageField[], values };
  }
  // No usage found. Whether that is a finding or an admission depends on whether
  // the body was fully readable: a malformed frame means part of the stream is
  // unaccounted for, so we cannot claim the provider stayed silent.
  // A stream that simply stopped tells us nothing about what the provider would
  // have reported — `no_usage` is a claim only a COMPLETE read can support.
  if (badFrames > 0 || parsedFrames === 0 || !sawTerminal) return OBSERVATION_FAILED;
  return OBSERVATION_NO_USAGE;
}

/**
 * Split an SSE body into frames.
 *
 * Frames are separated by a blank line, NOT by newline — a single frame may
 * carry several `data:` lines that belong to one JSON document. Splitting per
 * line broke those legitimately multi-line events into fragments, each of which
 * then failed to parse.
 */
function splitSseFrames(body: string): string[] {
  return body.split(/\r?\n\r?\n/).filter((frame) => frame.trim().length > 0);
}

/**
 * The data payload of one frame: every `data:` line joined with newlines, per
 * the SSE spec. Returns null for a frame carrying no data lines (comments,
 * `event:`-only frames), which is an absence rather than a parse failure.
 */
function frameData(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    parts.push(line.slice(5).replace(/^ /, ""));
  }
  if (parts.length === 0) return null;
  const joined = parts.join("\n").trim();
  return joined.length === 0 ? null : joined;
}

/**
 * Fingerprint the request body as it ACTUALLY went out.
 *
 * The SDK's input context is not the final request: `onPayload` can rewrite the
 * instructions after it, so two calls with identical context can put different
 * bytes on the wire. A cache-stability analysis reading the context-derived hash
 * would see "unchanged" across exactly the change that broke the cache.
 *
 * Hashes only — no request content is retained anywhere.
 */
export function fingerprintRequestBody(body: unknown): {
  /** null = inspected the request and it carried no system prompt. */
  system_sha256?: string | null;
  tools_sha256?: string;
  payload_sha256?: string;
  model_settings?: Record<string, unknown>;
} | undefined {
  if (typeof body !== "string") return undefined;
  const digest = (value: unknown): string =>
    createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value ?? null)).digest("hex");
  try {
    const parsed = JSON.parse(body) as Record<string, any>;
    // Each protocol puts the system prompt somewhere different:
    //   Responses  → `instructions`
    //   Anthropic  → `system`
    //   Chat Compl → the leading system/developer MESSAGES
    // Reading only the first two hashed an empty string for Chat Completions, so
    // a changed prompt produced an unchanged fingerprint — silent on exactly the
    // change a cache-stability check exists to catch.
    let system: unknown = parsed.instructions ?? parsed.system;
    if (system === undefined && Array.isArray(parsed.messages)) {
      const leading = parsed.messages
        .filter((m: any) => m?.role === "system" || m?.role === "developer")
        .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
      system = leading.length > 0 ? leading.join("\n") : undefined;
    }
    const settings: Record<string, unknown> = {};
    for (const key of [
      "model", "temperature", "store", "parallel_tool_calls",
      // Output ceilings differ per protocol, and a request carries exactly one.
      "max_output_tokens", "max_tokens", "max_completion_tokens",
      // Reasoning controls: Responses uses `reasoning`, Anthropic `thinking`
      // plus `output_config` — all three change request shape and cost.
      "reasoning", "thinking", "output_config",
    ]) {
      if (parsed[key] !== undefined) settings[key] = parsed[key];
    }
    return {
      // Explicit null, NOT an omitted key: this fingerprint is merged over the
      // context-derived snapshot, so omitting it left the OLD hash in place and
      // a request whose instructions were REMOVED looked unchanged.
      system_sha256: system === undefined ? null : digest(system),
      tools_sha256: digest(parsed.tools ?? []),
      payload_sha256: digest(body),
      model_settings: settings,
    };
  } catch {
    return undefined;
  }
}

/** Read the cache-control facts off an outgoing request body. */
export function readRequestCacheFacts(body: unknown): RequestCacheFacts | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, any>;
    const key = typeof parsed.prompt_cache_key === "string" ? parsed.prompt_cache_key : null;
    let retention: RequestCacheFacts["cache_retention_sent"] = null;
    if (parsed.prompt_cache_retention === "24h") retention = "24h";
    else if (typeof parsed.prompt_cache_retention === "string") retention = "none";
    else if (parsed.prompt_cache_options?.ttl === "30m") retention = "ttl_30m";
    return { prompt_cache_key: key, cache_retention_sent: retention };
  } catch {
    return undefined;
  }
}

/** Byte length of a request body when it is measurable without consuming a stream. */
function requestBodyBytes(init: any): number | undefined {
  const body = init?.body;
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.byteLength;
  return undefined;
}

/**
 * Wrap a fetch so EVERY attempt it makes is observed.
 *
 * `base` is honoured rather than replaced. The sink fires once per HTTP
 * attempt — a transport retry inside one logical call reports its own response,
 * which is what lets the caller both count attempts and keep the surviving
 * attempt's numbers.
 */
export function instrumentFetchForUsage(
  base: FetchLike | undefined,
  onObservation: (observation: RawUsageObservation, attempt: number) => void,
  onAttempt?: (attempt: number) => void,
): FetchLike {
  const underlying: FetchLike = base ?? ((input: any, init?: any) => globalThis.fetch(input, init));
  let attemptCounter = 0;

  return async (input: any, init?: any): Promise<Response> => {
    // Numbered so the caller can tell WHICH attempt each observation belongs to.
    // Without it a late-arriving early attempt could overwrite the final one's
    // result, which is exactly backwards: the last attempt is the outcome.
    const attempt = ++attemptCounter;
    onAttempt?.(attempt);
    // Per-attempt latch: each HTTP attempt reports exactly once, but a second
    // attempt through the SAME wrapper is not suppressed by the first.
    let reported = false;
    const requestFacts = readRequestCacheFacts(init?.body);
    const requestFingerprint = fingerprintRequestBody(init?.body);
    const requestBytes = requestBodyBytes(init);
    const report = (observation: RawUsageObservation): void => {
      if (reported) return;
      reported = true;
      const enriched: RawUsageObservation = {
        ...observation,
        ...(requestBytes === undefined ? {} : { request_bytes: requestBytes }),
        ...(requestFacts === undefined ? {} : { request_cache: requestFacts }),
        ...(requestFingerprint === undefined ? {} : { request_fingerprint: requestFingerprint }),
      };
      try { onObservation(enriched, attempt); } catch { /* metering must never break the call */ }
    };

    let response: Response;
    try {
      response = await underlying(input, init);
    } catch (error) {
      report(OBSERVATION_FAILED);
      throw error;
    }

    if (!response.body) {
      try {
        report(findUsageInBody(await response.clone().text()));
      } catch {
        report(OBSERVATION_FAILED);
      }
      return response;
    }

    const [forSdk, forUs] = response.body.tee();
    void (async () => {
      const decoder = new TextDecoder("utf-8");
      const reader = forUs.getReader();
      let buffered = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
        }
        buffered += decoder.decode();
        report(findUsageInBody(buffered));
      } catch {
        // A read error is NOT evidence that the server reported nothing.
        report(OBSERVATION_FAILED);
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    })();

    return new Response(forSdk, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
