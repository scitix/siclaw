import { describe, expect, it } from "vitest";

import {
  compileAgentContext,
  createAgentContextManifest,
  resolveAgentHarness,
} from "./agent-context.js";

describe("resolveAgentHarness", () => {
  it("fails closed when type/capability resolution did not complete", () => {
    const harness = resolveAgentHarness({
      agentType: "sre",
      allowedTools: null,
      harnessResolved: false,
      memoryConfigured: true,
    });

    expect(harness.resolution).toBe("unresolved");
    expect(harness.allowedTools).toEqual([]);
    expect(harness.mcpExposure).toBe("none");
    expect(harness.memoryEnabled).toBe(false);
    expect(harness.includeBundledSkills).toBe(false);
    expect(harness.includeInfrastructureGuidance).toBe(false);
  });

  it("keeps null unrestricted only as explicit legacy Custom compatibility", () => {
    const harness = resolveAgentHarness({
      agentType: "custom",
      allowedTools: null,
      memoryConfigured: true,
    });

    expect(harness.legacyUnrestrictedCustom).toBe(true);
    expect(harness.includeInfrastructureGuidance).toBe(true);
    expect(harness.includeOperationalSafety).toBe(true);
  });

  it("expands null to the locked capability set for Knowledge QA", () => {
    const harness = resolveAgentHarness({
      agentType: "knowledge_qa",
      allowedTools: null,
      memoryConfigured: true,
    });

    expect(harness.allowedTools).toEqual([
      "read", "grep", "find", "ls", "knowledge_search", "knowledge_cite",
    ]);
    expect(harness.legacyUnrestrictedCustom).toBe(false);
    expect(harness.includeBundledSkills).toBe(false);
    expect(harness.includeInfrastructureGuidance).toBe(false);
  });

  it("keeps Product Support read-only while exposing its configured result MCP", () => {
    const harness = resolveAgentHarness({
      agentType: "product_support",
      allowedTools: null,
      memoryConfigured: true,
    });

    expect(harness.allowedTools).toEqual([
      "read", "grep", "find", "ls", "knowledge_search", "knowledge_cite",
    ]);
    expect(harness.mcpExposure).toBe("configured");
    expect(harness.memoryEnabled).toBe(false);
    expect(harness.includeInfrastructureGuidance).toBe(false);
    expect(harness.includeOperationalSafety).toBe(false);
    expect(harness.legacyUnrestrictedCustom).toBe(false);
  });

  it("rejects an unknown type instead of normalizing it to unrestricted Custom", () => {
    expect(() => resolveAgentHarness({
      agentType: "future_type",
      allowedTools: null,
      memoryConfigured: true,
    })).toThrow("Invalid or missing agent_type");
  });

  it("adds the automated-task report tool without broadening interactive capabilities", () => {
    const task = resolveAgentHarness({
      agentType: "knowledge_qa",
      allowedTools: null,
      memoryConfigured: false,
      mode: "task",
    });
    const web = resolveAgentHarness({
      agentType: "knowledge_qa",
      allowedTools: null,
      memoryConfigured: false,
      mode: "web",
    });

    expect(task.allowedTools).toContain("task_report");
    expect(web.allowedTools).not.toContain("task_report");
  });
});

describe("compileAgentContext", () => {
  it("uses Product Support's managed persisted prompt without SRE guidance", () => {
    const context = compileAgentContext({
      agentType: "product_support",
      allowedTools: ["read", "knowledge_search", "knowledge_cite"],
      memoryConfigured: true,
      mode: "channel",
      agentPrompt: "Managed product support contract",
    });

    expect(context.systemPrompt).toContain("Managed product support contract");
    expect(context.systemPrompt).toContain("product-support agent");
    expect(context.systemPrompt).toContain("result-submission tool");
    expect(context.systemPrompt).not.toContain("personal SRE AI assistant");
    expect(context.systemPrompt).not.toContain("cluster_list");
    expect(context.harness.mcpExposure).toBe("configured");
  });

  it("gives Knowledge QA a role-clean prompt with no SRE or memory guidance", () => {
    const context = compileAgentContext({
      agentType: "knowledge_qa",
      allowedTools: ["read", "grep", "find", "ls", "knowledge_search", "knowledge_cite"],
      memoryConfigured: true,
      mode: "channel",
    });

    expect(context.systemPrompt).toContain("knowledge-base question answering agent");
    expect(context.systemPrompt).not.toContain("personal SRE AI assistant");
    expect(context.systemPrompt).not.toContain("cluster_list");
    expect(context.systemPrompt).not.toContain("Settings → Clusters");
    expect(context.systemPrompt).not.toContain("memory_search");
    expect(context.systemPrompt).not.toContain("task_create");
    expect(context.systemPrompt).not.toContain("spawn_subagent");
    expect(context.systemPrompt).not.toContain("delete/evict/cordon");
    expect(context.systemPrompt).not.toContain("knowledge_search");
    expect(context.systemPrompt).not.toContain("complete mounted Wiki catalog as the primary navigation map");
    expect(context.systemPrompt).not.toContain("Use `knowledge_search` before answering");
    expect(context.systemPrompt).toContain("# Channel Reply Format");
    expect(context.harness.includeBundledSkills).toBe(false);
    expect(context.harness.mcpExposure).toBe("configured");
  });

  it("retains SRE infrastructure, workflow, memory, and operational guidance", () => {
    const context = compileAgentContext({
      agentType: "sre",
      allowedTools: [
        "cluster_list", "host_list", "bash", "memory_search", "memory_get",
        "task_create", "task_update", "spawn_subagent",
      ],
      memoryConfigured: true,
      mode: "web",
    });

    expect(context.systemPrompt).toContain("specialist SRE agent");
    expect(context.systemPrompt).toContain("cluster_list");
    expect(context.systemPrompt).toContain("delete/evict/cordon");
    expect(context.systemPrompt).toContain("memory_search");
    expect(context.systemPrompt).toContain("task_create");
    expect(context.systemPrompt).toContain("spawn_subagent");
    expect(context.harness.includeBundledSkills).toBe(true);
  });
});

