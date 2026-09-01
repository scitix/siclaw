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

  it("rejects an unknown type instead of normalizing it to unrestricted Custom", () => {
    expect(() => resolveAgentHarness({
      agentType: "future_type",
      allowedTools: null,
      memoryConfigured: true,
    })).toThrow("Invalid or missing agent_type");
  });

  it("removes MCP and memory from delegated read-only work", () => {
    const harness = resolveAgentHarness({
      agentType: "sre",
      allowedTools: ["read", "memory_search", "cluster_list"],
      memoryConfigured: true,
      delegation: { delegationId: "d1", readOnly: true },
    });

    expect(harness.mcpExposure).toBe("none");
    expect(harness.memoryEnabled).toBe(false);
    expect(harness.includeOperationalSafety).toBe(false);
  });
});

describe("compileAgentContext", () => {
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
    // Retrieval policy is injected with the runtime-scoped Wiki context, not
    // materialized into the editable Agent identity without a mounted Wiki.
    expect(context.systemPrompt).not.toContain("knowledge_search");
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

    expect(context.systemPrompt).toContain("COORDINATOR");
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
    expect(JSON.stringify(manifest)).not.toContain("question answering agent");
  });
});
