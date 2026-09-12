/** Serialized UTF-8 budget, including JSON escaping and compatibility projections. */
export const MAX_PREVIEW_METADATA_BYTES = 1024 * 1024;

export function previewSummary(preview: any, reason: string, limitBytes = MAX_PREVIEW_METADATA_BYTES) {
  return {
    status: "omitted",
    reason,
    name: typeof (preview?.skill?.name ?? preview?.name) === "string"
      ? String(preview.skill?.name ?? preview.name).slice(0, 200) : "Skill preview",
    limitBytes,
  };
}

/** Run before redaction so oversized packages never enter the regex pipeline. */
export function boundSkillPreviewMetadata<T extends Record<string, unknown> | null | undefined>(
  metadata: T, limitBytes = MAX_PREVIEW_METADATA_BYTES,
): T {
  if (!metadata?.skillPreview) return metadata;
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") <= limitBytes) return metadata;
  const result: Record<string, unknown> = { skillPreview: previewSummary(metadata.skillPreview, "size_limit", limitBytes) };
  // Keep small timeline fields even if an unexpected sibling also contains a
  // large payload. Removing the package alone must not defeat the byte limit.
  const priority = ["llm_round", "tool_call_id", "started_at", "model_route", "toolset_dispatch"];
  for (const key of [...new Set([...priority, ...Object.keys(metadata)])]) {
    if (key === "skillPreview" || metadata[key] === undefined) continue;
    const candidate = { ...result, [key]: metadata[key] };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= limitBytes) result[key] = metadata[key];
  }
  return result as T;
}
