import { describe, it, expect, vi } from "vitest";
import { ToolRegistry, type ToolEntry, type ToolRefs } from "./tool-registry.js";

function stubRefs(overrides: Partial<ToolRefs> = {}): ToolRefs {
  return {
    kubeconfigRef: {},
    userId: "u1",
    agentId: null,
    sessionIdRef: { current: "" },
    llmConfigRef: {},
    memoryRef: {},
    dpStateRef: { status: "idle" },
    ...overrides,
  };
}

function stubToolDef(name: string): any {
  return {
    name,
    label: name,
    description: "stub",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "" }], details: {} };
    },
  };
}

describe("ToolRegistry", () => {
  it("resolve() returns all tools when no mode/allow-list filtering applies", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "query", create: () => stubToolDef("a") },
      { category: "query", create: () => stubToolDef("b") },
    );
    const tools = reg.resolve({ mode: "web", refs: stubRefs() });
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("mode filter excludes tools not allowed for the session mode", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "workflow", create: () => stubToolDef("web_only"), modes: ["web"] },
      { category: "query", create: () => stubToolDef("all_modes") },
    );
    const tools = reg.resolve({ mode: "cli", refs: stubRefs() });
    expect(tools.map((t) => t.name)).toEqual(["all_modes"]);
  });

  it("available() guard skips the tool and does not call create()", () => {
    const createA = vi.fn(() => stubToolDef("a"));
    const createB = vi.fn(() => stubToolDef("b"));
    const reg = new ToolRegistry();
    reg.register(
      { category: "query", create: createA, available: () => false },
      { category: "query", create: createB, available: () => true },
    );
    const tools = reg.resolve({ mode: "web", refs: stubRefs() });
    expect(tools.map((t) => t.name)).toEqual(["b"]);
    expect(createA).not.toHaveBeenCalled();
    expect(createB).toHaveBeenCalledTimes(1);
  });

  it("allowedTools filters non-platform tools; platform tools pass through", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "query", create: () => stubToolDef("a") },
      { category: "query", create: () => stubToolDef("b") },
      { category: "workflow", create: () => stubToolDef("platform_one"), platform: true },
    );
    const tools = reg.resolve({
      mode: "web",
      refs: stubRefs(),
      allowedTools: ["a"], // only "a" from non-platform tools, plus platform tool always
    });
    expect(tools.map((t) => t.name).sort()).toEqual(["a", "platform_one"]);
  });

  it("allowedTools = null disables whitelist (all tools passing mode+available included)", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "query", create: () => stubToolDef("a") },
      { category: "query", create: () => stubToolDef("b") },
    );
    const tools = reg.resolve({ mode: "web", refs: stubRefs(), allowedTools: null });
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("empty allowedTools array filters out non-platform tools only", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "query", create: () => stubToolDef("a") },
      { category: "workflow", create: () => stubToolDef("p"), platform: true },
    );
    const tools = reg.resolve({ mode: "web", refs: stubRefs(), allowedTools: [] });
    expect(tools.map((t) => t.name)).toEqual(["p"]);
  });

  it("register supports variadic entries", () => {
    const reg = new ToolRegistry();
    const entries: ToolEntry[] = [
      { category: "query", create: () => stubToolDef("x") },
      { category: "query", create: () => stubToolDef("y") },
    ];
    reg.register(...entries);
    expect(reg.resolve({ mode: "web", refs: stubRefs() }).map((t) => t.name)).toEqual(["x", "y"]);
  });

  it("passes refs through to create() and available()", () => {
    const reg = new ToolRegistry();
    const refs = stubRefs({ userId: "tester" });
    const availableSpy = vi.fn(() => true);
    const createSpy = vi.fn(() => stubToolDef("r"));
    reg.register({ category: "query", create: createSpy, available: availableSpy });
    reg.resolve({ mode: "web", refs });
    expect(availableSpy).toHaveBeenCalledWith(refs);
    expect(createSpy).toHaveBeenCalledWith(refs);
  });

  it("mode undefined in entry means applicable to all modes", () => {
    const reg = new ToolRegistry();
    reg.register({ category: "query", create: () => stubToolDef("univ") });
    for (const mode of ["web", "cli", "channel", "task"] as const) {
      const tools = reg.resolve({ mode, refs: stubRefs() });
      expect(tools.map((t) => t.name)).toEqual(["univ"]);
    }
  });
});
