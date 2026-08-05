export const TICKET_INTAKE_ACTION_KIND = "siclaw_ticket_intake" as const;

export type TicketIntakeState = "collecting" | "review" | "confirmed" | "cancelled";

export type TicketIntakeClassification =
  | "answerable_consultation"
  | "needs_clarification"
  | "incident_candidate"
  | "service_request";

export interface TicketIntakeDraft {
  classification: TicketIntakeClassification;
  summary: string;
  product?: string;
  category?: string;
  impact?: string;
  affected_object?: string;
  occurred_at?: string;
  actual_behavior?: string;
  expected_behavior?: string;
  attempted_actions: string[];
  source_refs: string[];
  open_questions: string[];
  ready_for_review: boolean;
}

export interface TicketIntakeRecord {
  id: string;
  sessionId: string;
  channelId: string;
  requesterExternalId: string;
  sourceMessageId: string;
  state: TicketIntakeState;
  draft: TicketIntakeDraft;
  revision: number;
  submissionPayload?: TicketIntakeSubmissionPayload | null;
}

export interface TicketIntakeSubmissionPayload {
  schema_version: "siclaw.ticket_intake.v1";
  intake_id: string;
  session_id: string;
  channel: { type: "lark"; channel_id: string; requester_external_id: string; source_message_id: string };
  draft: TicketIntakeDraft;
  confirmed_at: string;
}

const CLASSIFICATIONS = new Set<TicketIntakeClassification>([
  "answerable_consultation",
  "needs_clarification",
  "incident_candidate",
  "service_request",
]);

function text(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function texts(value: unknown, maxItems = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, 1000)).filter(Boolean).slice(0, maxItems);
}

export function normalizeTicketIntakeDraft(value: unknown): TicketIntakeDraft {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const classification = CLASSIFICATIONS.has(raw.classification as TicketIntakeClassification)
    ? raw.classification as TicketIntakeClassification
    : "needs_clarification";
  return {
    classification,
    summary: text(raw.summary),
    ...(text(raw.product, 200) ? { product: text(raw.product, 200) } : {}),
    ...(text(raw.category, 200) ? { category: text(raw.category, 200) } : {}),
    ...(text(raw.impact) ? { impact: text(raw.impact) } : {}),
    ...(text(raw.affected_object) ? { affected_object: text(raw.affected_object) } : {}),
    ...(text(raw.occurred_at, 200) ? { occurred_at: text(raw.occurred_at, 200) } : {}),
    ...(text(raw.actual_behavior) ? { actual_behavior: text(raw.actual_behavior) } : {}),
    ...(text(raw.expected_behavior) ? { expected_behavior: text(raw.expected_behavior) } : {}),
    attempted_actions: texts(raw.attempted_actions),
    source_refs: texts(raw.source_refs),
    open_questions: texts(raw.open_questions),
    ready_for_review: raw.ready_for_review === true,
  };
}

export function isTicketIntakeReviewable(draft: TicketIntakeDraft): boolean {
  return draft.ready_for_review && Boolean(
    draft.summary && draft.classification && draft.impact && draft.actual_behavior && draft.expected_behavior,
  );
}

export function buildTicketIntakeAgentContext(record: TicketIntakeRecord): string {
  return [
    "<siclaw_ticket_intake>",
    "The user explicitly started a ticket-intake flow. Continue answering product questions from bound knowledge first.",
    "Do not inspect or operate clusters, production systems, hosts, or credentials. Do not claim a ticket was submitted.",
    "Collect only missing user facts, then call ticket_intake_draft with the full latest draft on every turn.",
    "Set ready_for_review=true only when summary, classification, impact, actual_behavior, and expected_behavior are complete and open_questions is empty.",
    "When ready, present a concise review summary and ask the user to use the Feishu confirmation button. The tool cannot confirm.",
    `Current intake: ${JSON.stringify({ id: record.id, revision: record.revision, state: record.state, draft: record.draft })}`,
    "</siclaw_ticket_intake>",
  ].join("\n");
}
