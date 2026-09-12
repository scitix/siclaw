import type { ReviewContext } from "./run-client.js";
import type { TicketReviewResult } from "../../mcp/ticket-review-result/src/result.js";

interface Case {
  id: string;
  context: ReviewContext;
  expected: Pick<TicketReviewResult, "ticket_type" | "requirement_kind" | "review_status">;
}

function caseOf(id: string, title: string, text: string | null, expected: Case["expected"]): Case {
  return {
    id,
    context: {
      ticket: { id: `ticket-${id}`, status: "resolved", revision: "completion-1", ...(title ? { title } : {}) },
      records: text ? [{ source: "ticket_comment", id: `record-${id}`, time: "2026-01-01T10:00:00Z", text }] : [],
      coverage: text ? { complete: true, missing: [] } : { complete: false, missing: ["Ticket description and handling records are unavailable"] },
    },
    expected,
  };
}

// Synthetic inputs and separate reviewer assertions. Never send expected to the model.
export const reviewCases: Case[] = [
  caseOf("incident", "Application writes failed", "The operator confirmed the configured log rotation service was disabled. Logs filled the data volume, causing application writes to fail. Enabled rotation and cleaned the old logs. Verified both rotation and application writes succeed.", { ticket_type: "incident", requirement_kind: null, review_status: "ready" }),
  caseOf("governance", "Add recovery for an existing worker defect", "This ticket requests remediation from the worker module owner. The owner added health detection and automatic restart for the existing stuck-worker defect. A fault injection test confirmed recovery and successful job completion. Remediation accepted.", { ticket_type: "requirement", requirement_kind: "governance", review_status: "ready" }),
  caseOf("product", "Request scheduled report downloads for Example Product", "The requester asked the Example Product product manager for scheduled report downloads. The product manager evaluated it and explicitly deferred the feature due to priorities. The requester accepted deferral. No implementation or release date exists.", { ticket_type: "requirement", requirement_kind: "product", review_status: "ready" }),
  caseOf("consultation", "Explain project quota counting", "The requester asked whether a three-instance quota is shared across projects. Support cited the applicable quota documentation: each project has an independent three-instance allowance. The requester confirmed this answered the question.", { ticket_type: "consultation", requirement_kind: null, review_status: "ready" }),
  caseOf("unknown-cause", "Request timeouts recovered after restart", "The operator restarted the worker and requests recovered. No pre-restart logs or diagnostics were preserved. The operator explicitly states the root cause is unknown. Recovery was verified, and the ticket was resolved.", { ticket_type: "incident", requirement_kind: null, review_status: "needs_review" }),
  caseOf("missing", "", null, { ticket_type: null, requirement_kind: null, review_status: "needs_review" }),
  caseOf("conflicting", "Intermittent API request failures", "Requests failed and later recovered. Operator A claims a network failure; operator B claims a process deadlock. Neither supplied supporting diagnostics. The final handling note says the conflicting cause claims remain unresolved.", { ticket_type: "incident", requirement_kind: null, review_status: "needs_review" }),
  caseOf("incident-followup", "Worker crashed during active jobs", "This ticket concerns an actual worker crash interrupting active jobs. Logs confirm the process exhausted its memory limit. Increased the limit and verified jobs complete. A separate governance ticket was created to improve memory monitoring; it is not the subject of this ticket.", { ticket_type: "incident", requirement_kind: null, review_status: "ready" }),
];
