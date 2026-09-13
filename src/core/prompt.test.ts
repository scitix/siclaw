import { afterEach, describe, expect, it } from "vitest";
import { buildSystemPrompt, renderSystemPromptFragment } from "./prompt.js";

import { compileAgentContext } from "./agent-context.js";
import { isMemoryEnabled } from "./config.js";
import type { SessionMode } from "./types.js";

function compileSrePrompt(mode: SessionMode, template?: string, addendum?: string): string {
  return compileAgentContext({
    mode, agentType: "sre", allowedTools: null, memoryConfigured: isMemoryEnabled(),
    systemPromptTemplate: template, agentPrompt: addendum,
  }).systemPrompt;
}

const ORIGINAL_MEMORY_ENABLED = process.env.SICLAW_MEMORY_ENABLED;

afterEach(() => {
  if (ORIGINAL_MEMORY_ENABLED === undefined) {
    delete process.env.SICLAW_MEMORY_ENABLED;
  } else {
    process.env.SICLAW_MEMORY_ENABLED = ORIGINAL_MEMORY_ENABLED;
  }
});

describe("compileSrePrompt memory flag", () => {
  it("keeps bundled memory instructions when memory is enabled", () => {
    process.env.SICLAW_MEMORY_ENABLED = "true";

    const prompt = compileSrePrompt("web");

    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("memory_get");
    expect(prompt).toContain("remember context from previous sessions");
    expect(prompt).toContain("# Runtime");
    expect(prompt).not.toContain("{{memoryIntro}}");
    expect(prompt).not.toContain("{{memorySection}}");
  });

  it("removes bundled memory instructions when memory is disabled", () => {
    process.env.SICLAW_MEMORY_ENABLED = "false";

    const prompt = compileSrePrompt("web");

    expect(prompt).not.toContain("memory_search");
    expect(prompt).not.toContain("memory_get");
    expect(prompt).not.toContain("remember context from previous sessions");
    expect(prompt).toContain("# Runtime");
    expect(prompt).not.toContain("{{memoryIntro}}");
    expect(prompt).not.toContain("{{memorySection}}");
  });

  it("defaults to memory disabled when the env is unset (opt-in only)", () => {
    delete process.env.SICLAW_MEMORY_ENABLED;

    const prompt = compileSrePrompt("web");

    expect(prompt).not.toContain("memory_search");
    expect(prompt).not.toContain("remember context from previous sessions");
  });
});

describe("compileSrePrompt output guidance", () => {
  it("does not spend the shared Web prompt on renderer-specific syntax", () => {
    const prompt = compileSrePrompt("web");

    expect(prompt).not.toContain("flowchart");
    expect(prompt).not.toContain("sequenceDiagram");
    expect(prompt).not.toContain("xychart-beta");
    expect(prompt).toContain("Use plain prose by default");
  });

  it("does not steer shared Siclaw surfaces to unsupported visual-card output", () => {
    const prompt = compileSrePrompt("web");

    expect(prompt).not.toContain("```siclaw-card");
    expect(prompt).not.toContain("```visual-card");
    expect(prompt).not.toContain('type: "report"');
    expect(prompt).not.toContain("final_report");
    expect(prompt).not.toContain("health_check");
    expect(prompt).not.toContain("incident_timeline");
    expect(prompt).not.toContain("root_cause_chain");
    expect(prompt).not.toContain("metric_snapshot");
    expect(prompt).not.toContain("status_distribution");
    expect(prompt).not.toContain("action_plan");
    expect(prompt).not.toContain("Mermaid for diagrams");
    expect(prompt).not.toContain("render_chart");
  });

  it("adds channel-only guidance for natural-language answers with optional visuals", () => {
    const prompt = compileSrePrompt("channel");

    expect(prompt).toContain("# Channel Reply Format");
    expect(prompt).toContain("render_mermaid");
    expect(prompt).toContain("render_chart");
    expect(prompt).not.toContain("render_visual_card");
    expect(prompt).not.toContain("```visual-card");
    expect(prompt).not.toContain("```siclaw-card");
    expect(prompt).toContain("structured image content blocks");
    expect(prompt).toContain("Visuals are optional supporting material, never the answer container");
    expect(prompt).toContain("do not paste renderer source, metadata, or tool output");
    expect(prompt).toContain("If visual rendering fails, continue with the complete natural-language answer");
    expect(prompt).toContain("Do not inline `data:image/...");
    expect(prompt).toContain("forwards structured image artifacts");
    expect(prompt).toContain("channel adapter");
    expect(prompt).toContain("Use normal Markdown for direct answers");
    expect(prompt).toContain("Treat the latest channel message as the current request");
    expect(prompt).toContain("Do not force details from a previous incident into the new answer");
    expect(prompt).not.toContain("may render a fallback image");
    expect(prompt).not.toContain("readable fallback source");
  });
});

