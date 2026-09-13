/**
 * Receives LLM-call measurements from an AgentBox.
 *
 * The box produces measurements at the provider boundary and cannot write to the
 * database (in K8s it is a different pod); this handler is the other half of
 * that seam.
 *
 * Two properties it owes the sender:
 *
 *   1. IDEMPOTENCE. A delivery whose response was lost will be retried, so the
 *      same `call_id` must be harmless the second time — enforced by the table's
 *      primary key, not by the sender remembering.
 *   2. HONEST FAILURE. A rejected batch returns a status the dispatcher can act
 *      on. Answering 200 to something we did not store would let the box count
 *      it delivered and a coverage report overstate itself.
 *
 * Attribution is resolved HERE, not trusted from the body: the box knows its
 * session, but org/user/agent identity belongs to the Runtime, and a box must
 * not be able to file measurements against someone else.
 */

import type http from "node:http";
import { validateMeasurementBatch } from "../shared/llm-call-validation.js";
import { persistLlmCallMeasurements } from "../portal/llm-call-repo.js";
import type { Db } from "./db.js";
import type { LlmCallAttribution } from "../shared/llm-call-record.js";

/** Resolves the identities a box is not allowed to assert for itself. */
export type AttributionResolver = (sessionId: string) => Promise<Omit<LlmCallAttribution, "session_id"> | null>;

/**
 * Read attribution straight off the session row.
 *
 * The in-memory registry only carries userId/agentId, and filing rows with the
 * rest blank would leave the per-user and per-entry views — the ones this work
 * exists to produce — unbuildable. One indexed lookup per BATCH (not per call)
 * is a price worth paying for that.
 *
 * A sub-agent's rows carry the CHILD session's identities. Which user request
 * they belong to is a separate fact, and one the box supplies on the
 * measurement (`root_request_id` / `parent_call_id`) — see the note below on
 * why `parent_session_id` cannot answer it.
 */
export async function resolveAttributionFromDb(
  db: Db,
  sessionId: string,
): Promise<Omit<LlmCallAttribution, "session_id"> | null> {
  const [rows] = (await db.query(
    `SELECT s.agent_id, s.user_id, s.origin, s.target_agent_id,
            owner.agent_type AS owner_type,
            target.agent_type AS target_type
       FROM chat_sessions s
       LEFT JOIN agents owner  ON owner.id  = s.agent_id
       LEFT JOIN agents target ON target.id = s.target_agent_id
      WHERE s.id = ?`,
    [sessionId],
  )) as any;
  const row = rows?.[0];
  if (!row) return null;
  // The executor when the leg was delegated, otherwise the owner — and the TYPE
  // must describe the SAME agent. Joining on the owner while reporting the
  // target produced agent_id=worker with agent_type=coordinator, which makes
  // any per-type breakdown wrong in exactly the delegated case.
  const executorIsTarget = Boolean(row.target_agent_id);
  return {
    org_id: "",
    user_id: row.user_id ?? null,
    agent_id: (executorIsTarget ? row.target_agent_id : row.agent_id) ?? "",
    agent_type: (executorIsTarget ? row.target_type : row.owner_type) ?? "",
    session_origin: row.origin ?? "web",
    // NOT parent_session_id: one parent session spans many user requests, so
    // using it would file every sub-call of every request under one id while
    // the parent's own calls carry none. Session lineage is a different fact
    // from request identity. Both correlations therefore come from the BOX, on
    // the measurement itself; these two stay null so that an older box — which
    // sends neither — records an honest absence rather than a lineage guess.
    root_request_id: null,
    parent_call_id: null,
  };
}

/** Read a JSON body with a hard cap, decoding on the stream. */
async function readJsonBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      // Byte length, not string length: a UTF-16 count lets CJK bodies run past
      // the cap. Decoding happens once, at the end, over the whole buffer.
      size += chunk.length;
      if (size > maxBytes) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Hands a validated batch to whoever owns persistence. */
export type MeasurementPersister = (batch: {
  session_id: string;
  measurements: unknown[];
}) => Promise<{ ok: boolean; error?: string; inserted?: number; duplicates?: number }>;

/** Answers whether this certificate may file measurements against this session. */
export type SessionAuthorizer = (sessionId: string) => Promise<boolean>;

export async function handleLlmCallMeasurements(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  persist: MeasurementPersister,
  authorize: SessionAuthorizer,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : "unreadable body" });
    return;
  }

  const validation = validateMeasurementBatch(body);
  if (!validation.ok || !validation.batch) {
    // 400, not 200: a shape we refuse is a shape the sender should stop
    // producing, and telling it "fine" hides a version skew during a rollout.
    send(res, 400, { error: validation.error ?? "invalid batch" });
    return;
  }

  const { session_id: sessionId, measurements } = validation.batch;
  try {
    // A VALID CERTIFICATE IS NOT AUTHORIZATION. Any box can present one, so
    // without this a worker's certificate could file spend against an owner's
    // session — resolving attribution from the database says who the session
    // belongs to, never that this caller may write to it.
    if (!(await authorize(sessionId))) {
      send(res, 403, { error: "not authorized for this session" });
      return;
    }
    const result = await persist({ session_id: sessionId, measurements });
    if (!result.ok) {
      send(res, result.error === "unknown session" ? 404 : 500, { error: result.error ?? "persist failed" });
      return;
    }
    // `duplicates` is reported, not treated as an error — it is the expected
    // outcome of a redelivery and useful for spotting a sender retrying too hard.
    send(res, 200, result);
  } catch (error) {
    console.warn(`[llm-call-api] failed to persist ${measurements.length} measurement(s):`, error);
    send(res, 500, { error: "persist failed" });
  }
}
