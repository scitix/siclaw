import crypto from "node:crypto";
import type { Db } from "../gateway/db.js";
import { insertIgnorePrefix, safeParseJson, toSqlTimestamp } from "../gateway/dialect-helpers.js";
import {
  isTicketIntakeReviewable,
  normalizeTicketIntakeDraft,
  type TicketIntakeRecord,
  type TicketIntakeSubmissionPayload,
} from "../shared/ticket-intake.js";

interface IntakeRow {
  id: string;
  session_id: string;
  channel_id: string;
  requester_external_id: string;
  source_message_id: string;
  state: TicketIntakeRecord["state"];
  draft_json: string;
  revision: number;
  submission_payload?: string | null;
}

function toRecord(row: IntakeRow): TicketIntakeRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    channelId: row.channel_id,
    requesterExternalId: row.requester_external_id,
    sourceMessageId: row.source_message_id,
    state: row.state,
    draft: normalizeTicketIntakeDraft(safeParseJson(row.draft_json, {})),
    revision: Number(row.revision),
    submissionPayload: row.submission_payload
      ? safeParseJson<TicketIntakeSubmissionPayload | null>(row.submission_payload, null)
      : null,
  };
}

async function selectById(db: Db, id: string, requester: string): Promise<TicketIntakeRecord | null> {
  const [rows] = await db.query<IntakeRow[]>(
    "SELECT * FROM ticket_intakes WHERE id = ? AND requester_external_id = ? LIMIT 1",
    [id, requester],
  );
  return rows.length ? toRecord(rows[0]) : null;
}

export async function beginTicketIntake(db: Db, params: Record<string, unknown>) {
  const sessionId = typeof params.session_id === "string" ? params.session_id.trim() : "";
  const channelId = typeof params.channel_id === "string" ? params.channel_id.trim().slice(0, 128) : "";
  const requester = typeof params.requester_external_id === "string" ? params.requester_external_id.trim().slice(0, 128) : "";
  const sourceMessageId = typeof params.source_message_id === "string" ? params.source_message_id.trim().slice(0, 128) : "";
  if (!sessionId || !channelId || !requester || !sourceMessageId) {
    return { success: false, error: "session_id, channel_id, requester_external_id and source_message_id are required" };
  }
  const active = await getActiveTicketIntake(db, { session_id: sessionId, requester_external_id: requester });
  if (active.intake) return { success: true, intake: active.intake };
  const requestKey = crypto.createHash("sha256").update(`${channelId}\0${sessionId}\0${requester}\0${sourceMessageId}`).digest("hex");
  const id = crypto.randomUUID();
  const draft = normalizeTicketIntakeDraft({ classification: "needs_clarification", attempted_actions: [], source_refs: [], open_questions: [], ready_for_review: false });
  await db.query(
    `${insertIgnorePrefix(db)} INTO ticket_intakes
      (id, request_key, session_id, channel_id, requester_external_id, source_message_id, state, draft_json, revision)
     VALUES (?, ?, ?, ?, ?, ?, 'collecting', ?, 1)`,
    [id, requestKey, sessionId, channelId, requester, sourceMessageId, JSON.stringify(draft)],
  );
  const [rows] = await db.query<IntakeRow[]>("SELECT * FROM ticket_intakes WHERE request_key = ? LIMIT 1", [requestKey]);
  return rows.length ? { success: true, intake: toRecord(rows[0]) } : { success: false, error: "Failed to create ticket intake" };
}

export async function getActiveTicketIntake(db: Db, params: Record<string, unknown>) {
  const sessionId = typeof params.session_id === "string" ? params.session_id.trim() : "";
  const requester = typeof params.requester_external_id === "string" ? params.requester_external_id.trim() : "";
  if (!sessionId || !requester) return { intake: null };
  const [rows] = await db.query<IntakeRow[]>(
    `SELECT * FROM ticket_intakes
     WHERE session_id = ? AND requester_external_id = ? AND state IN ('collecting', 'review')
     ORDER BY updated_at DESC LIMIT 1`,
    [sessionId, requester],
  );
  return { intake: rows.length ? toRecord(rows[0]) : null };
}

