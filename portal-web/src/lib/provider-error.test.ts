import { describe, it, expect } from "vitest"
import { normalizeProviderError } from "./provider-error"

const base = { code: "MODEL_ERROR", retriable: true }
const detail = (message: string) => ({ ...base, message })

describe("normalizeProviderError", () => {
  // The reported bubble, verbatim. The sentence that names the fix appears
  // three times in the payload, wrapped in braces the reader has to parse by eye.
  it("lifts the sentence out of a gateway rejection", () => {
    const raw =
      '400 {"error":{"msg":"current protocol claude is not supported by model gpt-5.6-sol, please use openai or openai-responses protocol",' +
      '"code":"unsupported_protocol","message":"current protocol claude is not supported by model gpt-5.6-sol, please use openai or openai-responses protocol",' +
      '"type":"unsupported_protocol","traceId":"d62705ffd8f5b32abdd9971f95f106eb"}}'
    const r = normalizeProviderError(detail(raw))
    expect(r.message).toBe(
      "current protocol claude is not supported by model gpt-5.6-sol, please use openai or openai-responses protocol",
    )
    // Nothing is lost — the payload moves behind the expander the bubble already has.
    expect(r.details).toBe(raw)
    expect(r.requestId).toBe("d62705ffd8f5b32abdd9971f95f106eb")
    expect(r.code).toBe("MODEL_ERROR")
  })

  it("reads a top-level msg or message", () => {
    expect(normalizeProviderError(detail('{"msg":"model service not found"}')).message)
      .toBe("model service not found")
    expect(normalizeProviderError(detail('{"message":"rate limited"}')).message)
      .toBe("rate limited")
  })

  // A prefix is normal (`400 …`, `AI_APICallError: …`) and so is a suffix — a
  // caller appending a retry counter used to defeat the whole normalization.
  it("tolerates text on either side of the payload", () => {
    expect(normalizeProviderError(detail('AI_APICallError: {"message":"boom"} (attempt 2 of 3)')).message)
      .toBe("boom")
  })

  it("leaves a plain sentence alone", () => {
    const r = normalizeProviderError(detail("Request timed out."))
    expect(r.message).toBe("Request timed out.")
    expect(r.details).toBeUndefined()
  })

  // Degrading to the raw text is always acceptable; throwing is not, because
  // this runs while rendering the only explanation the user is going to get.
  it.each([
    ["truncated json", '400 {"error":{"msg":"half a mes'],
    ["no recognisable field", '{"status":500,"body":null}'],
    ["an array payload", "[1,2,3]"],
    ["a lone brace", "{"],
  ])("falls back to the raw text on %s", (_label, raw) => {
    const r = normalizeProviderError(detail(raw))
    expect(r.message).toBe(raw)
    expect(r.details).toBeUndefined()
  })

  it("caps a runaway sentence but keeps the payload whole", () => {
    // Gateways echo the offending request for invalid_request on a large tool
    // schema; unbounded, that pushes the transcript off screen.
    const long = "x".repeat(1200)
    const raw = JSON.stringify({ msg: long })
    const r = normalizeProviderError(detail(raw))
    expect(r.message.length).toBeLessThan(420)
    expect(r.message.endsWith("…")).toBe(true)
    expect(r.details).toBe(raw)
  })

  it("does not overwrite a requestId or details the caller already set", () => {
    const r = normalizeProviderError({
      ...base,
      message: '{"msg":"boom","traceId":"from-payload"}',
      requestId: "from-caller",
      details: { kept: true },
    })
    expect(r.requestId).toBe("from-caller")
    expect(r.details).toEqual({ kept: true })
  })
})
