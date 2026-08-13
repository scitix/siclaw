import { describe, expect, it, vi } from "vitest";
import {
  normalizeStructuredResultToolParameters,
  normalizeStructuredResultContract,
  StructuredResultController,
  STRUCTURED_RESULT_TOOL_NAME,
  withStructuredResultTool,
} from "./structured-result.js";
import { ToolRegistry, type ToolRefs } from "./tool-registry.js";
import { registration as submitStructuredResultRegistration } from "../tools/workflow/submit-structured-result.js";

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

    controller.finishTurn("completed");
    turnRef.current = 2;
    controller.beginTurn();
    expect(controller.submit({ label: true, info: { summary: "ready" } }).ok).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("emits an explicit missing event instead of fabricating a result", () => {
    const emit = vi.fn();
    const controller = new StructuredResultController(contract, { current: 7 }, emit);
    controller.beginTurn();
    controller.finishTurn("completed");
    expect(emit).toHaveBeenCalledWith({
      type: "structured_result_missing",
      contract_id: "product_support.v1",
      turn: 7,
    });
  });

  it("lets the original error own a failed required turn", () => {
    const emit = vi.fn();
    const controller = new StructuredResultController(contract, { current: 8 }, emit);
    controller.beginTurn();
    controller.finishTurn("error");
    expect(emit).not.toHaveBeenCalled();
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

describe("structured-result tool configuration", () => {
  it("keeps a contracted tool reachable for a restricted agent", () => {
    const controller = new StructuredResultController(contract, { current: 1 }, vi.fn());
    const refs = {
      structuredResultController: controller,
      sessionIdRef: { current: "contracted-session" },
    } as unknown as ToolRefs;
    const registry = new ToolRegistry();
    registry.register(submitStructuredResultRegistration);

    const tools = registry.resolve({
      mode: "web",
      refs,
      allowedTools: withStructuredResultTool(["read"], true),
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(STRUCTURED_RESULT_TOOL_NAME);
  });

  it("projects a valid contract into a restricted allow-list without mutating it", () => {
    const configured = ["read"];
    expect(withStructuredResultTool(configured, true)).toEqual(["read", STRUCTURED_RESULT_TOOL_NAME]);
    expect(configured).toEqual(["read"]);
  });

  it("does not create a second switch for unrestricted or uncontracted agents", () => {
    expect(withStructuredResultTool(null, true)).toBeNull();
    expect(withStructuredResultTool(["read"], false)).toEqual(["read"]);
    expect(withStructuredResultTool([STRUCTURED_RESULT_TOOL_NAME], true)).toEqual([STRUCTURED_RESULT_TOOL_NAME]);
  });

  it("normalizes provider-facing parameters without changing contract semantics", () => {
    const schema = {
      type: "object",
      additionalProperties: { type: "string" },
      anyOf: [{ required: ["summary"] }],
    };
    expect(normalizeStructuredResultToolParameters(schema)).toEqual({
      ...schema,
      properties: {},
    });
    expect(schema).not.toHaveProperty("properties");
  });
});
