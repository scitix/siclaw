import type { ErrorDetail } from "../components/chat/types"

/** Longest human sentence we will put in a bubble; the rest stays in details. */
const MAX_MESSAGE_CHARS = 400

/**
 * Pull the human sentence out of a provider's error payload.
 *
 * A gateway rejection arrives as the whole JSON body, so the bubble read:
 *
 *   400 {"error":{"msg":"current protocol claude is not supported by model
 *   gpt-5.6-sol, please use openai or openai-responses protocol","code":
 *   "unsupported_protocol","message":"current protocol claude is not …
 *
 * The sentence that names the fix is in there three times, wrapped in braces
 * the reader has to parse by eye. This lifts it out and keeps the payload in
 * `details`, which the bubble already has an expander for — nothing is lost,
 * it just stops being the first thing you see.
 */
export function normalizeProviderError(detail: ErrorDetail): ErrorDetail {
  const raw = detail.message
  if (typeof raw !== "string" || !raw.includes("{")) return detail

  const parsed = parseEmbeddedJson(raw)
  if (!parsed) return detail

  const message = firstString(
    parsed.msg,
    parsed.message,
    isRecord(parsed.error) ? parsed.error.msg : undefined,
    isRecord(parsed.error) ? parsed.error.message : undefined,
  )
  if (!message) return detail

  const traceId = firstString(
    parsed.traceId,
    parsed.trace_id,
    isRecord(parsed.error) ? parsed.error.traceId : undefined,
  )

  return {
    ...detail,
    message: message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message,
    // The payload is what you need to file a bug; the sentence is what you need
    // to fix the config. Keep both, one behind a click.
    details: detail.details ?? raw,
    requestId: detail.requestId ?? traceId,
  }
}

/**
 * Parse a JSON object embedded in a longer string.
 *
 * Prefixes are normal (`400 {…}`, `AI_APICallError: {…}`) and so are suffixes
 * (a retry counter appended by a caller). Trying the whole string first, then
 * the widest brace-delimited span, covers both — where `indexOf("{")` plus a
 * strict parse silently gives up the moment anything follows the payload.
 */
function parseEmbeddedJson(raw: string): Record<string, unknown> | null {
  const attempt = (text: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(text)
      return isRecord(value) ? value : null
    } catch {
      return null
    }
  }

  const whole = attempt(raw.trim())
  if (whole) return whole

  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  return attempt(raw.slice(start, end + 1))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim()
  }
  return undefined
}
