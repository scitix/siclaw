import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compileAgentContext } from "./agent-context.js";
import type { AgentType } from "./agent-types.js";
import { createPromptInspection } from "./prompt-inspection.js";
import { CAPABILITY_GROUPS } from "./tool-capabilities.js";
import { buildKnowledgeWikiCatalog } from "../memory/overview-generator.js";
import { createKnowledgeSearchTool } from "../tools/query/knowledge-search.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function visibleTools(names: readonly string[]): unknown[] {
  const ordinary = names.map((name) => ({
    name,
    description: `${name} model-visible test contract`,
    toolset: "test",
    parameters: { type: "object", properties: {} },
  }));
  const knowledgeSearch = createKnowledgeSearchTool({
    lookup: async () => ({
      status: "unavailable",
      wikiRoot: ".siclaw/knowledge",
      indexPath: ".siclaw/knowledge/index.md",
      results: [],
    }),
  } as any);
  return ordinary.map((tool) => tool.name === "knowledge_search" ? knowledgeSearch : tool);
}

function wikiRuntimeContext(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-prompt-inspection-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "index.md"), "- [Catcher](catcher.md): Server configuration collector\n");
  return `\n\n${buildKnowledgeWikiCatalog(dir, { operational: false })}`;
}

describe("createPromptInspection", () => {
  for (const agentType of ["sre", "coordinator", "knowledge_qa", "custom"] as const satisfies readonly AgentType[]) {
    it(`exposes the exact ${agentType} prompt, layers, actual tools, and design verdict`, () => {
      const context = compileAgentContext({
        agentType,
        allowedTools: null,
        memoryConfigured: false,
        mode: "web",
        agentPrompt: agentType === "custom" ? "Answer hardware inventory questions." : "Prefer concise Chinese answers.",
      });
      const runtimeContext = agentType === "knowledge_qa" ? wikiRuntimeContext() : "";
      const effectivePrompt = `${context.systemPrompt}${runtimeContext}`;
      const toolNames = context.harness.allowedTools ?? [...new Set(Object.values(CAPABILITY_GROUPS).flat())];
      const tools = visibleTools(toolNames);
      const inspection = createPromptInspection({
        context,
        mode: "web",
        effectivePrompt,
        stage: "session_ready",
        tools,
        skillNames: ["z-skill", "a-skill", "z-skill"],
      });

      expect(inspection.prompt.text).toBe(effectivePrompt);
      expect(inspection.prompt.chars).toBe(effectivePrompt.length);
      expect(inspection.prompt.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(inspection.skills).toEqual(["a-skill", "z-skill"]);
      expect(inspection.tools.map((tool) => tool.name)).toEqual(
        [...toolNames].sort(),
      );
      expect(inspection.layers.some((layer) => layer.id === "agent_type.contract"))
        .toBe(agentType !== "custom");
      expect(inspection.layers.some((layer) => layer.id === "agent.addendum")).toBe(true);
      expect(inspection.layers.some((layer) => layer.id === "runtime.composed_context"))
        .toBe(agentType === "knowledge_qa");
      expect(inspection.design.checks.find((check) => check.id === "completion_semantics")?.status)
        .toBe("pass");
      expect(inspection.design.checks.find((check) => check.id === "prompt_tool_alignment")?.status)
        .toBe("pass");
      if (agentType === "knowledge_qa") {
        // A mandatory knowledge_search tool contract is a real design
        // violation. The inspection must expose it until the retrieval layer
        // advertises search as an optional accelerator.
        expect(inspection.design.checks.find((check) => check.id === "retrieval_below_reasoning")?.status)
          .toBe("fail");
        expect(inspection.design.verdict).toBe("fail");
      } else {
        expect(inspection.design.verdict).toBe("pass");
      }
    });
  }

  for (const agentType of ["sre", "coordinator", "knowledge_qa", "custom"] as const satisfies readonly AgentType[]) {
    it(`keeps automated-task instructions aligned with the ${agentType} tool surface`, () => {
      const context = compileAgentContext({
        agentType,
        allowedTools: null,
        memoryConfigured: false,
        mode: "task",
      });
      const toolNames = context.harness.allowedTools ?? [...new Set(Object.values(CAPABILITY_GROUPS).flat())];
      const inspection = createPromptInspection({
        context,
        mode: "task",
        effectivePrompt: context.systemPrompt,
        stage: "session_ready",
        tools: visibleTools(toolNames),
        skillNames: [],
      });

      expect(toolNames).toContain("task_report");
      expect(inspection.prompt.text).toContain("# Automated Task Mode");
      expect(inspection.design.checks.find((check) => check.id === "prompt_tool_alignment")?.status)
        .toBe("pass");
    });
  }

  it("shows a provider replacement as a separate effective-prompt layer", () => {
    const context = compileAgentContext({
      agentType: "coordinator",
      allowedTools: null,
      memoryConfigured: false,
      mode: "web",
    });
    const inspection = createPromptInspection({
      context,
      mode: "web",
      effectivePrompt: "provider transformed prompt",
      stage: "provider_wire",
      tools: visibleTools(context.harness.allowedTools ?? []),
      skillNames: [],
    });

    expect(inspection.layers.at(-1)?.id).toBe("provider.effective_prompt");
    expect(inspection.stage).toBe("provider_wire");
    expect(inspection.design.verdict).toBe("fail");
  });
});
