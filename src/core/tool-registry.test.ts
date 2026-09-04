import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry, TOOL_EFFECTS, effectForTool, recordMcpToolEffect, resetMcpToolEffects, type ToolEntry, type ToolRefs } from "./tool-registry.js";
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

  it("defaults an unknown STATIC tool name to observe", () => {
    // 静态名字落到 observe 是安全的,因为每个会改东西的内建工具都登记在 TOOL_EFFECTS
    // 里,下面那条测试钉着这一点。动态名字(MCP)不适用 —— 见再下面那一组。
    expect(effectForTool("no_such_tool")).toBe("observe");
    expect(effectForTool("")).toBe("observe");
  });

  /**
   * 🔴 **MCP 工具不落到 observe —— 未登记时按 external_write（P0 修复）。**
   *
   * ⚠️ 这一条钉的是一个**真实存在过的绕过**：MCP 工具的名字是动态的
   * （`mcp__server__tool`），按定义登记不进 TOOL_EFFECTS，于是 `effectForTool` 对它们
   * 一律返回 `observe`。结果是在只读调查里（ceiling=observe），**任意 MCP 写工具都能
   * 直接执行** —— guard 认为它是读。
   *
   * ⚠️ TOOL_EFFECTS 的注释当时已经写明了这个洞，并指向 Envelope 的
   * `allowedCapabilities` 作为缓解 —— 而 Sicore 侧从来没有签发过 allow-list
   * （gate.go 明确注释说不签）。**一条只存在于注释里的控制等于没有控制。**
   *
   * 现在：服务器声明 readOnlyHint 才是 observe，其余一律 external_write。
   */
  describe("MCP 工具的 effect", () => {
    beforeEach(() => resetMcpToolEffects());

    it("没登记过的 MCP 工具按 external_write，不按 observe", () => {
      expect(effectForTool("mcp__grafana__delete_dashboard")).toBe("external_write");
    });

    it("服务器声明 readOnlyHint 才降到 observe", () => {
      recordMcpToolEffect("mcp__grafana__get_panel", true);
      expect(effectForTool("mcp__grafana__get_panel")).toBe("observe");
    });

    it("readOnlyHint 缺席或为假一律 external_write", () => {
      recordMcpToolEffect("mcp__k8s__apply", false);
      recordMcpToolEffect("mcp__k8s__patch", undefined);
      expect(effectForTool("mcp__k8s__apply")).toBe("external_write");
      expect(effectForTool("mcp__k8s__patch")).toBe("external_write");
    });

    it("静态登记优先于动态记录 —— 同名内建不会被 MCP 记录覆盖", () => {
      // 防御一种边角:某个 MCP 服务器起了个和内建重名的工具。静态声明是平台自己写的,
      // 它说了算。
      expect(effectForTool("bash")).toBe("external_write");
    });
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
