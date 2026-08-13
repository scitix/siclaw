import { describe, expect, it, vi } from "vitest";
import {
  normalizeStructuredResultContract,
  StructuredResultController,
} from "./structured-result.js";

const contract = normalizeStructuredResultContract({
  id: "product_support.v1",
  description: "Return whether the request is ready for human support.",
  required: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["label", "info"],
    properties: {
      label: { type: "boolean" },
      info: { type: "object" },
    },
  },
})!;

describe("StructuredResultController", () => {
  it("validates, emits once per turn, and permits the next turn", () => {
    const emit = vi.fn();
    const turnRef = { current: 1 };
    const controller = new StructuredResultController(contract, turnRef, emit);
    controller.beginTurn();

    expect(controller.submit({ label: "yes", info: {} }).ok).toBe(false);
    expect(emit).not.toHaveBeenCalled();

    const first = controller.submit({ label: false, info: {} });
    expect(first.ok).toBe(true);
    expect(controller.submit({ label: true, info: {} }).ok).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      type: "structured_result",
      contract_id: "product_support.v1",
      turn: 1,
      data: { label: false, info: {} },
    });

    controller.finishTurn();
    turnRef.current = 2;
    controller.beginTurn();
    expect(controller.submit({ label: true, info: { summary: "ready" } }).ok).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("emits an explicit missing event instead of fabricating a result", () => {
    const emit = vi.fn();
    const controller = new StructuredResultController(contract, { current: 7 }, emit);
    controller.beginTurn();
    controller.finishTurn();
    expect(emit).toHaveBeenCalledWith({
      type: "structured_result_missing",
      contract_id: "product_support.v1",
      turn: 7,
    });
  });

  it("rejects remote refs and non-object schemas at the boundary", () => {
    expect(() => normalizeStructuredResultContract({
      id: "x.v1", description: "x", schema: { type: "string" },
    })).toThrow("type=object");
    expect(() => normalizeStructuredResultContract({
      id: "x.v1", description: "x", schema: { type: "object", properties: { x: { $ref: "https://x" } } },
    })).toThrow("$ref");
    expect(() => normalizeStructuredResultContract({
      id: "x.v1", description: "x", schema: { type: "object", required: ["x", 1] },
    })).toThrow("array of strings");
    expect(() => normalizeStructuredResultContract({
      id: "x.v1", description: "x", schema: { type: "object", properties: { x: { pattern: "[" } } },
    })).toThrow("valid regular expression");
  });
});