describe("buildSystemPrompt safety composition", () => {
  const neutralInput = {
    mode: "web" as const,
    memoryEnabled: false,
    includeInfrastructureGuidance: false,
    includeOperationalSafety: false,
    includeSkillAuthoring: false,
    includePlanningGuidance: false,
    includeSubagentGuidance: false,
  };

  it("always includes domain-neutral safety for state-changing tools", () => {
    const prompt = buildSystemPrompt(neutralInput);

    expect(prompt).toContain("change external state only when the user explicitly asks");
    expect(prompt).toContain("target, impact, and blast radius");
    expect(prompt).toContain("explicit confirmation");
    expect(prompt).not.toContain("delete/evict/cordon");
  });

  it("requires a terminal answer instead of allowing progress-only stops", () => {
    const prompt = buildSystemPrompt(neutralInput);

    expect(prompt).toContain("A progress update is not a completed turn");
    expect(prompt).toContain("The final response must stand on its own");
    expect(prompt).not.toContain("A turn can be just a short update");
  });

  it("adds infrastructure-specific operational safety only when compiled for that harness", () => {
    const neutral = buildSystemPrompt(neutralInput);
    const operational = buildSystemPrompt({ ...neutralInput, includeOperationalSafety: true });

    expect(neutral).not.toContain("delete/evict/cordon");
    expect(operational).toContain("delete/evict/cordon");
  });
});

describe("renderSystemPromptFragment", () => {
  it("preserves variables and Web blocks while discarding obsolete terminal instructions", () => {
    process.env.SICLAW_MEMORY_ENABLED = "false";
    const fragment = [
      "mode={{mode}} settings={{settingsPath}} credentials={{credentialsPath}}",
      "<!-- web-only -->web instruction<!-- /web-only -->",
      "<!-- cli-only -->cli instruction<!-- /cli-only -->",
      "{{memoryIntro}}{{memorySection}}",
    ].join("\n");

    const web = renderSystemPromptFragment(fragment, "web");
    expect(web).toContain("mode=Web UI");
    expect(web).toContain("sidebar **Settings**");
    expect(web).toContain("web instruction");
    expect(web).not.toContain("cli instruction");
    expect(web).not.toContain("{{");

    const cli = renderSystemPromptFragment(fragment, "cli");
    expect(cli).toContain("mode=headless CLI");
    expect(cli).toContain("`siclaw local`");
    expect(cli).not.toContain("cli instruction");
    expect(cli).not.toContain("web instruction");
    expect(cli).not.toContain("<!--");
  });

  it("renders the agent fragment before non-overridable platform safety", () => {
    process.env.SICLAW_MEMORY_ENABLED = "false";
    const fragment = [
      "agent mode={{mode}}",
      "<!-- cli-only -->CLI identity<!-- /cli-only -->",
      "<!-- web-only -->Web identity<!-- /web-only -->",
    ].join("\n");

    const prompt = compileSrePrompt("cli", undefined, fragment);

    expect(prompt).toContain("agent mode=headless CLI");
    expect(prompt).not.toContain("CLI identity");
    expect(prompt).not.toContain("Web identity");
    expect(prompt.indexOf("agent mode=headless CLI")).toBeLessThan(prompt.indexOf("# Safety"));
  });
});


it("retains the web progress contract after custom and legacy prompts", () => {
  const prompt = compileSrePrompt("web", "Legacy instructions.", "Brief answers.");
  expect(prompt).toContain("# Web Conversation Progress");
  expect(prompt.indexOf("# Web Conversation Progress")).toBeGreaterThan(prompt.indexOf("Legacy instructions."));
  expect(prompt).not.toContain("_siclaw_progress");
  expect(prompt).toContain("ordinary assistant text");
  expect(compileSrePrompt("task")).not.toContain("# Web Conversation Progress");
  expect(compileSrePrompt("cli")).not.toContain("# Web Conversation Progress");
});


describe("prompt after terminal UI removal", () => {
  it.each(["web", "channel", "cli", "task"] as const)
    ("never revives a persisted terminal-only branch in %s mode", (mode) => {
      const prompt = compileSrePrompt(mode, undefined,
        "Shared instructions.<!-- cli-only -->Use /setup and copy from the terminal.<!-- /cli-only -->");
      expect(prompt).toContain("Shared instructions.");
      expect(prompt).not.toContain("/setup");
      expect(prompt).not.toContain("copy from the terminal");
      expect(prompt).not.toContain("<!--");
      expect(prompt).toContain("# Safety");
      expect(prompt).toContain("explicit confirmation");
    });

  it.each(["web", "channel"] as const)("preserves skill preview in %s", (mode) => {
    expect(compileSrePrompt(mode)).toContain("MUST output the result via `skill_preview`");
  });

  it.each(["cli", "task"] as const)("does not request unavailable interactive workflows in %s", (mode) => {
    const prompt = compileSrePrompt(mode);
    expect(prompt).not.toContain("# Skill Authoring");
    expect(prompt).not.toContain("skill_preview");
    expect(prompt).not.toContain("sub-agent batch");
    expect(prompt).not.toContain("# Multi-step Work & Sub-agents");
    expect(prompt).not.toContain("spawn_subagent");
    expect(prompt).toContain("cluster_list");
    expect(prompt).toContain("task_create");
    if (mode === "cli") {
      expect(prompt).toContain("No user is present to answer follow-up questions");
      expect(prompt).not.toContain("task_report");
    } else {
      expect(prompt).toContain("task_report");
    }
  });

  it("uses the same default mode as the shared session factory", () => {
    expect(renderSystemPromptFragment("{{mode}} {{settingsPath}}"))
      .toBe("Web UI sidebar **Settings**");
  });
});
