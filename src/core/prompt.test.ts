import { afterEach, describe, expect, it } from "vitest";
import { buildSreSystemPrompt } from "./prompt.js";

const ORIGINAL_MEMORY_ENABLED = process.env.SICLAW_MEMORY_ENABLED;

afterEach(() => {
  if (ORIGINAL_MEMORY_ENABLED === undefined) {
    delete process.env.SICLAW_MEMORY_ENABLED;
  } else {
    process.env.SICLAW_MEMORY_ENABLED = ORIGINAL_MEMORY_ENABLED;
  }
});

describe("buildSreSystemPrompt memory flag", () => {
  it("keeps bundled memory instructions when memory is enabled", () => {
    process.env.SICLAW_MEMORY_ENABLED = "true";

    const prompt = buildSreSystemPrompt("web");

    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("memory_get");
    expect(prompt).toContain("remember context from previous sessions");
    expect(prompt).toContain("# Environment & Configuration");
    expect(prompt).not.toContain("{{memoryIntro}}");
    expect(prompt).not.toContain("{{memorySection}}");
  });

  it("removes bundled memory instructions when memory is disabled", () => {
    process.env.SICLAW_MEMORY_ENABLED = "false";

    const prompt = buildSreSystemPrompt("web");

    expect(prompt).not.toContain("memory_search");
    expect(prompt).not.toContain("memory_get");
    expect(prompt).not.toContain("remember context from previous sessions");
    expect(prompt).toContain("# Environment & Configuration");
    expect(prompt).not.toContain("{{memoryIntro}}");
    expect(prompt).not.toContain("{{memorySection}}");
  });

  it("defaults to memory disabled when the env is unset (opt-in only)", () => {
    delete process.env.SICLAW_MEMORY_ENABLED;

    const prompt = buildSreSystemPrompt("web");

    expect(prompt).not.toContain("memory_search");
    expect(prompt).not.toContain("remember context from previous sessions");
  });
});

describe("buildSreSystemPrompt visual output guidance", () => {
  it("authorizes every Mermaid family supported by Sicore Web", () => {
    const prompt = buildSreSystemPrompt("web");

    expect(prompt).toContain("flowchart");
    expect(prompt).toContain("sequenceDiagram");
    expect(prompt).toContain("timeline");
    expect(prompt).toContain("xychart-beta");
  });

  it("does not steer shared Siclaw surfaces to unsupported visual-card output", () => {
    const prompt = buildSreSystemPrompt("web");

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
    expect(prompt).toContain("Mermaid for diagrams");
    expect(prompt).toContain("chart");
  });

  it("adds channel-only guidance for visual Feishu replies and conclusion cards", () => {
    const prompt = buildSreSystemPrompt("channel");

    expect(prompt).toContain("# Channel Reply Format");
    expect(prompt).toContain("render_mermaid");
    expect(prompt).toContain("render_visual_card");
    expect(prompt).toContain("```visual-card");
    expect(prompt).not.toContain("```siclaw-card");
    expect(prompt).toContain("structured image content blocks");
    expect(prompt).toContain("Do not inline `data:image/...");
    expect(prompt).toContain("forwards structured image artifacts");
    expect(prompt).toContain("channel adapter");
    expect(prompt).toContain("Source-only ```chart`, Mermaid, and ```visual-card` blocks remain markdown text");
    expect(prompt).toContain("Use normal Markdown for direct answers");
    expect(prompt).toContain("Treat the latest channel message as the current request");
    expect(prompt).toContain("Do not force details from a previous incident into the new answer");
    expect(prompt).not.toContain("may render a fallback image");
    expect(prompt).not.toContain("readable fallback source");
  });
});
