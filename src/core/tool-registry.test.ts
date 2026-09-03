import { describe, it, expect, vi } from "vitest";
import { ToolRegistry, TOOL_EFFECTS, effectForTool, type ToolEntry, type ToolRefs } from "./tool-registry.js";
import { CAPABILITY_GROUPS } from "./tool-capabilities.js";

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

  it("uses each registry entry category as its invocation toolset", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "query", create: () => stubToolDef("lookup") },
      { category: "workflow", create: () => stubToolDef("delegate") },
    );

    const tools = reg.resolve({ mode: "web", refs: stubRefs() });
    expect(tools.map((t) => [t.name, t.toolset])).toEqual([
      ["lookup", "query"],
      ["delegate", "workflow"],
    ]);
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

describe("declared tool effects", () => {
  it("carries a declared effect onto the resolved definition", () => {
    const reg = new ToolRegistry();
    reg.register(
      { category: "cmd-exec", create: () => stubToolDef("bash"), effect: "external_write" },
      { category: "query", create: () => stubToolDef("read") },
    );
    const tools = reg.resolve({ mode: "web", refs: stubRefs() });
    expect(tools.find((t) => t.name === "bash")?.effect).toBe("external_write");
    // Undeclared stays undeclared on the definition; effectForTool supplies the
    // `observe` default at the point of comparison.
    expect(tools.find((t) => t.name === "read")?.effect).toBeUndefined();
  });

  it("preserves the effect after allowedTools filtering", () => {
    const reg = new ToolRegistry();
    reg.register({ category: "cmd-exec", create: () => stubToolDef("bash"), effect: "external_write" });
    const tools = reg.resolve({ mode: "web", refs: stubRefs(), allowedTools: ["bash"] });
    expect(tools[0].effect).toBe("external_write");
  });

  it("defaults an unknown tool name to observe", () => {
    expect(effectForTool("no_such_tool")).toBe("observe");
    expect(effectForTool("")).toBe("observe");
  });

  /**
   * THE GUARD AGAINST A FUTURE MUTATING TOOL DEFAULTING TO `observe`.
   *
   * `effectForTool` answers `observe` for anything undeclared, which is only
   * safe while every mutating tool IS declared. This test is what keeps that
   * true: add a tool to any capability group below without declaring its effect
   * and the build fails here, instead of the tool silently running under an
   * observe-only authority envelope.
   */
  it("declares a non-observe effect for every tool in a mutating capability group", () => {
    // Groups whose members change something: files, real infrastructure, other
    // agents, or future unattended work.
    const MUTATING_GROUPS = [
      "write_sandbox",
      "run_commands",
      "run_scripts",
      "spawn_subagents",
      "delegate_agents",
      "scheduling",
    ];
    // Read-only members that legitimately sit in a mutating group, each with the
    // reason. A new name may only be added here with an equally concrete one.
    const READ_ONLY_MEMBERS: Record<string, string> = {
      // Grouped under run_commands for round-trip efficiency, but it is a
      // read-only cluster read (see CAPABILITY_GROUPS' own note).
      k8s_inspect: "read-only kubectl view",
      task_output: "reads a background job's output",
      list_delegates: "reads the delegation roster",
    };

    const undeclared: string[] = [];
    for (const group of MUTATING_GROUPS) {
      const members = CAPABILITY_GROUPS[group];
      expect(members, `capability group "${group}" no longer exists — update this test`).toBeDefined();
      for (const name of members) {
        if (name in READ_ONLY_MEMBERS) continue;
        if (effectForTool(name) === "observe") undeclared.push(`${group}/${name}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("keeps every TOOL_EFFECTS value a legal, non-observe effect", () => {
    // An `observe` entry in the map is dead weight (it is the default) and hints
    // at a mistaken declaration; anything outside the vocabulary is a typo.
    const legal = new Set(["local_write", "external_write", "destructive", "credential_read"]);
    for (const [name, effect] of Object.entries(TOOL_EFFECTS)) {
      expect(legal.has(effect), `${name} declares "${effect}"`).toBe(true);
    }
  });
});