describe("createAgentContextManifest", () => {
  it("records deterministic hashes and sorted model-visible names without prompt content", () => {
    const context = compileAgentContext({
      agentType: "knowledge_qa",
      allowedTools: ["read", "knowledge_cite"],
      memoryConfigured: false,
      mode: "web",
    });
    const manifest = createAgentContextManifest({
      context,
      mode: "web",
      tools: [{ name: "read" }, { name: "knowledge_cite" }],
      skillNames: ["research", "catalog"],
      mcpServerNames: ["knowledge-search"],
      knowledgeMounted: true,
    });

    expect(manifest.tools.names).toEqual(["knowledge_cite", "read"]);
    expect(manifest.skills.names).toEqual(["catalog", "research"]);
    expect(manifest.resources.mcpExposure).toBe("configured");
    expect(manifest.resources.mcpServers).toEqual(["knowledge-search"]);
    expect(manifest.prompt.chars).toBe(context.systemPrompt.length);
    expect(manifest.prompt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.prompt.assemblyVersion).toBe("prompt-assembly/v1");
    expect(manifest.prompt.layers.map((layer) => layer.id)).toContain("agent_type.contract");
    expect(JSON.stringify(manifest)).not.toContain("question answering agent");
  });
});


describe("handoff conversation contract", () => {
  it.each(["sre", "knowledge_qa", "product_support", "custom"])("gives %s the same main-conversation transfer semantics", (agentType) => {
    const context = compileAgentContext({ agentType, allowedTools: null, memoryConfigured: false, mode: "web", handoffAvailable: true });
    expect(context.systemPrompt).toContain("Conversation ownership: transfer_to_agent is available");
    expect(context.systemPrompt).toContain("transfer_to_agent");
  });
  it.each([
    { handoffAvailable: false }, { harnessResolved: false },
    { mode: "cli" as const },
  ])("does not instruct sessions without handoff authority to transfer: %j", (overrides) => {
    const context = compileAgentContext({ agentType: "knowledge_qa", allowedTools: null, memoryConfigured: false, mode: "web", handoffAvailable: true, ...overrides });
    expect(context.systemPrompt).not.toContain("Conversation ownership: transfer_to_agent is available");
  });
});

it("gives the last conversation owner explicit honest closure guidance", () => {
  const compiled = compileAgentContext({ agentType: "sre", mode: "web", allowedTools: null, memoryConfigured: false,
    handoffAvailable: false, handoffPolicy: { remaining: 0, visitedAgentIds: ["a", "b", "c"], history: [] } });
  expect(JSON.stringify(compiled)).toContain("Further conversation transfers are disabled");
  expect(JSON.stringify(compiled)).toContain("specific missing information or access");
  expect(JSON.stringify(compiled)).not.toContain("transfer_to_agent is available for this main conversation");
});

it("asks for concrete missing information when the managed owner has no eligible targets", () => {
  const compiled = compileAgentContext({ agentType: "custom", mode: "channel", allowedTools: ["read"], memoryConfigured: false,
    handoffAvailable: false, handoffPolicy: { remaining: 2, visitedAgentIds: ["a"], history: [] } });
  expect(compiled.systemPrompt).toContain("No eligible authorized transfer destination");
  expect(compiled.systemPrompt).toContain("specific missing information or access");
});

describe("subagent prompt layers", () => {
  it("retains business policy and safety but omits parent-only planning and spawning guidance", () => {
    const input = { agentType: "sre", allowedTools: ["read", "cluster_list", "task_create", "task_update", "spawn_subagent"], memoryConfigured: false, agentPrompt: "Only operate in the assigned region" };
    const parent = compileAgentContext(input);
    const child = compileAgentContext({ ...input, isSubagent: true, subagentPrompt: "Investigate independently; report gaps to the caller" });
    expect(child.systemPrompt).toContain(input.agentPrompt);
    expect(child.systemPrompt).toContain("Investigate independently; report gaps to the caller");
    expect(child.harness.includePlanningGuidance).toBe(false);
    expect(child.harness.includeSubagentGuidance).toBe(false);
    expect(parent.harness.includeSubagentGuidance).toBe(true);
    expect(child.harness.includeOperationalSafety).toBe(parent.harness.includeOperationalSafety);
    expect(child.harness.allowedTools).toEqual(parent.harness.allowedTools);
    expect(parent.systemPrompt).not.toContain("Investigate independently; report gaps to the caller");
  });
});
