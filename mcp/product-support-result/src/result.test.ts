import { describe, expect, it } from "vitest";
import { parseProductSupportResult } from "./result.js";

function emptyLlm(): Record<string, string> {
  return { region: "", aspect: "", model: "" };
}

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
      llm: emptyLlm(),
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
          llm: emptyLlm(),
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
        llm: { region: "", aspect: "", model: "" },
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
        llm: emptyLlm(),
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
              llm: emptyLlm(),
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
              llm: emptyLlm(),
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
              llm: emptyLlm(),
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

  it("canonicalizes a ticket-ready llm_incident with best-effort intake details", () => {
    const result = parseProductSupportResult(
      validResult({
        info: {
          ticket_type: "llm_incident",
          product: "",
          summary: "Chat completions return 429",
          description: "Calls to the model API return HTTP 429 since this morning.",
          evidence: ["HTTP 429", "model=example-model-v2"],
          missing_fields: [],
          llm: { region: " Overseas ", aspect: "MODEL", model: "  example-model-v2 " },
        },
      }),
    );

    expect(result.info.ticket_type).toBe("llm_incident");
    expect(result.info.llm).toEqual({
      region: "overseas",
      aspect: "model",
      model: "example-model-v2",
    });
  });

  it("lets an llm_incident hand off with empty intake details instead of forcing a guess", () => {
    const result = parseProductSupportResult(
      validResult({
        info: {
          ticket_type: "llm_incident",
          product: "",
          summary: "Model API requests time out",
          description: "The user reports timeouts on every request; region and model were not stated.",
          evidence: ["timeout"],
          missing_fields: [],
          llm: { region: "", aspect: "network", model: "" },
        },
      }),
    );

    expect(result.label).toBe(true);
    expect(result.info.llm).toEqual({ region: "", aspect: "network", model: "" });
  });

  it("keeps llm intake identifiers usable in missing_fields while still gathering", () => {
    const result = parseProductSupportResult({
      label: false,
      info: {
        ticket_type: "llm_incident",
        product: "",
        summary: "",
        description: "",
        evidence: ["HTTP 401"],
        missing_fields: ["llm_region", "llm_aspect"],
        llm: { region: "", aspect: "", model: "example-model-v2" },
      },
    });

    expect(result.info.missing_fields).toEqual(["llm_region", "llm_aspect"]);
    expect(result.info.llm.model).toBe("example-model-v2");
  });

  it("rejects region and aspect values outside the enum", () => {
    for (const llm of [
      { region: "eu", aspect: "", model: "" },
      { region: "", aspect: "billing", model: "" },
    ]) {
      const input = validResult({ label: false });
      input.info = { ...(input.info as Record<string, unknown>), ticket_type: "llm_incident", llm };
      expect(() => parseProductSupportResult(input)).toThrow(/must be empty or one of/);
    }
  });

  it("rejects llm intake details on any other ticket type", () => {
    for (const ticketType of ["incident", "consultation", "requirement", "unknown"]) {
      const input = validResult({ label: false });
      input.info = {
        ...(input.info as Record<string, unknown>),
        ticket_type: ticketType,
        llm: { region: "domestic", aspect: "", model: "" },
      };
      expect(() => parseProductSupportResult(input)).toThrow(/unless ticket_type is llm_incident/);
    }
  });

  it("requires the llm block with exactly its three keys", () => {
    const missing = validResult();
    delete (missing.info as Record<string, unknown>).llm;
    expect(() => parseProductSupportResult(missing)).toThrow(/input\.info\.llm is required/);

    const extra = validResult();
    extra.info = {
      ...(extra.info as Record<string, unknown>),
      llm: { region: "", aspect: "", model: "", vendor: "x" },
    };
    expect(() => parseProductSupportResult(extra)).toThrow(/input\.info\.llm\.vendor is not allowed/);

    const partial = validResult();
    partial.info = { ...(partial.info as Record<string, unknown>), llm: { region: "", aspect: "" } };
    expect(() => parseProductSupportResult(partial)).toThrow(/input\.info\.llm\.model is required/);
  });
});
