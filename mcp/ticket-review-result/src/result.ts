import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import schema from "./result.schema.json" with { type: "json" };

export type TicketReviewResult = {
  ticket_id: string;
  ticket_type: "incident" | "requirement" | "consultation" | null;
  requirement_kind: "governance" | "product" | null;
  type: string;
  result: string;
  review_status: "ready" | "needs_review";
  evidence: Array<{
    source: "ticket" | "ticket_comment" | "operate_log" | "group_message" | "attachment";
    id: string;
  }>;
  open_questions: string[];
};

// Result metadata is stored in a 65,535-byte MySQL TEXT column downstream.
// Leave space for its envelope and JSON escaping; reject rather than truncate.
export const MAX_RESULT_BYTES = 24 * 1024;
export const resultSchema = { ...schema, type: "object" as const };
// JSON imports infer optional undefined keys for heterogeneous allOf entries.
const validate = new AjvJsonSchemaValidator().getValidator<TicketReviewResult>(resultSchema as unknown as JsonSchemaType);

/** Validates shape and field relationships, not the truth of supplied evidence. */
export function parseTicketReviewResult(input: unknown): TicketReviewResult {
  const checked = validate(input);
  if (!checked.valid) throw new Error(checked.errorMessage);
  if (Buffer.byteLength(JSON.stringify(checked.data), "utf8") > MAX_RESULT_BYTES) {
    throw new Error(`Serialized result exceeds ${MAX_RESULT_BYTES} UTF-8 bytes; shorten it without dropping uncertainty or evidence.`);
  }
  return checked.data;
}