export async function updateTicketIntakeDraft(db: Db, params: Record<string, unknown>) {
  const sessionId = typeof params.session_id === "string" ? params.session_id.trim() : "";
  const id = typeof params.intake_id === "string" ? params.intake_id.trim() : "";
  const revision = Number(params.expected_revision);
  if (!sessionId || !id || !Number.isInteger(revision)) return { success: false, error: "session_id, intake_id and expected_revision are required" };
  const draft = normalizeTicketIntakeDraft(params.draft);
  const state = isTicketIntakeReviewable(draft) && draft.open_questions.length === 0 ? "review" : "collecting";
  const [result] = await db.query(
    `UPDATE ticket_intakes SET draft_json = ?, state = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND session_id = ? AND revision = ? AND state IN ('collecting', 'review')`,
    [JSON.stringify(draft), state, id, sessionId, revision],
  ) as any;
  return Number(result?.affectedRows ?? 0) > 0
    ? { success: true }
    : { success: false, error: "No active user-started ticket intake" };
}

export async function transitionTicketIntake(db: Db, params: Record<string, unknown>) {
  const id = typeof params.intake_id === "string" ? params.intake_id.trim() : "";
  const requester = typeof params.requester_external_id === "string" ? params.requester_external_id.trim() : "";
  const revision = Number(params.expected_revision);
  const action = params.action;
  if (!id || !requester || !Number.isInteger(revision) || !["confirm", "continue", "cancel"].includes(String(action))) {
    return { success: false, error: "intake_id, requester_external_id, expected_revision and a valid action are required" };
  }
  const current = await selectById(db, id, requester);
  if (!current) return { success: false, error: "Ticket intake not found" };
  if (action === "confirm" && current.state === "confirmed" && current.submissionPayload) {
    return { success: true, intake: current, payload: current.submissionPayload };
  }
  if (current.revision !== revision) return { success: false, error: "Ticket intake changed; review the latest version" };
  if (current.state === "confirmed" || current.state === "cancelled") return { success: false, error: "Ticket intake is already closed" };

  let payload: TicketIntakeSubmissionPayload | undefined;
  let nextState: TicketIntakeRecord["state"];
  if (action === "confirm") {
    if (current.state !== "review" || !isTicketIntakeReviewable(current.draft) || current.draft.open_questions.length) {
      return { success: false, error: "Ticket intake is not ready for confirmation" };
    }
    const confirmedAt = new Date();
    payload = {
      schema_version: "siclaw.ticket_intake.v1",
      intake_id: current.id,
      session_id: current.sessionId,
      channel: {
        type: "lark",
        channel_id: current.channelId,
        requester_external_id: current.requesterExternalId,
        source_message_id: current.sourceMessageId,
      },
      draft: current.draft,
      confirmed_at: confirmedAt.toISOString(),
    };
    const [result] = await db.query(
      `UPDATE ticket_intakes SET state = 'confirmed', submission_payload = ?, confirmed_at = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND requester_external_id = ? AND revision = ? AND state = 'review'`,
      [JSON.stringify(payload), toSqlTimestamp(confirmedAt), id, requester, revision],
    ) as any;
    if (!Number(result?.affectedRows ?? 0)) return { success: false, error: "Ticket intake changed; review the latest version" };
    nextState = "confirmed";
  } else {
    nextState = action === "cancel" ? "cancelled" : "collecting";
    const [result] = await db.query(
      `UPDATE ticket_intakes SET state = ?, revision = revision + 1,
       cancelled_at = ${action === "cancel" ? "CURRENT_TIMESTAMP" : "NULL"}, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND requester_external_id = ? AND revision = ? AND state IN ('collecting', 'review')`,
      [nextState, id, requester, revision],
    ) as any;
    if (!Number(result?.affectedRows ?? 0)) return { success: false, error: "Ticket intake changed; review the latest version" };
  }
  const updated = await selectById(db, id, requester);
  return { success: true, intake: updated ?? { ...current, state: nextState, revision: revision + 1 }, ...(payload ? { payload } : {}) };
}
