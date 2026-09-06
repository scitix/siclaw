import { describe, expect, it } from "vitest";
import { parseProductSupportResult } from "./result.js";

function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: true,
    info: {
      ticket_type: "incident",
      product: "",
      summary: "Training task cannot start",
      description: "Task task-123 remains Pending after retry.",
      evidence: ["task_id=task-123", "status=Pending"],
      missing_fields: [],
    },
    ...overrides,
  };
}

describe("parseProductSupportResult", () => {
  it("canonicalizes a ticket-ready result", () => {
    const result = parseProductSupportResult(
      validResult({
        info: {
          ticket_type: "incident",
          product: "  Example Product  ",
          summary: "  Task cannot start  ",
          description: "  task-123 remains Pending.  ",
          evidence: [" task_id=task-123 ", "task_id=task-123", " status=Pending "],
          missing_fields: [],
        },
      }),
    );

    expect(result).toEqual({
      label: true,
      info: {
        ticket_type: "incident",
        product: "Example Product",
        summary: "Task cannot start",
        description: "task-123 remains Pending.",
        evidence: ["task_id=task-123", "status=Pending"],
        missing_fields: [],
      },
    });
  });

  it("accepts an incomplete non-handoff result", () => {
    const result = parseProductSupportResult({
      label: false,
      info: {
        ticket_type: "unknown",
        product: "",
        summary: "",
        description: "",
        evidence: [],
        missing_fields: ["affected_product", "error_message"],
      },
    });

    expect(result.label).toBe(false);
    expect(result.info.missing_fields).toEqual(["affected_product", "error_message"]);
  });

  it("requires a concrete product for a ticket-ready requirement", () => {
    expect(() =>
        parseProductSupportResult(
          validResult({
            info: {
              ticket_type: "requirement",
              product: " ",
              summary: "Add an export API",
              description: "The team needs a CSV export API.",
              evidence: [],
              missing_fields: [],
            },
          }),
        )).toThrow(/requires info\.product/);
  });

  it("rejects unresolved ticket-ready results", () => {
    expect(() =>
        parseProductSupportResult(
          validResult({
            info: {
              ticket_type: "unknown",
              product: "",
              summary: "Needs support",
              description: "The request cannot be resolved automatically.",
              evidence: [],
              missing_fields: [],
            },
          }),
        )).toThrow(/resolved ticket_type/);
  });

  it("requires a boolean label", () => {
    expect(() => parseProductSupportResult({ ...validResult(), label: 1 })).toThrow(/label must be a boolean/);
  });

  it("requires a complete ticket title and description", () => {
    const input = validResult();
    input.info = {
      ...(input.info as Record<string, unknown>),
      summary: " ",
    };
    expect(() => parseProductSupportResult(input)).toThrow(/non-empty info\.summary/);
  });

  it("rejects ticket-ready results with missing information", () => {
    expect(() =>
        parseProductSupportResult(
          validResult({
            info: {
              ticket_type: "incident",
              product: "",
              summary: "Task failed",
              description: "Task task-123 failed.",
              evidence: [],
              missing_fields: ["error_message"],
            },
          }),
        )).toThrow(/missing_fields to be empty/);
  });

  it("rejects user-facing questions and prose in missing fields", () => {
    // Both shapes a model reaches for instead of a machine identifier: an
    // English phrase with a space, and a non-ASCII question addressed to the user.
    for (const field of ["affected product", "受影响范围：请确认是否还有其他客户端失败"]) {
      const input = validResult({ label: false });
      input.info = {
        ...(input.info as Record<string, unknown>),
        missing_fields: [field],
      };
      expect(() => parseProductSupportResult(input)).toThrow(/lowercase snake_case field identifier/);
    }
  });

  it("rejects extra fields at both schema levels", () => {
    expect(() => parseProductSupportResult({ ...validResult(), action: "create_ticket" })).toThrow(/input\.action is not allowed/);

    const input = validResult();
    input.info = { ...(input.info as Record<string, unknown>), priority: "P0" };
    expect(() => parseProductSupportResult(input)).toThrow(/input\.info\.priority is not allowed/);
  });

  it("rejects blank evidence entries", () => {
    const input = validResult();
    input.info = { ...(input.info as Record<string, unknown>), evidence: [" "] };
    expect(() => parseProductSupportResult(input)).toThrow(/evidence\[0\] must not be blank/);
  });
});
