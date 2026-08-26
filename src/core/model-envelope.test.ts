import { describe, expect, it } from "vitest";

import { inspectModelEnvelope } from "./model-envelope.js";

describe("inspectModelEnvelope", () => {
  it("observes Chat Completions system/developer messages and function tools", () => {
    const manifest = inspectModelEnvelope({
      messages: [
        { role: "system", content: "platform" },
        { role: "developer", content: [{ type: "text", text: "type policy" }] },
        { role: "user", content: "private question" },
      ],
      tools: [
        { type: "function", function: { name: "read" } },
        { type: "function", function: { name: "knowledge_cite" } },
      ],
    });

    expect(manifest.system.chars).toBe("platform\n\ntype policy".length);
    expect(manifest.tools.names).toEqual(["knowledge_cite", "read"]);
    expect(manifest.tools.schemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.markers.infrastructureGuidance).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain("private question");
  });

  it("observes Anthropic system blocks and direct tool names", () => {
    const manifest = inspectModelEnvelope({
      system: [{ type: "text", text: "compiled prompt" }],
      tools: [{ name: "read" }],
    });
    expect(manifest.system.chars).toBe("compiled prompt".length);
    expect(manifest.tools.names).toEqual(["read"]);
  });

  it("observes Responses instructions without retaining their text", () => {
    const manifest = inspectModelEnvelope({ instructions: "secret system text", tools: [] });
    expect(manifest.system.chars).toBe("secret system text".length);
    expect(manifest.system.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain("secret system text");
  });

  it("attests known SRE sections in the final wire prompt without logging their text", () => {
    const manifest = inspectModelEnvelope({
      system: [
        "You are a specialist SRE agent.",
        "# Infrastructure Access",
        "# Operational Safety",
        "# Memory — Search On Demand",
        "Start by making a plan with `task_create` is your FIRST move.",
        "For parallel work, make **one `spawn_subagent` call.",
      ].join("\n\n"),
    });

    expect(manifest.markers).toEqual({
      sreIdentity: true,
      infrastructureGuidance: true,
      operationalSafety: true,
      memoryGuidance: true,
      planningGuidance: true,
      subagentGuidance: true,
    });
  });
});
