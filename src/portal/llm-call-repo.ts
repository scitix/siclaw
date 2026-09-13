/**
 * Persists LLM-call measurements.
 *
 * Writes are IDEMPOTENT on `call_id`. The sender deliberately keeps no
 * "already delivered" state — it cannot, since a response can be lost after the
 * row was committed — so a redelivery has to be harmless here instead.
 *
 * Insert-ignore rather than upsert: the first delivery is the measurement taken
 * at the provider boundary, and a later copy of the same call has nothing newer
 * to say. Overwriting would let a retry of an older batch replace a row.
 *
 * NULL is preserved end to end. A token column left NULL means the provider did
 * not report that field; writing 0 instead would destroy the one distinction
 * this whole pipeline exists to keep.
 */

import type { Db } from "../gateway/db.js";
import { insertIgnorePrefix } from "../gateway/dialect-helpers.js";
import { isLlmWorkload } from "../shared/llm-call-record.js";
import type { LlmCallMeasurement, LlmCallAttribution } from "../shared/llm-call-record.js";

export interface PersistResult {
  /** Rows newly written. */
  inserted: number;
  /** Rows already present — a redelivery, not an error. */
  duplicates: number;
}

/** Serialize a nullable structure without turning "absent" into "{}" . */
function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Write a batch. Each row is inserted independently so one malformed row cannot
 * discard its neighbours — a metering write must never take down more data than
 * the row it is about.
 */
export async function persistLlmCallMeasurements(
  db: Db,
  attribution: LlmCallAttribution,
  measurements: readonly LlmCallMeasurement[],
): Promise<PersistResult> {
  let inserted = 0;
  let duplicates = 0;
  const prefix = insertIgnorePrefix(db);

  for (const m of measurements) {
    const [result] = (await db.query(
      `${prefix} INTO llm_calls (
        call_id, session_id, prompt_id, root_request_id, parent_call_id,
        org_id, user_id, agent_id, agent_type, session_origin,
        workload, kind, round, attempt, network_attempts,
        provider, model_id, api_type,
        usage_status, usage_source, reported_fields,
        input_tokens_total, output_tokens_total, reasoning_tokens,
        cache_read_tokens, cache_write_tokens,
        payload_bytes, payload_tokens_estimated, cost_micros,
        request_snapshot, inconsistencies,
        request_at, response_end_at, since_prev_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        m.call_id, attribution.session_id, m.prompt_id,
        // The PRODUCER's correlation wins: only the box knows which user request
        // a call served. `undefined` (an older box) becomes null — never a value
        // reconstructed from session lineage, which cannot tell one request from
        // the next within a conversation.
        m.root_request_id ?? attribution.root_request_id ?? null,
        // Same rule, same reason: only the box knows which of the parent's calls
        // dispatched this child. The receiver can see the child session exists;
        // it cannot see which call spawned it.
        m.parent_call_id ?? attribution.parent_call_id ?? null,
        attribution.org_id, attribution.user_id, attribution.agent_id,
        attribution.agent_type, attribution.session_origin,
        // An older box sends no workload. It becomes `unattributed` — a visible
        // value — rather than being folded into `conversation`, which would let
        // an un-taught producer masquerade as ordinary chat traffic.
        isLlmWorkload(m.workload) ? m.workload : "unattributed",
        m.kind, m.round, m.attempt, m.network_attempts,
        m.provider, m.model_id, m.api_type,
        m.usage_status, m.usage_source, m.reported_fields.join(","),
        m.input_tokens_total, m.output_tokens_total, m.reasoning_tokens,
        m.cache_read_tokens, m.cache_write_tokens,
        m.payload_bytes, m.payload_tokens_estimated,
        // Always NULL for now: prices are unverified, and a wrong cost is worse
        // than an absent one because it looks authoritative.
        null,
        jsonOrNull(m.request_snapshot),
        m.inconsistencies && m.inconsistencies.length > 0 ? jsonOrNull(m.inconsistencies) : null,
        m.request_at, m.response_end_at, m.since_prev_ms,
      ],
    )) as any;
    // mysql2 reports affectedRows; node:sqlite reports changes. Either way zero
    // means the row was already there.
    const affected = Number(result?.affectedRows ?? result?.changes ?? 0);
    if (affected > 0) inserted += 1;
    else duplicates += 1;
  }

  return { inserted, duplicates };
}
