/** Preserve structured tool data across Web, IM, delegation and synthetic turns. */
export function persistableToolDetails(
  details: unknown,
  redact: (value: string) => string = (value) => value,
): Record<string, unknown> | null {
  if (!details || typeof details !== "object" || Array.isArray(details))
    return null;
  const {
    blocked: _blocked,
    error: _error,
    ...rest
  } = details as Record<string, unknown>;
  if (!Object.keys(rest).length) return null;
  try {
    return JSON.parse(redact(JSON.stringify(rest))) as Record<string, unknown>;
  } catch {
    return null;
  }
}
/** Only completed versioned trace attachments can advertise an authenticated Web entry. */
export function traceVisualIds(
  metadata: Record<string, unknown> | null,
): string[] {
  const envelope = metadata?.structuredContent as
    Record<string, unknown> | undefined;
  if (envelope?.schema_version !== 2 || !Array.isArray(envelope.visuals))
    return [];
  return [
    ...new Set(
      envelope.visuals.slice(0, 8).flatMap((v: any): string[] =>
        v?.kind === "chart" &&
        v?.spec?.type === "waterfall" &&
        v.spec.visual_id === v.visual_id &&
        typeof v.visual_id === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(v.visual_id)
          ? [v.visual_id]
          : [],
      ),
    ),
  ];
}
