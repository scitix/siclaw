import { describe, it, expect, vi } from "vitest";
import { ToolRegistry, type ToolEntry, type ToolRefs } from "./tool-registry.js";

function stubRefs(overrides: Partial<ToolRefs> = {}): ToolRefs {
  return {
    kubeconfigRef: {},
    userId: "u1",
    agentId: null,
    sessionIdRef: { current: "" },
    memoryRef: {},
    dpStateRef: { active: false },
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

  it("allowedTools whitelist passes only listed tools; no exemptions", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "query", create: () => stubToolDef("a") },
      { category: "query", create: () => stubToolDef("b") },
      { category: "workflow", create: () => stubToolDef("c") },
    );
    const tools = reg.resolve({
      mode: "web",
      refs: stubRefs(),
      allowedTools: ["a"], // only "a"; "b" and "c" are excluded
    });
    expect(tools.map((t) => t.name).sort()).toEqual(["a"]);
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

  it("empty allowedTools array yields zero tools", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "query", create: () => stubToolDef("a") },
      { category: "workflow", create: () => stubToolDef("p") },
    );
    const tools = reg.resolve({ mode: "web", refs: stubRefs(), allowedTools: [] });
    expect(tools.map((t) => t.name)).toEqual([]);
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

  it("availableModes scopes a tool to the active operating mode", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "workflow", create: () => stubToolDef("task_create"), availableModes: ["normal"] },
      { category: "workflow", create: () => stubToolDef("dp_only"), availableModes: ["dp"] },
      { category: "query", create: () => stubToolDef("bash") }, // both
    );
    const names = (activeMode?: "normal" | "dp") =>
      reg.resolve({ mode: "web", refs: stubRefs(), activeMode }).map((t) => t.name);
    expect(names("normal")).toEqual(["task_create", "bash"]);
    expect(names("dp")).toEqual(["dp_only", "bash"]);
    expect(names()).toEqual(["task_create", "bash"]); // default = normal
  });

  it("read-only delegation keeps ONLY readOnlyDelegable tools", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "query", create: () => stubToolDef("cluster_list"), readOnlyDelegable: true },
      { category: "cmd-exec", create: () => stubToolDef("node_exec") }, // write — not tagged
      { category: "workflow", create: () => stubToolDef("report_findings"), readOnlyDelegable: true },
      { category: "workflow", create: () => stubToolDef("channel_update") }, // not tagged
    );
    const refs = stubRefs({
      delegation: { delegationId: "d1", readOnly: true },
      sessionEventEmitter: () => {},
    });
    const tools = reg.resolve({ mode: "web", refs });
    expect(tools.map((t) => t.name).sort()).toEqual(["cluster_list", "report_findings"]);
  });

  it("write-tier delegation (readOnly:false) does NOT apply the read-only filter", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "query", create: () => stubToolDef("cluster_list"), readOnlyDelegable: true },
      { category: "cmd-exec", create: () => stubToolDef("node_exec") },
    );
    const refs = stubRefs({ delegation: { delegationId: "d1", readOnly: false } });
    const tools = reg.resolve({ mode: "web", refs });
    expect(tools.map((t) => t.name).sort()).toEqual(["cluster_list", "node_exec"]);
  });

  it("non-delegated turn is unaffected by the read-only filter", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "query", create: () => stubToolDef("cluster_list"), readOnlyDelegable: true },
      { category: "cmd-exec", create: () => stubToolDef("node_exec") },
    );
    const tools = reg.resolve({ mode: "web", refs: stubRefs() });
    expect(tools.map((t) => t.name).sort()).toEqual(["cluster_list", "node_exec"]);
  });

  it("annotates tools that require explicit user approval", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "workflow", create: () => stubToolDef("delegate_to_agent"), requiresUserApproval: true },
      { category: "query", create: () => stubToolDef("safe_lookup") },
    );

    const tools = reg.resolve({ mode: "web", refs: stubRefs() });

    expect(tools.find((t) => t.name === "delegate_to_agent")?.requiresUserApproval).toBe(true);
    expect(tools.find((t) => t.name === "safe_lookup")?.requiresUserApproval).toBeUndefined();
  });

  it("preserves approval metadata after allowedTools filtering", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "workflow", create: () => stubToolDef("delegate_to_agent"), requiresUserApproval: true },
      { category: "query", create: () => stubToolDef("safe_lookup") },
    );

    const tools = reg.resolve({
      mode: "web",
      refs: stubRefs(),
      allowedTools: ["delegate_to_agent"],
    });

    expect(tools.map((t) => t.name)).toEqual(["delegate_to_agent"]);
    expect(tools[0].requiresUserApproval).toBe(true);
  });
});
