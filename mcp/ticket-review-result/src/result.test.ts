import { describe, expect, it } from "vitest";
import { MAX_RESULT_BYTES, parseTicketReviewResult } from "./result.js";

import { drafts } from "../test/fixtures.js";

describe("ticket review contract", () => {
  it.each(drafts)("accepts $ticket_id without changing its content", (draft) => {
    expect(parseTicketReviewResult(draft)).toEqual(draft);
  });

  it.each([
    ["extra handoff field", { label: true }],
    ["legacy incident enum", { ticket_type: "llm_incident" }],
    ["non-requirement subtype", { requirement_kind: "governance" }],
    ["unknown ready category", { ticket_type: null }],
    ["unresolved ready requirement", { ticket_type: "requirement" }],
    ["ready without evidence", { evidence: [] }],
    ["ready with a question", { open_questions: ["Confirm the cause"] }],
    ["review without a question", { review_status: "needs_review" }],
    ["blank type", { type: " \n\t" }],
    ["blank result", { result: "" }],
    ["unknown source", { evidence: [{ source: "url", id: "example" }] }],
    ["blank source ID", { evidence: [{ source: "ticket", id: " " }] }],
    ["extra evidence field", { evidence: [{ source: "ticket", id: "example", read: true }] }],
    ["duplicate references", { evidence: [drafts[0].evidence[0], drafts[0].evidence[0]] }],
  ])("rejects %s", (_name, patch) => {
    expect(() => parseTicketReviewResult({ ...drafts[0], ...patch })).toThrow();
  });

  it("accepts an unresolved requirement only as an incomplete draft", () => {
    expect(parseTicketReviewResult({ ...drafts[5], ticket_type: "requirement" }).requirement_kind).toBeNull();
  });

  it("requires every field, including explicit nulls", () => {
    for (const key of Object.keys(drafts[0])) {
      const incomplete = { ...drafts[0] } as Record<string, unknown>;
      delete incomplete[key];
      expect(() => parseTicketReviewResult(incomplete), key).toThrow();
    }
    for (const input of [null, undefined, [], "result", 1]) {
      expect(() => parseTicketReviewResult(input)).toThrow();
    }
  });

  it("rejects blank or duplicate review questions", () => {
    for (const questions of [[" "], ["Cause?", "Cause?"]]) {
      expect(() => parseTicketReviewResult({ ...drafts[5], open_questions: questions })).toThrow();
    }
  });

  it("bounds serialized bytes including unicode and escaping without truncation", () => {
    const emptySize = Buffer.byteLength(JSON.stringify({ ...drafts[0], result: "" }));
    const atLimit = { ...drafts[0], result: "x".repeat(MAX_RESULT_BYTES - emptySize) };
    expect(parseTicketReviewResult(atLimit)).toEqual(atLimit);
    expect(() => parseTicketReviewResult({ ...atLimit, result: atLimit.result + "x" })).toThrow(/UTF-8 bytes/);
    for (const text of ["\u{1F4DD}".repeat(7000), "\u0000".repeat(5000)]) {
      expect(() => parseTicketReviewResult({ ...drafts[0], result: text })).toThrow(/UTF-8 bytes/);
    }
  });
});
