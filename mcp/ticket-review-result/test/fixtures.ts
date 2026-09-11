import type { TicketReviewResult } from "../src/result.js";

// Synthetic reviewer-authored drafts, not model outputs.
export const drafts: TicketReviewResult[] = [
  {
    ticket_id: "ticket-example-1", ticket_type: "incident", requirement_kind: null,
    type: "Log rotation failure",
    result: "Unloaded rotation configuration filled the volume. Loading it and cleaning logs restored writes; rotation and writes were verified.",
    review_status: "ready", evidence: [{ source: "ticket_comment", id: "comment-example-1" }], open_questions: [],
  },
  {
    ticket_id: "ticket-example-2", ticket_type: "requirement", requirement_kind: "governance",
    type: "Plugin self-recovery remediation",
    result: "The module owner implemented failure detection and recovery. Process-exit injection verified recovery and resource availability.",
    review_status: "ready", evidence: [{ source: "group_message", id: "message-example-2" }], open_questions: [],
  },
  {
    ticket_id: "ticket-example-3", ticket_type: "requirement", requirement_kind: "product",
    type: "Telephone alert feature request",
    result: "The product manager deferred telephone alerts due to current priorities. The requester accepted deferral; no implementation or release date was promised.",
    review_status: "ready", evidence: [{ source: "ticket_comment", id: "comment-example-3" }], open_questions: [],
  },
  {
    ticket_id: "ticket-example-4", ticket_type: "consultation", requirement_kind: null,
    type: "Project instance quota question",
    result: "Support verified a three-instance limit per project with independent counting and no additional cross-project limit. The requester confirmed understanding.",
    review_status: "ready", evidence: [{ source: "ticket_comment", id: "comment-example-4" }], open_questions: [],
  },
  {
    ticket_id: "ticket-example-5", ticket_type: "incident", requirement_kind: null,
    type: "Request timeout",
    result: "Requests recovered after restart. No pre-restart diagnostics were retained; the root cause remains unknown.",
    review_status: "needs_review", evidence: [{ source: "ticket_comment", id: "comment-example-5" }],
    open_questions: ["What evidence establishes the timeout cause?"],
  },
  {
    ticket_id: "ticket-example-6", ticket_type: null, requirement_kind: null,
    type: "Classification pending", result: "Only the ticket ID is available; no ticket or handling records were read.",
    review_status: "needs_review", evidence: [], open_questions: ["Provide ticket details, handling records and associated group messages."],
  },
];
