import { describe, expect, it } from "vitest";
import { normalizeHandoffTrace, handoffParentSpan } from "./handoff-trace.js";
const traceId = "0123456789abcdef0123456789abcdef";
describe("handoff trace wire boundary", () => {
  it.each([undefined, null, [], {}, { traceId: "0".repeat(32) }, { traceId: "A".repeat(32) }, { traceId: "not-a-trace" }])("rejects malformed context %j", value => {
    expect(normalizeHandoffTrace(value)).toBeUndefined();
  });
  it("keeps a valid trace when the optional parent is malformed", () => {
    expect(normalizeHandoffTrace({ traceId, parentSpanId: "0".repeat(16), secret: "not propagated" })).toEqual({ traceId });
  });
  it("returns owned scalars and a valid remote span context", () => {
    const raw = { traceId, parentSpanId: "1234567890abcdef", traceFlags: 0 };
    const context = normalizeHandoffTrace(raw)!;
    raw.traceId = "changed";
    expect(handoffParentSpan(context)).toEqual({ traceId, spanId: "1234567890abcdef", traceFlags: 0, isRemote: true });
  });
});
