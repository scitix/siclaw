import type { Db } from "../gateway/db.js";
import { boundSkillPreviewMetadata, MAX_PREVIEW_METADATA_BYTES } from "../shared/skill-preview-storage.js";

/** Project in SQL: old large packages must not cross the DB or history transport. */
export function historyMetadataSql(db: Pick<Db, "driver">, full = false): string {
  const scalar = (path: string) => db.driver === "mysql"
    ? `JSON_UNQUOTE(JSON_EXTRACT(metadata, '${path}'))` : `JSON_EXTRACT(metadata, '${path}')`;
  const bytes = db.driver === "mysql" ? "OCTET_LENGTH(metadata)" : "LENGTH(CAST(metadata AS BLOB))";
  const status = scalar("$.skillPreview.status");
  const summary = `JSON_SET(metadata, '$.skillPreview', JSON_OBJECT(
    'name', SUBSTR(COALESCE(${scalar("$.skillPreview.skill.name")}, ${scalar("$.skillPreview.name")}, 'Skill preview'), 1, 200),
    'status', CASE WHEN ${status} = 'omitted' OR ${bytes} > ${MAX_PREVIEW_METADATA_BYTES} THEN 'omitted' ELSE 'deferred' END,
    'reason', CASE WHEN ${bytes} > ${MAX_PREVIEW_METADATA_BYTES} THEN 'size_limit' ELSE ${scalar("$.skillPreview.reason")} END,
    'limitBytes', ${MAX_PREVIEW_METADATA_BYTES}))`;
  return `CASE WHEN JSON_VALID(metadata) THEN CASE WHEN JSON_EXTRACT(metadata, '$.skillPreview') IS NOT NULL${full ? ` AND ${bytes} > ${MAX_PREVIEW_METADATA_BYTES}` : ""} THEN ${summary} ELSE metadata END ELSE metadata END`;
}

export const CHAT_HISTORY_COLUMNS = "id, session_id, role, content, tool_name, toolset, tool_input, outcome, duration_ms, from_agent_id, parent_session_id, delegation_id, target_agent_id, trace_id, seq, created_at";

/** Keep SQL escaping, content, input and statement overhead inside the server's packet. */
export async function preparePreviewWrite(db: Db, metadata: unknown, content: unknown, input: unknown): Promise<unknown> {
  let parsed: Record<string, unknown>;
  try { parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata as Record<string, unknown>; }
  catch { return metadata; }
  if (!parsed?.skillPreview) return metadata;
  let limit = MAX_PREVIEW_METADATA_BYTES;
  if (db.driver === "mysql") {
    const [rows] = await db.query<Array<{ packet: number }>>("SELECT @@max_allowed_packet AS packet");
    const packet = Number(rows[0]?.packet);
    if (!Number.isFinite(packet) || packet < 65536) throw new Error("Cannot determine preview storage capacity");
    const otherBytes = Buffer.byteLength(String(content ?? "")) + Buffer.byteLength(String(input ?? ""));
    // A downgrade also replaces content; reserve space for its small marker.
    limit = Math.max(1024, Math.min(limit, Math.floor(packet / 2) - otherBytes - 32768));
  }
  return boundSkillPreviewMetadata(parsed, limit);
}

export async function preparePreviewMessage(db: Db, params: { metadata?: unknown; content?: unknown; tool_input?: unknown }): Promise<void> {
  params.metadata = await preparePreviewWrite(db, params.metadata, params.content, params.tool_input);
  if (typeof params.metadata === "object" && params.metadata !== null
    && (params.metadata as any).skillPreview?.status === "omitted") {
    params.content = "Skill preview omitted from history: storage or redaction limit. Generate a smaller preview.";
  }
}

export function historyContentSql(): string {
  return "CASE WHEN JSON_VALID(metadata) THEN CASE WHEN tool_name = 'skill_preview' AND JSON_EXTRACT(metadata, '$.skillPreview') IS NOT NULL THEN 'Skill preview: open to load files.' ELSE content END ELSE content END";
}

export function historyColumns(contentSql = historyContentSql()): string {
  return CHAT_HISTORY_COLUMNS.replace("role, content,", `role, ${contentSql} AS content,`);
}

/** Keep the legacy JSON fallback in detail responses without returning unbounded text. */
export function previewDetailContentSql(db: Pick<Db, "driver">): string {
  const bytes = db.driver === "mysql" ? "OCTET_LENGTH(content)" : "LENGTH(CAST(content AS BLOB))";
  return `CASE WHEN tool_name = 'skill_preview' AND ${bytes} > ${MAX_PREVIEW_METADATA_BYTES} THEN 'Skill preview text exceeds the storage limit.' ELSE content END`;
}
