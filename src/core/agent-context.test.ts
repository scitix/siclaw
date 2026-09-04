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

  // 被委托的 turn 跟直接调用解析出同一套 harness。这条曾经断言相反:委托会摘掉
  // peer 的 MCP、memory 和操作安全段。那是调用方在削被调 agent 的能力,而能力是
  // 那个 agent 自己的事。
  it("resolves a delegated turn exactly like a direct one", () => {
    const input = {
      agentType: "sre" as const,
      allowedTools: ["read", "memory_search", "cluster_list"],
      memoryConfigured: true,
    };
    const delegated = resolveAgentHarness({ ...input, delegation: { delegationId: "d1" } });
    const direct = resolveAgentHarness(input);

    expect(delegated.mcpExposure).toBe(direct.mcpExposure);
    expect(delegated.memoryEnabled).toBe(direct.memoryEnabled);
    expect(delegated.includeOperationalSafety).toBe(direct.includeOperationalSafety);
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

  it("gives Coordinator resource-locator routing without its own cluster discovery instructions", () => {
    const context = compileAgentContext({
      agentType: "coordinator",
      allowedTools: ["read", "list_delegates", "delegate_to_agent"],
      memoryConfigured: true,
      mode: "channel",
    });

    expect(context.systemPrompt).toContain("# Coordinator Contract");
    expect(context.systemPrompt).toContain("resource-locator helper");
    expect(context.systemPrompt).toContain("binding_name_confirmed=true");
    expect(context.systemPrompt).not.toContain("# Infrastructure Access");
    expect(context.systemPrompt).not.toContain("Settings → Clusters");
    expect(context.harness.mcpExposure).toBe("configured");
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
