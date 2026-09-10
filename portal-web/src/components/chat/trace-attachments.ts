import { normalizeWaterfallSpec, type WaterfallSpec } from "./waterfall-spec"
export interface TraceAttachment {
  id: string
  spec: WaterfallSpec | null
  error?: string
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)
/** Accept only the versioned MCP envelope, never executable content or external URLs. */
export function traceAttachments(metadata: unknown): TraceAttachment[] {
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata)
    } catch {
      return []
    }
  }
  if (!record(metadata) || !record(metadata.structuredContent)) return []
  const envelope = metadata.structuredContent
  if (envelope.schema_version !== 2 || !Array.isArray(envelope.visuals)) return []
  const seen = new Set<string>()
  return envelope.visuals.slice(0, 8).flatMap((item): TraceAttachment[] => {
    if (
      !record(item) ||
      item.kind !== "chart" ||
      !record(item.spec) ||
      item.spec.type !== "waterfall"
    )
      return []
    if (
      typeof item.visual_id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(item.visual_id) ||
      seen.has(item.visual_id)
    )
      return []
    seen.add(item.visual_id)
    try {
      if (item.spec.visual_id !== item.visual_id)
        throw new Error("Trace attachment ID does not match its data")
      return [{ id: item.visual_id, spec: normalizeWaterfallSpec(item.spec) }]
    } catch (error) {
      return [
        {
          id: item.visual_id,
          spec: null,
          error: error instanceof Error ? error.message : "Invalid trace data",
        },
      ]
    }
  })
}
export function attachedTraceIds(
  messages: Array<{
    role: string
    isStreaming?: boolean
    metadata?: unknown
    toolDetails?: unknown
  }>,
): Set<string> {
  return new Set(
    messages
      .filter((m) => m.role === "tool" && !m.isStreaming)
      .flatMap((m) =>
        traceAttachments(m.toolDetails ?? m.metadata)
          .filter((v) => v.spec)
          .map((v) => v.id),
      ),
  )
}
