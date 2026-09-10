import { it, expect } from "vitest"
import { traceAttachments, attachedTraceIds } from "./trace-attachments"
const spec = {
  type: "waterfall",
  schema_version: 1,
  visual_id: "v1",
  data: {
    origin_time: "2026-09-10T00:00:00Z",
    root_span_id: "r",
    coverage: { complete: true, observed: ["root"], missing: [] },
    spans: [{ span_id: "r", label: "root", start_ms: 0, end_ms: 100 }],
  },
}
const metadata = {
  structuredContent: { schema_version: 2, visuals: [{ visual_id: "v1", kind: "chart", spec }] },
}
it("restores object and serialized metadata identically", () => {
  expect(traceAttachments(metadata)).toEqual(traceAttachments(JSON.stringify(metadata)))
  expect(traceAttachments(metadata)[0].spec?.data.spans[0].end_ms).toBe(100)
})
it("deduplicates attached IDs only after completion", () => {
  expect([
    ...attachedTraceIds([
      { role: "tool", metadata },
      { role: "tool", toolDetails: metadata },
    ]),
  ]).toEqual(["v1"])
  expect(attachedTraceIds([{ role: "tool", isStreaming: true, metadata }]).size).toBe(0)
})
it("malformed specs return a readable fallback rather than execute content", () => {
  const raw = structuredClone(metadata)
  raw.structuredContent.visuals[0].spec.visual_id = "mismatch"
  expect(traceAttachments(raw)[0].spec).toBeNull()
  expect(traceAttachments({ structuredContent: { schema_version: 99, visuals: [] } })).toEqual([])
})
