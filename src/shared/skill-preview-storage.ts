/** Serialized UTF-8 budget, including JSON escaping and compatibility projections. */
export const MAX_PREVIEW_METADATA_BYTES = 1024 * 1024;

export interface OmittedSkillPreview {
  status: "omitted";
  reason: string;
  name: string;
  limitBytes: number;
}

/** Oversized sibling fields may be dropped along with the full package. */
export interface OmittedPreviewMetadata extends Record<string, unknown> {
  skillPreview: OmittedSkillPreview;
}

export function previewSummary(preview: any, reason: string, limitBytes = MAX_PREVIEW_METADATA_BYTES): OmittedSkillPreview {
  return {
    status: "omitted",
    reason,
    name: typeof (preview?.skill?.name ?? preview?.name) === "string"
      ? String(preview.skill?.name ?? preview.name).slice(0, 200) : "Skill preview",
    limitBytes,
  };
}

/** Bound the package before redaction; omission does not preserve the input's shape. */
export function boundSkillPreviewMetadata<T extends Record<string, unknown> | null | undefined>(
  metadata: T, limitBytes = MAX_PREVIEW_METADATA_BYTES,
): T | OmittedPreviewMetadata {
  if (!metadata?.skillPreview) return metadata;
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") <= limitBytes) return metadata;
  const result: OmittedPreviewMetadata = { skillPreview: previewSummary(metadata.skillPreview, "size_limit", limitBytes) };
  // Keep small timeline fields even if an unexpected sibling also contains a
  // large payload. Removing the package alone must not defeat the byte limit.
  const priority = ["llm_round", "tool_call_id", "started_at", "model_route", "toolset_dispatch"];
  for (const key of [...new Set([...priority, ...Object.keys(metadata)])]) {
    if (key === "skillPreview" || metadata[key] === undefined) continue;
    const candidate = { ...result, [key]: metadata[key] };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= limitBytes) result[key] = metadata[key];
  }
  return result;
}
